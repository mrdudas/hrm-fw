/*
 * HRM Belt (Magene OEM, nRF52805) — custom firmware
 *
 * Two capabilities in one image:
 *   1. Standard Heart Rate Service (0x180D) with the TRUE beat-to-beat RR
 *      interval (1/1024 s) — real HRV, not the stock floor(60000/HR) fake.
 *   2. A raw-ECG streaming service (custom 128-bit UUID) that notifies the
 *      unfiltered ADC waveform in batches — always available on demand.
 *
 * Signal path: electrodes -> RS8034 op-amp -> nRF52805 P0.05/AIN3 (ball F6).
 *
 * Detector: 50 Hz notch + 8-22 Hz Butterworth band-pass (QRS band) followed by
 * an energy-envelope adaptive threshold with a refractory gate. Coefficients are
 * designed for fs = SAMPLE_HZ; the band-pass rejects both the T-wave (<8 Hz) and
 * mains hum, so no double-counting. (nRF52805 has no FPU, but a few biquads at
 * 250 Hz in software float is trivial.)
 */
#include <zephyr/kernel.h>
#include <zephyr/drivers/adc.h>
#include <zephyr/sys/util.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/poweroff.h>
#include <zephyr/logging/log.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/bluetooth/gatt.h>
#include <zephyr/bluetooth/services/bas.h>
#include <hal/nrf_gpio.h>

LOG_MODULE_REGISTER(hrm, LOG_LEVEL_INF);

/* ---- Tunables (filters are fs-specific: designed for 250 Hz) ---------- */
#define SAMPLE_HZ      250
#define REFRACTORY_MS  300            /* min beat gap (~200 bpm max)          */
#define RR_MIN_MS      300
#define RR_MAX_MS      2000
#define ENV_DECAY      0.9960f        /* energy envelope decay per sample     */
#define THRESH_FRAC    0.35f          /* threshold = fraction of envelope     */
#define WARMUP_SAMPLES (SAMPLE_HZ * 2)/* let IIR filters settle (~2 s)        */
#define RAW_BATCH      20             /* raw samples per BLE notification      */
#define TWAVE_MS       360            /* T-wave window after a QRS (Pan-Tompkins) */
#define TWAVE_FRAC     0.5f           /* peak in that window below this*QRS energy = T-wave */
#define SNR_GATE       8.0f           /* classify ectopy only when spki > this*npki (clean signal) */
#define RAIL_LO        100            /* raw ADC near the bottom rail = contact artifact */
#define RAIL_HI        3995           /* raw ADC near the top rail (12-bit, 0..4095)      */
#define RAIL_WIN       25             /* samples (~100 ms) a rail flag persists           */
#define MOTION_FRAC    5.0f           /* energy > this*normal QRS = contact spike (real PVC is ~2-3x) */
#define TWAVE_LO_FRAC  0.4f           /* energy < this*normal QRS = T-wave/low (drop)      */

/* Power / status LED */
#define LED_PIN        4                  /* P0.04, active-high status LED     */
#define OFFBODY_MS     60000              /* no beat this long -> deep sleep    */
#define MAX_ACTIVE_MS  (3LL*60*60*1000)   /* 3 h max session -> deep sleep      */
#define LED_PULSE_N    3                  /* ~12 ms LED pulse per beat (energy-saving) */

/* 50 Hz notch (biquad) @250 Hz */
static const float NOTCH_b[] = {0.97948276f, -0.60535364f, 0.97948276f};
static const float NOTCH_a[] = {1.00000000f, -0.60535364f, 0.95896552f};
/* 8-22 Hz band-pass (Butterworth order 2 -> 4th order section) @250 Hz */
static const float BP_b[] = {0.02463061f, 0.0f, -0.04926122f, 0.0f, 0.02463061f};
static const float BP_a[] = {1.0f, -3.31428620f, 4.28994755f, -2.57411291f, 0.60810569f};

/* ---- ADC (AIN3 = P0.05 = ball F6) ------------------------------------ */
static const struct adc_dt_spec adc_ch =
	ADC_DT_SPEC_GET_BY_IDX(DT_PATH(zephyr_user), 0);
static int16_t adc_raw;
static struct adc_sequence adc_seq = {
	.buffer = &adc_raw, .buffer_size = sizeof(adc_raw),
};

/* VDD channel for the Battery Service */
static const struct adc_dt_spec adc_vdd =
	ADC_DT_SPEC_GET_BY_IDX(DT_PATH(zephyr_user), 1);
static int16_t vdd_raw;
static struct adc_sequence vdd_seq = {
	.buffer = &vdd_raw, .buffer_size = sizeof(vdd_raw),
};

/* Read VDD, map a CR2032 (~2.4 V empty .. 3.0 V full) to % and publish via BAS. */
static void battery_update(void)
{
	if (adc_read_dt(&adc_vdd, &vdd_seq) != 0) {
		return;
	}
	int32_t mv = vdd_raw;
	if (adc_raw_to_millivolts_dt(&adc_vdd, &mv) != 0) {
		return;
	}
	int32_t pct = (mv - 2400) * 100 / 600;
	pct = CLAMP(pct, 0, 100);
	bt_bas_set_battery_level((uint8_t)pct);
}

/* ---- Heart Rate Service (real RR) ------------------------------------ */
static uint8_t hrm_ccc;
static uint8_t body_loc = 0x01;   /* chest */

static void hrm_ccc_changed(const struct bt_gatt_attr *a, uint16_t v) { hrm_ccc = (v == BT_GATT_CCC_NOTIFY); }
static ssize_t read_bsl(struct bt_conn *c, const struct bt_gatt_attr *a, void *buf, uint16_t len, uint16_t off)
{
	return bt_gatt_attr_read(c, a, buf, len, off, &body_loc, sizeof(body_loc));
}

BT_GATT_SERVICE_DEFINE(hrm_svc,
	BT_GATT_PRIMARY_SERVICE(BT_UUID_HRS),
	BT_GATT_CHARACTERISTIC(BT_UUID_HRS_MEASUREMENT, BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_NONE, NULL, NULL, NULL),
	BT_GATT_CCC(hrm_ccc_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
	BT_GATT_CHARACTERISTIC(BT_UUID_HRS_BODY_SENSOR, BT_GATT_CHRC_READ,
			       BT_GATT_PERM_READ, read_bsl, NULL, NULL),
);

static void hrm_notify(uint8_t hr, uint16_t rr_1024)
{
	uint8_t buf[4] = { BIT(1) | BIT(2) | BIT(4), hr, 0, 0 };  /* contact + RR present */
	sys_put_le16(rr_1024, &buf[2]);
	if (hrm_ccc) {
		bt_gatt_notify(NULL, &hrm_svc.attrs[2], buf, sizeof(buf));
	}
}

/* ---- Raw-ECG streaming service (custom) ------------------------------ */
#define CAP_SVC BT_UUID_128_ENCODE(0xa1b20001,0x0000,0x1000,0x8000,0x00805f9b34fb)
#define CAP_CHR BT_UUID_128_ENCODE(0xa1b20002,0x0000,0x1000,0x8000,0x00805f9b34fb)
static struct bt_uuid_128 cap_svc_uuid = BT_UUID_INIT_128(CAP_SVC);
static struct bt_uuid_128 cap_chr_uuid = BT_UUID_INIT_128(CAP_CHR);
static uint8_t cap_ccc;
static void cap_ccc_changed(const struct bt_gatt_attr *a, uint16_t v) { cap_ccc = (v == BT_GATT_CCC_NOTIFY); }

BT_GATT_SERVICE_DEFINE(cap_svc,
	BT_GATT_PRIMARY_SERVICE(&cap_svc_uuid),
	BT_GATT_CHARACTERISTIC(&cap_chr_uuid.uuid, BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_NONE, NULL, NULL, NULL),
	BT_GATT_CCC(cap_ccc_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
);

/* ---- Accelerometer data service: raw X/Y/Z (int16) + step count (u16) ---- */
#define ACCS_SVC BT_UUID_128_ENCODE(0xa1b30001,0x0000,0x1000,0x8000,0x00805f9b34fb)
#define ACCS_CHR BT_UUID_128_ENCODE(0xa1b30002,0x0000,0x1000,0x8000,0x00805f9b34fb)
static struct bt_uuid_128 accs_svc_uuid = BT_UUID_INIT_128(ACCS_SVC);
static struct bt_uuid_128 accs_chr_uuid = BT_UUID_INIT_128(ACCS_CHR);
static uint8_t accs_ccc;
static void accs_ccc_changed(const struct bt_gatt_attr *a, uint16_t v) { accs_ccc = (v == BT_GATT_CCC_NOTIFY); }
BT_GATT_SERVICE_DEFINE(accs_svc,
	BT_GATT_PRIMARY_SERVICE(&accs_svc_uuid),
	BT_GATT_CHARACTERISTIC(&accs_chr_uuid.uuid, BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_NONE, NULL, NULL, NULL),
	BT_GATT_CCC(accs_ccc_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
);

/* ---- Ectopy (extrasystole) service (custom) --------------------------
 * Classifies each premature beat using timing + QRS energy (morphology).
 * Does NOT touch the Heart Rate Service or the detection flow: the standard
 * HR/RR stream stays exactly as the validated step1 build; only this extra
 * characteristic carries the classification, so a bug here can't corrupt HR.
 *   type 1 = PVC-like   (premature, normal/high QRS energy, ~full compensatory pause)
 *   type 2 = PAC-like   (premature, normal/high QRS energy, reset/short pause)
 *   type 3 = ARTIFACT   (premature but LOW QRS energy -> HRV should drop it)
 * Value (LE, 14 B): u8 type, u8 flags, u16 coupling_ms, u16 pause_ms,
 *   u16 pvc_count, u16 pac_count, u16 artifact_count, u16 total_beats. read+notify. */
#define ECT_SVC BT_UUID_128_ENCODE(0xa1b40001,0x0000,0x1000,0x8000,0x00805f9b34fb)
#define ECT_CHR BT_UUID_128_ENCODE(0xa1b40002,0x0000,0x1000,0x8000,0x00805f9b34fb)
static struct bt_uuid_128 ect_svc_uuid = BT_UUID_INIT_128(ECT_SVC);
static struct bt_uuid_128 ect_chr_uuid = BT_UUID_INIT_128(ECT_CHR);
static uint8_t  ect_ccc;
static uint8_t  ect_buf[14];
static uint16_t pvc_count, pac_count, artifact_count, beat_total;
static void ect_ccc_changed(const struct bt_gatt_attr *a, uint16_t v) { ect_ccc = (v == BT_GATT_CCC_NOTIFY); }
static ssize_t read_ect(struct bt_conn *c, const struct bt_gatt_attr *a, void *buf, uint16_t len, uint16_t off)
{
	return bt_gatt_attr_read(c, a, buf, len, off, ect_buf, sizeof(ect_buf));
}
BT_GATT_SERVICE_DEFINE(ect_svc,
	BT_GATT_PRIMARY_SERVICE(&ect_svc_uuid),
	BT_GATT_CHARACTERISTIC(&ect_chr_uuid.uuid, BT_GATT_CHRC_NOTIFY | BT_GATT_CHRC_READ,
			       BT_GATT_PERM_READ, read_ect, NULL, NULL),
	BT_GATT_CCC(ect_ccc_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
);
static void ect_stats_to_buf(void)
{
	sys_put_le16(pvc_count,      &ect_buf[6]);
	sys_put_le16(pac_count,      &ect_buf[8]);
	sys_put_le16(artifact_count, &ect_buf[10]);
	sys_put_le16(beat_total,     &ect_buf[12]);
}
static void ect_notify(uint8_t type, uint16_t coupling_ms, uint16_t pause_ms)
{
	ect_buf[0] = type; ect_buf[1] = 0;
	sys_put_le16(coupling_ms, &ect_buf[2]);
	sys_put_le16(pause_ms,    &ect_buf[4]);
	ect_stats_to_buf();
	if (ect_ccc) bt_gatt_notify(NULL, &ect_svc.attrs[2], ect_buf, sizeof(ect_buf));
}

/* ---- Advertising ----------------------------------------------------- */
static const struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA_BYTES(BT_DATA_UUID16_ALL, BT_UUID_16_ENCODE(BT_UUID_HRS_VAL)),
	BT_DATA(BT_DATA_NAME_COMPLETE, CONFIG_BT_DEVICE_NAME, sizeof(CONFIG_BT_DEVICE_NAME) - 1),
};
static void adv_work_fn(struct k_work *w)
{
	int e = bt_le_adv_start(BT_LE_ADV_CONN_FAST_1, ad, ARRAY_SIZE(ad), NULL, 0);
	LOG_INF("advertising %s", e ? "FAILED" : "started");
}
static K_WORK_DEFINE(adv_work, adv_work_fn);
static void connected(struct bt_conn *c, uint8_t err) { if (!err) k_work_submit(&adv_work); }  /* keep advertising for a 2nd host */
static void disconnected(struct bt_conn *c, uint8_t r) { k_work_submit(&adv_work); }
BT_CONN_CB_DEFINE(conn_cb) = { .connected = connected, .disconnected = disconnected };
static void bt_ready(int e) { if (!e) k_work_submit(&adv_work); }

/* ---- Power / status LED --------------------------------------------- */
static uint32_t cyc_per_sec;
static volatile int64_t  last_beat_ms;
static volatile uint32_t sample_idx, led_off_idx;

static inline void led_on(void)  { nrf_gpio_pin_set(LED_PIN); }
static inline void led_off(void) { nrf_gpio_pin_clear(LED_PIN); }

/* Direct Form II transposed IIR; n = tap count (order+1), z sized n-1 */
static float iir(const float *b, const float *a, float *z, int n, float x)
{
	float y = b[0] * x + z[0];
	for (int i = 1; i < n - 1; i++) {
		z[i - 1] = b[i] * x + z[i] - a[i] * y;
	}
	z[n - 2] = b[n - 1] * x - a[n - 1] * y;
	return y;
}

static uint8_t hr_from_rr(uint16_t rr_ms)
{
	static uint16_t h[4]; static uint8_t idx, cnt;
	h[idx] = rr_ms; idx = (idx + 1) & 3;   /* ring index always cycles 0..3 */
	if (cnt < 4) cnt++;                     /* separate count, saturates at 4 */
	uint32_t s = 0;
	for (int i = 0; i < cnt; i++) s += h[i];
	uint16_t avg = s / cnt;
	return (avg >= RR_MIN_MS) ? (uint8_t)(60000U / avg) : 0;
}

/* Pan-Tompkins-style adaptive QRS detector on the band-passed energy signal.
 * Instead of a single decaying peak-envelope (which one motion spike could pin
 * high for ~1 s, hiding the next real beats -> HR reads ~half at high rates),
 * we keep separate running estimates of the SIGNAL peak (SPKI) and NOISE peak
 * (NPKI). A spike moves each by only 12.5 %, so it can't poison the threshold.
 * Search-back lowers the bar if we've waited longer than 1.66x the average RR. */
static void detector_feed(int16_t sample)
{
	static float notch_z[2], bp_z[4];
	static float spki, npki;            /* running signal / noise peak estimates */
	static float prev_energy, cand_peak;/* local-maximum tracking                */
	static float last_qrs_peak;         /* energy of the last accepted QRS       */
	static bool  rising;
	static uint32_t last_cyc, rr_avg_cyc, warm;
	static bool  have_last;
	/* extrasystole classification (1-beat look-ahead; only feeds the ectopy
	 * characteristic, never the HR/RR stream) */
	static uint32_t sinus_rr_ms, pend_coupling;
	static float    pend_energy, sinus_qrs;
	static uint32_t rail_recent;        /* >0 = raw ADC railed within the last RAIL_WIN samples */
	static bool     pend_prem, pend_railed;

	float yn = iir(NOTCH_b, NOTCH_a, notch_z, 3, (float)sample);
	float yb = iir(BP_b, BP_a, bp_z, 5, yn);
	float energy = yb * yb;

	if (warm < WARMUP_SAMPLES) { warm++; prev_energy = energy; return; }

	/* rail/saturation tracking: a contact (electrode-skin) artifact drives the raw
	 * ADC to the rails; a real QRS never does. Flag persists for RAIL_WIN samples. */
	if (sample < RAIL_LO || sample > RAIL_HI) rail_recent = RAIL_WIN;
	else if (rail_recent) rail_recent--;

	uint32_t now  = k_cycle_get_32();
	uint32_t refr = (uint64_t)cyc_per_sec * REFRACTORY_MS / 1000;

	/* adaptive threshold; relax toward NPKI (search-back) if a beat is overdue */
	float k = 0.25f;
	if (have_last && rr_avg_cyc && (now - last_cyc) > (uint64_t)rr_avg_cyc * 166 / 100) {
		k = 0.125f;
	}
	float thresh = npki + k * (spki - npki);

	/* detect the local maximum of the energy signal (rise then fall) */
	if (energy > prev_energy) {
		rising = true;
		if (energy > cand_peak) cand_peak = energy;
	} else if (rising && energy < prev_energy) {
		rising = false;
		bool in_refr = have_last && (now - last_cyc) < refr;
		/* T-wave rejection: a peak soon after a QRS whose energy is well below the
		 * last QRS is the T-wave, not a beat. The band-pass already suppresses the
		 * T-wave, so its energy is a small fraction of a real QRS. Rejecting it also
		 * stops it from arming the refractory and masking the true next QRS. */
		uint32_t twin = (uint64_t)cyc_per_sec * TWAVE_MS / 1000;
		bool twave = have_last && (now - last_cyc) < twin &&
			     cand_peak < TWAVE_FRAC * last_qrs_peak;
		if (!in_refr && !twave && cand_peak > thresh && cand_peak > 50.0f /* noise floor */) {
			last_beat_ms = k_uptime_get();          /* on-body indicator */
			led_on(); led_off_idx = sample_idx + LED_PULSE_N;  /* heartbeat blink */
			if (have_last) {
				uint32_t d = now - last_cyc;
				uint32_t rr_ms = (uint64_t)d * 1000 / cyc_per_sec;
				if (rr_ms >= RR_MIN_MS && rr_ms <= RR_MAX_MS) {
					uint16_t rr_1024 = (uint16_t)((uint64_t)d * 1024 / cyc_per_sec);
					uint8_t hr = hr_from_rr(rr_ms);
					LOG_INF("beat RR=%u HR=%u", rr_ms, hr);
					hrm_notify(hr, rr_1024);
					rr_avg_cyc = rr_avg_cyc ? (rr_avg_cyc * 7 + d) / 8 : d;

					/* --- extrasystole classification (ectopy char only) ---
					 * 1-beat look-ahead: hold a premature beat until the next
					 * beat reveals its pause. Timing = premature + compensatory;
					 * QRS ENERGY separates a real ectopic (normal/high energy)
					 * from an artifact (low energy). Gated on a clean signal. */
					beat_total++;
					uint32_t mean = sinus_rr_ms ? sinus_rr_ms : rr_ms;
						float qref = sinus_qrs ? sinus_qrs : spki;
					bool cur_prem = sinus_rr_ms && rr_ms < (mean * 4) / 5;
					bool clean = spki > SNR_GATE * npki;
					bool used_pause = false;
					if (clean && pend_prem) {
						uint32_t sum = pend_coupling + rr_ms;
						uint8_t type;
						if (pend_railed || pend_energy > MOTION_FRAC * qref ||
							    pend_energy < TWAVE_LO_FRAC * qref) {
							type = 3; artifact_count++;
						} else if (sum >= (mean * 9) / 5) {
							type = 1; pvc_count++;
						} else {
							type = 2; pac_count++;
						}
						ect_notify(type, (uint16_t)pend_coupling, rr_ms);
						used_pause = true;
					}
					pend_prem = false;
					if (clean && cur_prem) {
						pend_prem = true;
						pend_coupling = rr_ms;
						pend_energy = cand_peak;
							pend_railed = (rail_recent > 0);
					} else if (!cur_prem && !used_pause) {
						sinus_rr_ms = sinus_rr_ms ?
							(sinus_rr_ms * 7 + rr_ms) / 8 : rr_ms;
						sinus_qrs = sinus_qrs ?
							(sinus_qrs * 7.0f + cand_peak) / 8.0f : cand_peak;
					}
					ect_stats_to_buf();
				}
			}
			last_cyc = now; have_last = true;
			last_qrs_peak = cand_peak;                  /* remember QRS energy for T-wave test */
			spki = 0.125f * cand_peak + 0.875f * spki;  /* signal peak update */
		} else if (!in_refr) {
			npki = 0.125f * cand_peak + 0.875f * npki;  /* noise peak update  */
		}
		cand_peak = 0.0f;
	}
	prev_energy = energy;
}

/* ---- Sampling loop --------------------------------------------------- */
static K_SEM_DEFINE(tick_sem, 0, 1);
static void tick(struct k_timer *t) { k_sem_give(&tick_sem); }
static K_TIMER_DEFINE(sample_timer, tick, NULL);

/* ---- SC7A20 accelerometer: motion-wake (I2C bit-bang, SCL=P0.16, SDA=P0.18,
 * addr 0x19). Its INT1 pin is wired to nRF P0.14 (active-high). We arm a motion
 * (any-axis high-g) latched interrupt, then sleep in System OFF and wake via the
 * P0.14 GPIO SENSE -> true ~µA deep sleep, movement wakes it. */
#define ACC_SCL 16
#define ACC_SDA 18
#define ACC_ADDR 0x19
#define ACC_INT_PIN 14
#define AD() k_busy_wait(6)
static inline void a_scl_hi(void){ nrf_gpio_cfg_input(ACC_SCL, NRF_GPIO_PIN_PULLUP); }
static inline void a_sda_hi(void){ nrf_gpio_cfg_input(ACC_SDA, NRF_GPIO_PIN_PULLUP); }
static inline void a_sda_lo(void){ nrf_gpio_pin_clear(ACC_SDA); nrf_gpio_cfg_output(ACC_SDA); }
static inline int  a_sda_rd(void){ return nrf_gpio_pin_read(ACC_SDA); }
static inline void a_scl_hic(void){ a_scl_hi(); }
static inline void a_scl_loc(void){ nrf_gpio_pin_clear(ACC_SCL); nrf_gpio_cfg_output(ACC_SCL); }
static void a_st(void){ a_sda_hi(); a_scl_hic(); AD(); a_sda_lo(); AD(); a_scl_loc(); AD(); }
static void a_sp(void){ a_sda_lo(); AD(); a_scl_hic(); AD(); a_sda_hi(); AD(); }
static int a_wrb(uint8_t b){ for(int i=0;i<8;i++){(b&0x80)?a_sda_hi():a_sda_lo();AD();a_scl_hic();AD();a_scl_loc();AD();b<<=1;} a_sda_hi();AD();a_scl_hic();AD();int k=(a_sda_rd()==0);a_scl_loc();AD();return k; }
static uint8_t a_rdb(int ack){ uint8_t v=0;a_sda_hi();for(int i=0;i<8;i++){v<<=1;a_scl_hic();AD();if(a_sda_rd())v|=1;a_scl_loc();AD();}ack?a_sda_lo():a_sda_hi();AD();a_scl_hic();AD();a_scl_loc();AD();a_sda_hi();return v; }
static void acc_wr(uint8_t r,uint8_t v){ a_st();a_wrb((ACC_ADDR<<1)|0);a_wrb(r);a_wrb(v);a_sp(); }
static uint8_t acc_rd(uint8_t r){ a_st();a_wrb((ACC_ADDR<<1)|0);a_wrb(r);a_st();a_wrb((ACC_ADDR<<1)|1);uint8_t v=a_rdb(0);a_sp();return v; }

static void accel_init_motion_int(void)
{
	a_scl_hi(); a_sda_hi(); k_msleep(5);
	acc_wr(0x20, 0x57);   /* CTRL1: 100Hz, XYZ on */
	acc_wr(0x21, 0x01);   /* CTRL2: HPIS1 = high-pass filter on INT1 (removes gravity!) */
	acc_wr(0x23, 0x08);   /* CTRL4: HR, +/-2g */
	acc_wr(0x22, 0x40);   /* CTRL3: I1_IA1 -> INT1 pin */
	acc_wr(0x24, 0x08);   /* CTRL5: latch INT1 */
	acc_wr(0x32, 0x12);   /* INT1_THS: motion threshold (~290 mg dynamic) */
	acc_wr(0x33, 0x00);   /* INT1_DURATION = 0 */
	(void)acc_rd(0x26);   /* dummy read REFERENCE: reset the HP filter */
	acc_wr(0x30, 0x2A);   /* INT1_CFG: OR of XH|YH|ZH (any-axis MOTION now) */
	(void)acc_rd(0x31);   /* clear latch */
}

static void enter_deep_sleep(void)
{
	bt_le_adv_stop();
	led_off();
	(void)acc_rd(0x31);   /* clear pending motion INT so P0.14 is low */
	nrf_gpio_cfg_sense_input(ACC_INT_PIN, NRF_GPIO_PIN_NOPULL, NRF_GPIO_PIN_SENSE_HIGH);
	k_msleep(2);
	sys_poweroff();       /* System OFF; P0.14 high (motion) wakes -> reboot */
}

/* Read OUT_X/Y/Z (auto-increment) as three int16 (left-justified raw counts). */
static int acc_read6(int16_t *xyz)
{
	a_st(); if (!a_wrb((ACC_ADDR << 1) | 0)) { a_sp(); return 0; }
	a_wrb(0x28 | 0x80);   /* OUT_X_L, auto-increment */
	a_st(); if (!a_wrb((ACC_ADDR << 1) | 1)) { a_sp(); return 0; }
	uint8_t b[6];
	for (int i = 0; i < 6; i++) b[i] = a_rdb(i < 5);
	a_sp();
	xyz[0] = (int16_t)(b[1] << 8 | b[0]);
	xyz[1] = (int16_t)(b[3] << 8 | b[2]);
	xyz[2] = (int16_t)(b[5] << 8 | b[4]);
	return 1;
}

/* Simple pedometer: peak-detect the high-passed L1 acceleration magnitude. */
static uint16_t step_count;
static void step_update(int16_t x, int16_t y, int16_t z)
{
	static int32_t base; static bool armed = true; static int64_t last_ms;
	static int warm;
	int32_t m = (x < 0 ? -x : x) + (y < 0 ? -y : y) + (z < 0 ? -z : z);
	if (warm < 50) { warm++; base = m; return; }   /* ~2 s: settle baseline, no counting */
	base += (m - base) >> 6;              /* slow baseline (gravity)          */
	int32_t hp = m - base;                /* dynamic component                */
	int64_t now = k_uptime_get();
	if (armed && hp > 3000 && (now - last_ms) > 300) {   /* step: peak + 300ms refractory */
		step_count++; armed = false; last_ms = now;
	} else if (hp < 1500) {
		armed = true;
	}
}

int main(void)
{
	uint8_t raw_buf[2 + RAW_BATCH * 2];
	uint16_t seq = 0; int rn = 0;

	cyc_per_sec = sys_clock_hw_cycles_per_sec();
	LOG_INF("HRM raw-RR+ECG firmware boot");

	nrf_gpio_cfg_output(LED_PIN);
	for (int i = 0; i < 2; i++) { led_on(); k_msleep(60); led_off(); k_msleep(120); } /* wake blink */

	accel_init_motion_int();   /* arm SC7A20 motion INT -> P0.14 for deep-sleep wake */

	if (!adc_is_ready_dt(&adc_ch) || adc_channel_setup_dt(&adc_ch)) {
		LOG_ERR("ADC setup failed");
		return -1;
	}
	adc_sequence_init_dt(&adc_ch, &adc_seq);
	if (adc_is_ready_dt(&adc_vdd) && adc_channel_setup_dt(&adc_vdd) == 0) {
		adc_sequence_init_dt(&adc_vdd, &vdd_seq);   /* battery (VDD) channel */
	}
	if (bt_enable(bt_ready)) {
		LOG_ERR("bt_enable failed");
		return -1;
	}
	k_timer_start(&sample_timer, K_NO_WAIT, K_USEC(1000000 / SAMPLE_HZ));

	int64_t active_start = k_uptime_get();
	last_beat_ms = active_start;   /* 60 s grace to find the first beat (also a reflash window) */

	while (1) {
		k_sem_take(&tick_sem, K_FOREVER);
		if (adc_read_dt(&adc_ch, &adc_seq) != 0) continue;

		sample_idx++;
		if (led_off_idx && sample_idx >= led_off_idx) { led_off(); led_off_idx = 0; }

		detector_feed(adc_raw);

		/* raw ECG streaming (only when a client subscribes) */
		sys_put_le16((uint16_t)adc_raw, &raw_buf[2 + rn * 2]);
		if (++rn >= RAW_BATCH) {
			sys_put_le16(seq++, &raw_buf[0]);
			if (cap_ccc) {
				bt_gatt_notify(NULL, &cap_svc.attrs[2], raw_buf, sizeof(raw_buf));
			}
			rn = 0;
		}

		/* accelerometer: raw X/Y/Z + pedometer, streamed at ~25 Hz */
		if ((sample_idx % 10) == 0) {
			int16_t xyz[3];
			if (acc_read6(xyz)) {
				step_update(xyz[0], xyz[1], xyz[2]);
				if (accs_ccc) {
					uint8_t ab[8];
					sys_put_le16(xyz[0], &ab[0]);
					sys_put_le16(xyz[1], &ab[2]);
					sys_put_le16(xyz[2], &ab[4]);
					sys_put_le16(step_count, &ab[6]);
					bt_gatt_notify(NULL, &accs_svc.attrs[2], ab, sizeof(ab));
				}
			}
		}

		/* battery level (VDD) -> Battery Service, first at ~1 s then every ~10 s */
		if (sample_idx % 2500 == 250) {
			battery_update();
		}

		/* power management: deep sleep (System OFF) if off-body or session > 3 h;
		 * SC7A20 motion INT on P0.14 wakes the chip -> reboot -> re-check for beats */
		int64_t now = k_uptime_get();
		if ((now - last_beat_ms > OFFBODY_MS) || (now - active_start > MAX_ACTIVE_MS)) {
			enter_deep_sleep();   /* does not return */
		}
	}
}
