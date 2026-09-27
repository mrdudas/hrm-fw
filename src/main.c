/*
 * Decathlon HRM Belt (Magene OEM, nRF52805) — custom firmware
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
#include <zephyr/logging/log.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/bluetooth/gatt.h>
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
static const struct adc_dt_spec adc_ch = ADC_DT_SPEC_GET(DT_PATH(zephyr_user));
static int16_t adc_raw;
static struct adc_sequence adc_seq = {
	.buffer = &adc_raw, .buffer_size = sizeof(adc_raw),
};

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
static void disconnected(struct bt_conn *c, uint8_t r) { k_work_submit(&adv_work); }
BT_CONN_CB_DEFINE(conn_cb) = { .disconnected = disconnected };
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
	static uint16_t h[4]; static uint8_t n;
	h[n & 3] = rr_ms; if (n < 250) n++;
	uint8_t c = MIN(n, 4); uint32_t s = 0;
	for (int i = 0; i < c; i++) s += h[i];
	uint16_t avg = s / c;
	return (avg >= RR_MIN_MS) ? (uint8_t)(60000U / avg) : 0;
}

static void detector_feed(int16_t sample)
{
	static float notch_z[2], bp_z[4];
	static float env = 1.0f;
	static bool  armed = true;
	static uint32_t last_cyc, warm;
	static bool  have_last;

	float yn = iir(NOTCH_b, NOTCH_a, notch_z, 3, (float)sample);
	float yb = iir(BP_b, BP_a, bp_z, 5, yn);
	float energy = yb * yb;

	/* envelope of the QRS energy: fast attack, slow decay */
	if (energy > env) env = energy; else env *= ENV_DECAY;

	if (warm < WARMUP_SAMPLES) { warm++; return; }

	float thresh = env * THRESH_FRAC;
	uint32_t now = k_cycle_get_32();
	uint32_t refr = (uint64_t)cyc_per_sec * REFRACTORY_MS / 1000;
	bool in_refr = have_last && (now - last_cyc) < refr;

	if (armed && !in_refr && energy > thresh && env > 50.0f /* noise floor */) {
		armed = false;
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
			}
		}
		last_cyc = now; have_last = true;
	} else if (energy < thresh * 0.5f) {
		armed = true;
	}
}

/* ---- Sampling loop --------------------------------------------------- */
static K_SEM_DEFINE(tick_sem, 0, 1);
static void tick(struct k_timer *t) { k_sem_give(&tick_sem); }
static K_TIMER_DEFINE(sample_timer, tick, NULL);

/* ---- Low-power contact sniff (nRF52805 has no LPCOMP for analog wake) --
 * Off-body the electrode is flat (~239, p2p ~13); on-body it swings hugely.
 * We stop sampling + advertising and wake the CPU every 2 s for a short burst
 * to check for that swing, so average current stays in the tens-of-µA range. */
#define ONBODY_P2P 200

static bool require_offbody;   /* 3 h latch: must be removed before re-arming */

static int sniff_p2p(void)
{
	int lo = 100000, hi = -100000;
	for (int i = 0; i < 24; i++) {
		if (adc_read_dt(&adc_ch, &adc_seq) == 0) {
			if (adc_raw < lo) lo = adc_raw;
			if (adc_raw > hi) hi = adc_raw;
		}
		k_msleep(4);
	}
	return hi - lo;
}

static void low_power_until_contact(void)
{
	bt_le_adv_stop();
	k_timer_stop(&sample_timer);
	led_off();
	while (1) {
		k_sleep(K_SECONDS(2));           /* CPU idles (~µA) */
		bool onbody = sniff_p2p() > ONBODY_P2P;
		if (require_offbody) {
			if (!onbody) require_offbody = false;   /* removed -> re-arm */
		} else if (onbody) {
			break;                       /* worn -> wake up */
		}
	}
	for (int i = 0; i < 2; i++) { led_on(); k_msleep(60); led_off(); k_msleep(120); }
	k_work_submit(&adv_work);
	k_timer_start(&sample_timer, K_NO_WAIT, K_USEC(1000000 / SAMPLE_HZ));
}

int main(void)
{
	uint8_t raw_buf[2 + RAW_BATCH * 2];
	uint16_t seq = 0; int rn = 0;

	cyc_per_sec = sys_clock_hw_cycles_per_sec();
	LOG_INF("HRM raw-RR+ECG firmware boot");

	nrf_gpio_cfg_output(LED_PIN);
	for (int i = 0; i < 2; i++) { led_on(); k_msleep(60); led_off(); k_msleep(120); } /* wake blink */

	if (!adc_is_ready_dt(&adc_ch) || adc_channel_setup_dt(&adc_ch)) {
		LOG_ERR("ADC setup failed");
		return -1;
	}
	adc_sequence_init_dt(&adc_ch, &adc_seq);
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

		/* power management: low-power sniff if off-body or session > 3 h */
		int64_t now = k_uptime_get();
		bool offbody  = (now - last_beat_ms  > OFFBODY_MS);
		bool too_long = (now - active_start  > MAX_ACTIVE_MS);
		if (offbody || too_long) {
			require_offbody = too_long;      /* 3 h -> must remove before restart */
			low_power_until_contact();
			active_start = k_uptime_get();   /* fresh session */
			last_beat_ms = active_start;
		}
	}
}
