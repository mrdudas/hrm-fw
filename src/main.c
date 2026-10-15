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
#include <zephyr/drivers/clock_control.h>
#include <zephyr/drivers/clock_control/nrf_clock_control.h>
#include <nrfx.h>
#include <nrfx_saadc.h>
#include <hal/nrf_saadc.h>
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
#include <string.h>
#include <math.h>

LOG_MODULE_REGISTER(hrm, LOG_LEVEL_INF);

/* ---- Tunables (filters are fs-specific: designed for 250 Hz) ---------- */
#define SAMPLE_HZ      500            /* ECG output rate: SAADC samples 8 kHz, averaged /16 */
#define REFRACTORY_MS  300            /* min beat gap (~200 bpm max)          */
#define RR_MIN_MS      300
#define RR_MAX_MS      2000
#define ENV_DECAY      0.9960f        /* energy envelope decay per sample     */
#define THRESH_FRAC    0.35f          /* threshold = fraction of envelope     */
#define WARMUP_SAMPLES (SAMPLE_HZ * 8)/* let the AC-coupled ECG front-end settle
                                        * after power-on/wake (~7 s transient) +
                                        * IIR filter settle, before detecting     */
#define RAW_BATCH      30             /* raw samples per BLE notification (62 B pkt): fewer,
                                       * bigger notifies keep ECG+ACC under the macOS
                                       * ~30 notify/s ceiling (500 Hz / 30 = 16.7 notify/s) */
#define ACC_BATCH      5              /* accel samples batched per BLE notify (25 Hz -> 5/s) */
#define TWAVE_MS       360            /* T-wave window after a QRS (Pan-Tompkins) */
#define TWAVE_FRAC     0.5f           /* peak in that window below this*QRS energy = T-wave */
#define SNR_GATE       8.0f           /* classify ectopy only when spki > this*npki (clean signal) */
#define RAIL_LO        100            /* raw ADC near the bottom rail = contact artifact */
#define RAIL_HI        3995           /* raw ADC near the top rail (12-bit, 0..4095)      */
#define RAIL_WIN       (SAMPLE_HZ/10)  /* ~100 ms a rail flag persists (fs-relative)       */
#define MOTION_FRAC    5.0f           /* energy > this*normal QRS = contact spike (real PVC is ~2-3x) */
#define TWAVE_LO_FRAC  0.4f           /* energy < this*normal QRS = T-wave/low (drop)      */

/* HW_DIFF: the "special" front-end variant. P0.04 (AIN2) is wired to the op-amp
 * common point (half-supply), so ECG is read DIFFERENTIALLY (AIN3 - AIN2) with
 * common-mode rejection; the LED moves to P0.12; and on-body is sensed from the
 * AIN2 half-supply being present (AFE powered) rather than from a contact pin.
 * HW_DIFF=0 is the standard board (single-ended AIN3, LED on P0.04, P0.12 sense). */
#ifndef HW_DIFF
#define HW_DIFF 1
#endif

/* Power / status LED */
#if HW_DIFF
#define LED_PIN        12                 /* P0.12, active-high status LED (special HW) */
#else
#define LED_PIN        4                  /* P0.04, active-high status LED     */
#define CONTACT_PIN    12                 /* P0.12: AFE lead-off/CONTACT status output
                                           * (high = on-body, low = off-body). It self-
                                           * gates the AFE -> READ ONLY, never drive it. */
#endif
#define OFFBODY_MS     60000              /* off-body + no motion this long -> sleep */
#define MAX_ACTIVE_MS  (3LL*60*60*1000)   /* 3 h max session -> sleep           */
#define PROBATION_MS   60000              /* advertise this long after wake; not worn -> sleep */
#define ASSIST_MS      5000               /* P0.12 pull-up assist window while the AFE latches on */
#if HW_DIFF
#define OB_FLOOR       150                /* peak-hold AC-envelope below this = off-body. Worn env >=430, off-body ~20. */
#endif
#define CONTACT_DEB    (SAMPLE_HZ/2)      /* P0.12 contact debounce samples (~0.5 s, fs-relative) */
#define MOTION_THR     1200               /* accel high-pass magnitude that counts as "moving" */
#define LED_PULSE_N    (SAMPLE_HZ*12/1000) /* ~12 ms LED pulse per beat (fs-relative) */

/* HP (high-pass) compensation of the STREAM. The AFE still has a residual
 * high-pass (~fc) that flattens P/T and tilts the baseline; a first-order
 * shelving filter undoes it -- unity gain above fc, boosted below (DC gain
 * (1-b)/(1-a) ~= 9.7), with a safety corner f0 so a continuous stream's
 * baseline can't run away. Applied to the streamed sample ONLY; the detector
 * and off-body envelope stay on the uncompensated signal (cleanest baseline).
 * fc is Zsolt's by-eye value from the app, NOT measured, so keep it retunable.
 * The host is told via the GATT info char (flags bit2 + fc byte) so it disables
 * its own HP comp and doesn't double-compensate. */
#ifndef HP_COMP
#define HP_COMP        HW_DIFF
#endif
#define HP_COMP_FC_X10 50     /* fc = 5.0 Hz (0.1 Hz units; reported in GATT info) */
#define HP_COMP_F0_X10 5      /* f0 = 0.5 Hz safety corner */
#define HP_HPF_X10     5      /* second-stage high-pass corner = 0.5 Hz (DC/baseline) */

#if HP_COMP
/* Runtime-tunable HP-compensation parameters, set from the app via CAP_CFG
 * (a1b20005). Corners are in 0.1 Hz units. The coefficients are recomputed
 * once per config write (expf is fine off the hot path); the sampling loop
 * reads the volatile coefficients live. A 32-bit aligned float store is a
 * single word write on Cortex-M, so a mid-update read just costs one stale
 * sample -- harmless for an IIR corner. */
#define HP_FLAG_SHELF  0x01   /* shelving HP-compensation enabled */
#define HP_FLAG_HPF    0x02   /* second-stage 0.5 Hz high-pass enabled */
static volatile uint8_t  g_hp_flags  = HP_FLAG_SHELF | HP_FLAG_HPF;
static volatile uint16_t g_hp_fc_x10 = HP_COMP_FC_X10;
static volatile uint16_t g_hp_f0_x10 = HP_COMP_F0_X10;
static volatile uint16_t g_hpf_x10   = HP_HPF_X10;
static volatile float    g_hp_a = 0.993737f;   /* exp(-2*pi*0.5/500) shelf pole  */
static volatile float    g_hp_b = 0.939101f;   /* exp(-2*pi*5.0/500) shelf zero  */
static volatile float    g_hpf_c = 0.993737f;  /* exp(-2*pi*0.5/500) HPF corner  */
static void hp_recompute(void)
{
	const float k = -2.0f * 3.14159265f / (float)SAMPLE_HZ;
	g_hp_b  = expf(k * ((float)g_hp_fc_x10 * 0.1f));
	g_hp_a  = expf(k * ((float)g_hp_f0_x10 * 0.1f));
	g_hpf_c = expf(k * ((float)g_hpf_x10   * 0.1f));
}
#endif

/* 8-22 Hz band-pass (Butterworth order 2 -> 4th order section) @500 Hz */
static const float BP_b[] = {0.00686787f, 0.0f, -0.01373573f, 0.0f, 0.00686787f};
static const float BP_a[] = {1.0f, -3.70011109f, 5.18676736f, -3.26571330f, 0.77973946f};

/* ---- SAADC: hardware-timed ECG sampling (immune to BLE preemption) ----
 * The SAADC's own internal timer samples AIN3 (P0.05) into RAM via EasyDMA with
 * ZERO per-sample CPU, so BLE connection events can no longer steal sample ticks
 * (the former thread-polled 500 Hz loop lost ~30 % of ticks to the radio ISR).
 * The internal timer's minimum rate is ~7.8 kHz (SAMPLERATE.CC is 11-bit), so we
 * run it at 8 kHz and average every 16 raw samples down to an exact 500 Hz ECG
 * stream (the 16x oversampling also lifts SNR ~12 dB). The internal timer needs a
 * single channel, so VDD (battery) is read once per wake at boot. */
#define ADC_HW_HZ      8000                      /* SAADC internal-timer rate         */
#define OVERSAMPLE     (ADC_HW_HZ / SAMPLE_HZ)   /* 16 raw -> 1 output sample         */
#define ADC_TIMER_CC   (16000000UL / ADC_HW_HZ)  /* 16 MHz / 8 kHz = 2000 (<= 2047 max) */
#define ADC_BUF_SMP    (OVERSAMPLE * 5)          /* 80 raw/buffer -> 5 output, DONE every 10 ms */
#define ADC_BUF_CNT    2

static nrf_saadc_value_t adc_bufs[ADC_BUF_CNT][ADC_BUF_SMP];
K_MSGQ_DEFINE(adc_doneq, sizeof(nrf_saadc_value_t *), ADC_BUF_CNT, sizeof(void *));
static volatile uint32_t adc_overrun;   /* filled buffers dropped because processing lagged */
static volatile int32_t  dbg_obenv;     /* HW_DIFF: live |ECG| envelope, for tuning OB_FLOOR */

/* ECG input channel. Standard: single-ended AIN3 (P0.05) vs chip GND, gain 1/4,
 * ref VDD/4 -> 0..4095 around a ~mid-rail bias. HW_DIFF: differential AIN3 - AIN2,
 * where AIN2 (P0.04) is the op-amp half-supply -> a SIGNED result centred on 0 with
 * the supply/ground common-mode rejected. (nrfx 4.0 wants nrfx_analog_input_t, not
 * the raw PSELP value.) */
static const nrfx_saadc_channel_t ecg_channel = {
	.channel_config = {
		.resistor_p = NRF_SAADC_RESISTOR_DISABLED,
		.resistor_n = NRF_SAADC_RESISTOR_DISABLED,
		.gain       = NRF_SAADC_GAIN1_4,
		.reference  = NRF_SAADC_REFERENCE_VDD4,
		.acq_time   = NRF_SAADC_ACQTIME_10US,
#if HW_DIFF
		.mode       = NRF_SAADC_MODE_DIFFERENTIAL,
#else
		.mode       = NRF_SAADC_MODE_SINGLE_ENDED,
#endif
		.burst      = NRF_SAADC_BURST_DISABLED,
	},
	.pin_p = NRFX_ANALOG_EXTERNAL_AIN3,   /* AIN3 = P0.05 (ECG signal) */
#if HW_DIFF
	.pin_n = NRFX_ANALOG_EXTERNAL_AIN2,   /* AIN2 = P0.04 (op-amp half-supply) */
#else
	.pin_n = NRFX_ANALOG_INPUT_DISABLED,
#endif
	.channel_index = 0,
};

/* SAADC event handler (ISR): keeps the double buffer full and hands filled
 * buffers to the processing loop. The 10 ms buffer absorbs BLE stalls. */
static void saadc_handler(nrfx_saadc_evt_t const *evt)
{
	static uint8_t next = 1;   /* buf 0 is set before trigger; supply buf 1 first */
	switch (evt->type) {
	case NRFX_SAADC_EVT_CALIBRATEDONE:
		nrfx_saadc_mode_trigger();              /* start continuous sampling */
		break;
	case NRFX_SAADC_EVT_BUF_REQ:
		nrfx_saadc_buffer_set(adc_bufs[next], ADC_BUF_SMP);
		next ^= 1;
		break;
	case NRFX_SAADC_EVT_DONE: {
		nrf_saadc_value_t *p = evt->data.done.p_buffer;
		if (k_msgq_put(&adc_doneq, &p, K_NO_WAIT) != 0) adc_overrun++;
		break;
	}
	default:
		break;
	}
}

/* One blocking VDD conversion -> millivolts. gain 1/6, ref internal 0.6 V,
 * 12-bit single-ended: RESULT = Vin * (1/6)/0.6 * 4096 -> Vin_mV = RESULT*3600/4096. */
static int32_t adc_read_vdd_mv(void)
{
	static const nrfx_saadc_channel_t vdd_channel = {
		.channel_config = {
			.resistor_p = NRF_SAADC_RESISTOR_DISABLED,
			.resistor_n = NRF_SAADC_RESISTOR_DISABLED,
			.gain       = NRF_SAADC_GAIN1_6,
			.reference  = NRF_SAADC_REFERENCE_INTERNAL,
			.acq_time   = NRF_SAADC_ACQTIME_20US,
			.mode       = NRF_SAADC_MODE_SINGLE_ENDED,
			.burst      = NRF_SAADC_BURST_DISABLED,
		},
		.pin_p = NRFX_ANALOG_INTERNAL_VDD,
		.pin_n = NRFX_ANALOG_INPUT_DISABLED,
		.channel_index = 0,
	};
	nrf_saadc_value_t s = 0;
	if (nrfx_saadc_channel_config(&vdd_channel) != 0) return -1;
	if (nrfx_saadc_simple_mode_set(BIT(0), NRF_SAADC_RESOLUTION_12BIT,
				       NRF_SAADC_OVERSAMPLE_DISABLED, NULL) != 0) return -1;
	nrfx_saadc_buffer_set(&s, 1);
	nrfx_saadc_mode_trigger();   /* blocking (no handler) */
	return (int32_t)s * 3600 / 4096;
}

#if HW_DIFF
/* One blocking single-ended read of AIN2 (P0.04 = op-amp half-supply), gain 1/4,
 * ref VDD/4 -> 0..4095 of VDD. On-body the AFE is powered and the half-supply
 * (~VDD/2) sits near 2048; off-body it collapses toward 0. Used to gate startup.
 * Only valid before continuous (differential) sampling is running. */
#define ONBODY_THR 500   /* half-supply counts above this = AFE powered = on-body */
/* Kept for diagnostics / future use; the HW_DIFF path no longer gates on it. */
static int32_t __maybe_unused adc_read_ain2(void)
{
	static const nrfx_saadc_channel_t ain2_channel = {
		.channel_config = {
			.resistor_p = NRF_SAADC_RESISTOR_DISABLED,
			.resistor_n = NRF_SAADC_RESISTOR_DISABLED,
			.gain       = NRF_SAADC_GAIN1_4,
			.reference  = NRF_SAADC_REFERENCE_VDD4,
			.acq_time   = NRF_SAADC_ACQTIME_10US,
			.mode       = NRF_SAADC_MODE_SINGLE_ENDED,
			.burst      = NRF_SAADC_BURST_DISABLED,
		},
		.pin_p = NRFX_ANALOG_EXTERNAL_AIN2,
		.pin_n = NRFX_ANALOG_INPUT_DISABLED,
		.channel_index = 0,
	};
	nrf_saadc_value_t s = 0;
	if (nrfx_saadc_channel_config(&ain2_channel) != 0) return -1;
	if (nrfx_saadc_simple_mode_set(BIT(0), NRF_SAADC_RESOLUTION_12BIT,
				       NRF_SAADC_OVERSAMPLE_DISABLED, NULL) != 0) return -1;
	nrfx_saadc_buffer_set(&s, 1);
	nrfx_saadc_mode_trigger();   /* blocking */
	return (int32_t)s;
}
#endif

/* Map a CR2032 (~2.4 V empty .. 3.0 V full) to % and publish via BAS. */
static void battery_update_mv(int32_t mv)
{
	if (mv < 0) return;
	int32_t pct = (mv - 2400) * 100 / 600;
	pct = CLAMP(pct, 0, 100);
	bt_bas_set_battery_level((uint8_t)pct);
}

/* ---- Heart Rate Service (real RR) ------------------------------------ */
static uint8_t hrm_ccc;
static uint8_t body_loc = 0x01;   /* chest */

/* ---- BLE TX decouple ------------------------------------------------
 * The sampling thread must NEVER call bt_gatt_notify (it blocks there when the
 * few ACL TX buffers fill on a slow host, which stalls sampling and loses
 * samples). It enqueues packets here; a delayable work item drains them with
 * bt_gatt_notify. Note: on the system workqueue, bt_gatt_notify is forced to
 * K_NO_WAIT by the host, so a full pool returns -ENOMEM instead of blocking --
 * we then hold the packet and retry, rather than discarding the queue.
 * Queue full on enqueue -> drop newest; ECG seq lets the app see the gap. */
enum { TX_ECG, TX_ACCEL, TX_HR, TX_ECTOPY };
struct tx_pkt { uint8_t type; uint8_t len; uint8_t data[62]; };   /* >= largest notify (ECG = 2 + RAW_BATCH*2) */
#define TXQ_DEPTH 6
K_MSGQ_DEFINE(txq, sizeof(struct tx_pkt), TXQ_DEPTH, 4);
static uint32_t tx_dropped;
static struct k_work_delayable tx_dwork;   /* drains txq on the system workqueue */
static void tx_enqueue(uint8_t type, const void *data, uint8_t len)
{
	/* ECG priority: once the queue is half full, drop accel first (high rate,
	 * least critical) so ECG/HR/ectopy keep their slots during a host stall. */
	if (type == TX_ACCEL && k_msgq_num_used_get(&txq) >= TXQ_DEPTH / 2) {
		tx_dropped++;
		return;
	}
	struct tx_pkt p;
	p.type = type; p.len = len;
	memcpy(p.data, data, len);
	if (k_msgq_put(&txq, &p, K_NO_WAIT) != 0) tx_dropped++;
	k_work_reschedule(&tx_dwork, K_NO_WAIT);
}

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
		tx_enqueue(TX_HR, buf, sizeof(buf));
	}
}

/* ---- Raw-ECG streaming service (custom) ------------------------------ */
#define CAP_SVC  BT_UUID_128_ENCODE(0xa1b20001,0x0000,0x1000,0x8000,0x00805f9b34fb)
#define CAP_CHR  BT_UUID_128_ENCODE(0xa1b20002,0x0000,0x1000,0x8000,0x00805f9b34fb)
#define CAP_INFO BT_UUID_128_ENCODE(0xa1b20003,0x0000,0x1000,0x8000,0x00805f9b34fb)
#define CAP_LINK BT_UUID_128_ENCODE(0xa1b20004,0x0000,0x1000,0x8000,0x00805f9b34fb)
#define CAP_CFG  BT_UUID_128_ENCODE(0xa1b20005,0x0000,0x1000,0x8000,0x00805f9b34fb)
static struct bt_uuid_128 cap_svc_uuid  = BT_UUID_INIT_128(CAP_SVC);
static struct bt_uuid_128 cap_chr_uuid  = BT_UUID_INIT_128(CAP_CHR);
static struct bt_uuid_128 cap_info_uuid = BT_UUID_INIT_128(CAP_INFO);
static struct bt_uuid_128 cap_link_uuid = BT_UUID_INIT_128(CAP_LINK);
#if HP_COMP
static struct bt_uuid_128 cap_cfg_uuid  = BT_UUID_INIT_128(CAP_CFG);
#endif
static uint8_t cap_ccc;
static void cap_ccc_changed(const struct bt_gatt_attr *a, uint16_t v) { cap_ccc = (v == BT_GATT_CCC_NOTIFY); }

/* Stream descriptor so the host sets its time axis from the strap, not a hard-coded
 * rate. LE: u16 sample_hz, u16 raw_batch, u8 sample_bytes, u8 fmt_ver, u16 acc_div,
 * u8 flags (bit0 = stream mains-filtered in firmware; bit1 = 60 Hz, 0 = 50;
 * bit2 = stream HP-compensated in firmware), u8 hp_comp_fc (0.1 Hz units; 0 = none).
 * The host reads bit2 to disable its own HP comp (no double compensation). */
static ssize_t read_cap_info(struct bt_conn *c, const struct bt_gatt_attr *a,
			     void *buf, uint16_t len, uint16_t off)
{
	uint8_t info[10];
	sys_put_le16(SAMPLE_HZ, &info[0]);
	sys_put_le16(RAW_BATCH, &info[2]);
	info[4] = 2;
	info[5] = 1;
	sys_put_le16(SAMPLE_HZ / 25, &info[6]);
	info[8] = 0x01;   /* mains-filtered (Levkov) @ 50 Hz */
#if HP_COMP
	if (g_hp_flags & HP_FLAG_SHELF) {
		info[8] |= 0x04;             /* stream is HP-compensated in firmware */
		info[9] = (uint8_t)g_hp_fc_x10;  /* LIVE comp corner, 0.1 Hz units (tunable via CAP_CFG) */
	} else {
		info[9] = 0;                 /* comp currently disabled from the app */
	}
#else
	info[9] = 0;                     /* no firmware HP comp */
#endif
	return bt_gatt_attr_read(c, a, buf, len, off, info, sizeof(info));
}

/* Live link parameters for diagnosing host throughput (macOS hides these from its
 * apps, so the strap reports them). LE: u16 interval (1.25 ms units), u16 latency,
 * u16 supervision timeout (10 ms units), u16 ATT MTU, u8 conn_count. */
static volatile int conn_count;   /* defined once; also used by the power state machine */
static ssize_t read_cap_link(struct bt_conn *c, const struct bt_gatt_attr *a,
			     void *buf, uint16_t len, uint16_t off)
{
	uint8_t out[15] = {0};
	struct bt_conn_info ci;
	if (c && bt_conn_get_info(c, &ci) == 0 && ci.type == BT_CONN_TYPE_LE) {
		sys_put_le16((uint16_t)(ci.le.interval_us / 1250), &out[0]);
		sys_put_le16(ci.le.latency, &out[2]);
		sys_put_le16(ci.le.timeout, &out[4]);
	}
	sys_put_le16(bt_gatt_get_mtu(c), &out[6]);
	out[8] = (uint8_t)conn_count;
	sys_put_le32(adc_overrun, &out[9]);   /* DMA buffers dropped if processing ever lagged */
	sys_put_le16((uint16_t)dbg_obenv, &out[13]);   /* HW_DIFF |ECG| envelope (OB_FLOOR tuning) */
	return bt_gatt_attr_read(c, a, buf, len, off, out, sizeof(out));
}

#if HP_COMP
/* HP-compensation config (a1b20005), read + write. 7 bytes LE:
 *   [0]   flags: bit0 shelf HP-comp on, bit1 0.5 Hz HPF on
 *   [1:3] fc_x10  shelf corner, 0.1 Hz units (50 = 5.0 Hz) -- lower = less boost
 *   [3:5] f0_x10  shelf pole / safety corner, 0.1 Hz units (<= fc)
 *   [5:7] hpf_x10 second-stage high-pass corner, 0.1 Hz units
 * Write recomputes the IIR coefficients; read returns the live values so the
 * app can show the current setting. No reflash needed to retune. */
static ssize_t read_cap_cfg(struct bt_conn *c, const struct bt_gatt_attr *a,
			    void *buf, uint16_t len, uint16_t off)
{
	uint8_t cfg[7];
	cfg[0] = g_hp_flags;
	sys_put_le16(g_hp_fc_x10, &cfg[1]);
	sys_put_le16(g_hp_f0_x10, &cfg[3]);
	sys_put_le16(g_hpf_x10,   &cfg[5]);
	return bt_gatt_attr_read(c, a, buf, len, off, cfg, sizeof(cfg));
}
static ssize_t write_cap_cfg(struct bt_conn *c, const struct bt_gatt_attr *a,
			     const void *buf, uint16_t len, uint16_t off, uint8_t flags)
{
	const uint8_t *p = buf;
	if (off != 0)  return BT_GATT_ERR(BT_ATT_ERR_INVALID_OFFSET);
	if (len < 7)   return BT_GATT_ERR(BT_ATT_ERR_INVALID_ATTRIBUTE_LEN);
	uint16_t fc = sys_get_le16(&p[1]);
	uint16_t f0 = sys_get_le16(&p[3]);
	uint16_t hf = sys_get_le16(&p[5]);
	/* clamp to sane corners (0.1 Hz units, fs = 500 Hz, keep well below Nyquist) */
	if (fc < 1)    fc = 1;
	if (fc > 2000) fc = 2000;        /* <= 200 Hz */
	if (f0 < 1)    f0 = 1;
	if (f0 > fc)   f0 = fc;          /* pole at/below the zero (no negative boost) */
	if (hf > 2000) hf = 2000;        /* hf may be set with the bit cleared to bypass */
	g_hp_flags  = p[0] & (HP_FLAG_SHELF | HP_FLAG_HPF);
	g_hp_fc_x10 = fc;
	g_hp_f0_x10 = f0;
	g_hpf_x10   = hf;
	hp_recompute();
	return len;
}
#endif

BT_GATT_SERVICE_DEFINE(cap_svc,
	BT_GATT_PRIMARY_SERVICE(&cap_svc_uuid),
	BT_GATT_CHARACTERISTIC(&cap_chr_uuid.uuid, BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_NONE, NULL, NULL, NULL),
	BT_GATT_CCC(cap_ccc_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
	BT_GATT_CHARACTERISTIC(&cap_info_uuid.uuid, BT_GATT_CHRC_READ,
			       BT_GATT_PERM_READ, read_cap_info, NULL, NULL),
	BT_GATT_CHARACTERISTIC(&cap_link_uuid.uuid, BT_GATT_CHRC_READ,
			       BT_GATT_PERM_READ, read_cap_link, NULL, NULL),
#if HP_COMP
	BT_GATT_CHARACTERISTIC(&cap_cfg_uuid.uuid, BT_GATT_CHRC_READ | BT_GATT_CHRC_WRITE,
			       BT_GATT_PERM_READ | BT_GATT_PERM_WRITE,
			       read_cap_cfg, write_cap_cfg, NULL),
#endif
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
	if (ect_ccc) tx_enqueue(TX_ECTOPY, ect_buf, sizeof(ect_buf));
}

/* TX work: drains the queue with bt_gatt_notify on the system workqueue (no
 * dedicated thread stack). The sampling thread only enqueues, so it never blocks
 * on BLE. A notify here may block on TX buffers; that only delays other sysworkq
 * items (re-advertise), never sampling. */
static void tx_work_fn(struct k_work *w)
{
	static struct tx_pkt pend;
	static bool have_pend;
	ARG_UNUSED(w);
	while (1) {
		if (!have_pend) {
			if (k_msgq_get(&txq, &pend, K_NO_WAIT) != 0) return;   /* queue empty */
			have_pend = true;
		}
		const struct bt_gatt_attr *attr;
		switch (pend.type) {
		case TX_ECG:    attr = &cap_svc.attrs[2];  break;
		case TX_ACCEL:  attr = &accs_svc.attrs[2]; break;
		case TX_HR:     attr = &hrm_svc.attrs[2];  break;
		case TX_ECTOPY: attr = &ect_svc.attrs[2];  break;
		default: have_pend = false; continue;
		}
		int err = bt_gatt_notify(NULL, attr, pend.data, pend.len);
		if (err == -ENOMEM || err == -EAGAIN) {
			k_work_reschedule(&tx_dwork, K_MSEC(4));   /* TX buffers full: hold + retry */
			return;
		}
		have_pend = false;   /* sent, or dropped on -ENOTCONN etc. */
	}
}

/* ---- Advertising ----------------------------------------------------- */
/* Device name gets a per-chip suffix at boot ("Govinda-XXXX", XXXX = last 4 hex
 * of the nRF52805 factory DEVICEID) so several straps are told apart in the scan
 * list. Built in dev_name_init(); ad[2] below starts at the base name and is
 * updated in place (same buffer) before advertising. */
static char dev_name[20] = CONFIG_BT_DEVICE_NAME;
static struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA_BYTES(BT_DATA_UUID16_ALL, BT_UUID_16_ENCODE(BT_UUID_HRS_VAL)),
	BT_DATA(BT_DATA_NAME_COMPLETE, dev_name, sizeof(CONFIG_BT_DEVICE_NAME) - 1),
};
static void dev_name_init(void)
{
	static const char hx[] = "0123456789ABCDEF";
	uint16_t id = (uint16_t)(NRF_FICR->DEVICEID[1] & 0xFFFF);   /* unique per chip, stable */
	int n = strlen(dev_name);
	dev_name[n++] = '-';
	dev_name[n++] = hx[(id >> 12) & 0xF];
	dev_name[n++] = hx[(id >> 8) & 0xF];
	dev_name[n++] = hx[(id >> 4) & 0xF];
	dev_name[n++] = hx[id & 0xF];
	dev_name[n]   = '\0';
	ad[2].data_len = n;   /* advertise the suffixed name (ad[2].data already = dev_name) */
}
static void adv_work_fn(struct k_work *w)
{
	int e = bt_le_adv_start(BT_LE_ADV_CONN_FAST_1, ad, ARRAY_SIZE(ad), NULL, 0);
	LOG_INF("advertising %s", e ? "FAILED" : "started");
}
static K_WORK_DEFINE(adv_work, adv_work_fn);
/* conn_count defined above (needed earlier by the link-info characteristic).
 * idle_since (HW_DIFF): uptime (ms, low 32 bits) of the moment the strap last
 * became idle (boot, or the last disconnect leaving no connection). The power
 * loop sleeps PROBATION_MS after this; a live connection clears it. 32-bit so
 * the read in the loop is atomic against the callback write. */
static volatile uint32_t idle_since;
static void connected(struct bt_conn *c, uint8_t err) { if (!err) { conn_count++; k_work_submit(&adv_work); } }  /* keep advertising for a 2nd host */
static void disconnected(struct bt_conn *c, uint8_t r)
{
	if (conn_count > 0) conn_count--;
	if (conn_count == 0) idle_since = k_uptime_get_32();   /* start the 60 s advertise grace */
	k_work_submit(&adv_work);
}
BT_CONN_CB_DEFINE(conn_cb) = { .connected = connected, .disconnected = disconnected };
static void bt_ready(int e) { if (!e) k_work_submit(&adv_work); }

/* ---- Power / status LED --------------------------------------------- */
static volatile int64_t  last_beat_ms;
static volatile int64_t  last_motion_ms;   /* updated by the accelerometer when moving */
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

/* Levkov subtraction procedure for 50 Hz mains (deterministic, no ringing).
 * 50 Hz @ 500 Hz = exactly 10 samples/period (LV_M). In LINEAR segments (slow ECG,
 * low curvature) the mains over one period is estimated as sample - one-period mean
 * (the mean sums a full period so it cancels the mains, leaving the ECG), and stored
 * per phase. The stored periodic template is then subtracted from every sample --
 * including the QRS, where the template is HELD (curvature too high to update) so a
 * beat never perturbs it. Output is delayed by LV_M samples (20 ms at 500 Hz). */
#define LV_M    10
#define LV_CURV 120.0f    /* 2nd-difference-over-period (20 ms span) above this = QRS -> hold */
static float levkov(int16_t xin)
{
	static float b[2 * LV_M + 1];   /* b[0]=oldest .. b[2M]=newest */
	static float iref[LV_M];
	static uint32_t idx;
	for (int i = 0; i < 2 * LV_M; i++) b[i] = b[i + 1];
	b[2 * LV_M] = (float)xin;
	idx++;
	float centre = b[LV_M];
	float sum = 0.0f;               /* one-period (LV_M-sample) mean -> mains-free ECG estimate */
	for (int i = LV_M / 2; i < LV_M + LV_M / 2; i++) sum += b[i];
	float ecg = sum / (float)LV_M;
	float curv = b[0] - 2.0f * b[LV_M] + b[2 * LV_M];
	if (curv < 0) curv = -curv;
	uint8_t p = (uint8_t)((idx - LV_M) % LV_M);
	if (curv < LV_CURV) iref[p] = centre - ecg;   /* update template only in linear segments */
	return centre - iref[p];
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
	static float bp_z[4];
	static float spki, npki;            /* running signal / noise peak estimates */
	static float prev_energy, prev_prev_energy, cand_peak;/* local-maximum tracking (3-pt) */
	static float last_qrs_peak;         /* energy of the last accepted QRS       */
	static float last_delta;            /* last beat's sub-sample peak offset [-0.5,0.5] */
	static bool  rising;
	static uint32_t last_cyc, rr_avg_cyc, warm;
	static bool  have_last;
	/* extrasystole classification (1-beat look-ahead; only feeds the ectopy
	 * characteristic, never the HR/RR stream) */
	static uint32_t sinus_rr_ms, pend_coupling;
	static float    pend_energy, sinus_qrs;
	static uint32_t rail_recent;        /* >0 = raw ADC railed within the last RAIL_WIN samples */
	static bool     pend_prem, pend_railed;
	static float    warm_max;           /* peak energy seen during warm-up (threshold seed) */

	/* 50 Hz notch is applied up front in the sampling loop (feeding both the streamed
	 * signal and this detector), so here we only band-pass. */
	float yb = iir(BP_b, BP_a, bp_z, 5, (float)sample);
	float energy = yb * yb;

	if (warm < WARMUP_SAMPLES) {
		warm++;
		prev_energy = energy;
		/* Learn the signal scale while the front-end settles. After the first ~1 s
		 * of filter transient, track the peak energy; at the end of warm-up seed the
		 * threshold HIGH from it (a real QRS is ~this big) and let it adapt DOWN.
		 * Otherwise SPKI starts at 0, the threshold climbs up from the noise floor,
		 * and the first thing it latches onto is noise rather than a QRS. */
		if (warm > SAMPLE_HZ && energy > warm_max) warm_max = energy;
		if (warm == WARMUP_SAMPLES && warm_max > 0.0f) {
			spki = warm_max;
			npki = warm_max * 0.25f;
		}
		prev_prev_energy = prev_energy;
		return;
	}

	/* rail/saturation tracking: a contact (electrode-skin) artifact drives the raw
	 * ADC to the rails; a real QRS never does. Flag persists for RAIL_WIN samples. */
	if (sample < RAIL_LO || sample > RAIL_HI) rail_recent = RAIL_WIN;
	else if (rail_recent) rail_recent--;

	uint32_t now  = sample_idx;   /* sample index = real time, jitter-immune */
	uint32_t refr = REFRACTORY_MS * SAMPLE_HZ / 1000;   /* samples */

	/* adaptive threshold; relax toward NPKI (search-back) if a beat is overdue.
	 * "Overdue" also covers COLD START (no beat yet): a put-on/motion artifact
	 * during warm-up can seed SPKI *and* NPKI far above the real QRS, pinning the
	 * threshold so high the detector is deaf forever. So when a beat is overdue --
	 * either later than 1.66x the running RR, or (before any beat) not seen for
	 * ~1.5 s -- slowly decay BOTH peaks downward (multiplicative). The whole
	 * threshold then glides down until it re-acquires the QRS (the larger peak
	 * crosses first); a real beat instantly re-seeds the peaks. The 50-count
	 * energy floor below still blocks latching onto noise/flat off-body. */
	float k = 0.25f;
	uint32_t since = (uint32_t)(now - last_cyc);
	bool overdue = rr_avg_cyc ? (since > (uint32_t)((uint64_t)rr_avg_cyc * 166 / 100))
				  : (since > (uint32_t)(SAMPLE_HZ * 3 / 2));
	if (overdue) {
		k = 0.125f;
		spki -= spki * (1.0f / 512);   /* ~slow glide-down (tau ~1 s); self-heals a */
		npki -= npki * (1.0f / 512);   /* threshold pinned high by a warm-up artifact */
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
		uint32_t twin = TWAVE_MS * SAMPLE_HZ / 1000;   /* samples */
		bool twave = have_last && (now - last_cyc) < twin &&
			     cand_peak < TWAVE_FRAC * last_qrs_peak;
		if (!in_refr && !twave && cand_peak > thresh && cand_peak > 50.0f /* noise floor */) {
			last_beat_ms = k_uptime_get();          /* on-body indicator */
			led_on(); led_off_idx = sample_idx + LED_PULSE_N;  /* heartbeat blink */
			/* Parabolic interpolation of the energy peak (at sample now-1) for
			 * sub-sample R-peak timing: fit y[-1],y[0],y[+1] and take the vertex
			 * offset. Lifts RR resolution from the 2 ms sample period to the ~1 ms
			 * the rr_1024 wire format already carries. Near-flat peaks -> delta 0. */
			float denom = prev_prev_energy - 2.0f * prev_energy + energy;
			float delta = 0.0f;
			if (denom < -1e-3f) {
				delta = 0.5f * (prev_prev_energy - energy) / denom;
				if (delta > 0.5f) delta = 0.5f; else if (delta < -0.5f) delta = -0.5f;
			}
			if (have_last) {
				uint32_t d = now - last_cyc;
				/* refine RR with the sub-sample offsets; the integer part stays
				 * exact over long sessions, only the small fractional diff is float */
				float d_f = (float)d + (delta - last_delta);
				uint32_t rr_ms = (uint32_t)(d_f * 1000.0f / SAMPLE_HZ + 0.5f);
				if (rr_ms >= RR_MIN_MS && rr_ms <= RR_MAX_MS) {
					uint16_t rr_1024 = (uint16_t)(d_f * 1024.0f / SAMPLE_HZ + 0.5f);
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
			last_cyc = now; last_delta = delta; have_last = true;
			last_qrs_peak = cand_peak;                  /* remember QRS energy for T-wave test */
			spki = 0.125f * cand_peak + 0.875f * spki;  /* signal peak update */
		} else if (!in_refr) {
			npki = 0.125f * cand_peak + 0.875f * npki;  /* noise peak update  */
		}
		cand_peak = 0.0f;
	}
	prev_prev_energy = prev_energy;
	prev_energy = energy;
}

/* ---- SC7A20 accelerometer: motion-wake (I2C bit-bang, SCL=P0.16, SDA=P0.18,
 * addr 0x19). Its INT1 pin is wired to nRF P0.14 (active-high). We arm a
 * double-tap (two-knock) interrupt, then sleep in System OFF and wake via the
 * P0.14 GPIO SENSE -> true ~µA deep sleep, a deliberate double-knock wakes it
 * (bag/pocket jostling does not). */
#define ACC_SCL 16
#define ACC_SDA 18
#define ACC_ADDR 0x19
#define ACC_INT_PIN 14
#define AD() k_busy_wait(3)   /* I2C half-bit ~200 kHz: the accel read fits the 500 Hz loop budget */
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

/* The accelerometer is optional (some HW variants omit it). Detect it by whether
 * it ACKs its I2C address, so we can skip accel work and, crucially, pick a wake
 * source that still works without it. */
static bool accel_present;
static bool acc_detect(void)
{
	a_scl_hi(); a_sda_hi(); k_busy_wait(50);
	a_st();
	int ack = a_wrb((ACC_ADDR << 1) | 0);   /* 1 = device ACKed its address */
	a_sp();
	return ack != 0;
}

/* Double-tap ("knock-knock") wake tuning. The SC7A20 CLICK engine looks for TWO
 * taps inside a time window, so random bag/pocket jostling (continuous, never a
 * clean two-tap pattern) will NOT wake the strap; only a deliberate double-knock
 * does. Timings are in 1/ODR units (ODR 100 Hz -> 1 unit = 10 ms); threshold is
 * in 16 mg LSB at +/-2g. Tune here if knocks are missed (lower THS) or jostling
 * still wakes it (raise THS / shrink TWIN). */
/* Timings are in 1/ODR units. ODR is 400 Hz (CTRL1 0x77) -> 1 unit = 2.5 ms:
 * the 100 Hz / 10 ms resolution was too coarse for reliable double-click pairing. */
#define TAP_THS_CNT  0x10   /* ~0.25 g: catch a gentle finger knock (lowered: woke too hard) */
#define TAP_TLIM     0x0E   /* ~35 ms: max over-threshold time per tap -- still SHARP, so */
                            /*         a sustained shake (longer over-threshold) is rejected */
#define TAP_TLAT     0x0C   /* ~30 ms: dead time after the first tap (skip its ring)     */
#define TAP_TWIN     0xFF   /* ~640 ms: generous window to receive the second tap        */

/* Fallback: the original any-axis motion INT (~290 mg, no min duration). Used
 * only if the CLICK engine is absent on this accel (see accel_init_tap_wake). */
static void accel_arm_motion_int(void)
{
	acc_wr(0x21, 0x01);   /* CTRL2: HPIS1 = high-pass filter on INT1 (removes gravity) */
	acc_wr(0x22, 0x40);   /* CTRL3: I1_IA1 -> INT1 pin */
	acc_wr(0x24, 0x08);   /* CTRL5: latch INT1 */
	acc_wr(0x32, 0x12);   /* INT1_THS: motion threshold (~290 mg dynamic) */
	acc_wr(0x33, 0x00);   /* INT1_DURATION = 0 */
	(void)acc_rd(0x26);   /* dummy read REFERENCE: reset the HP filter */
	acc_wr(0x30, 0x2A);   /* INT1_CFG: OR of XH|YH|ZH (any-axis MOTION) */
	(void)acc_rd(0x31);   /* clear latch */
}

/* True once arming confirmed the CLICK engine is present; drives which SRC
 * register enter_deep_sleep() clears before re-arming the GPIO SENSE wake. */
static bool tap_wake_active;

/* Arm the SC7A20 for DOUBLE-TAP wake: a two-knock pattern pulses INT1 (P0.14),
 * which the nRF GPIO SENSE turns into a System-OFF wake. The config persists
 * while the accel stays powered, and is re-armed on every boot.
 *
 * The SC7A20 is a LIS2DH clone; not every clone implements the CLICK engine, and
 * this one does NOT support the LIR_Click latch bit (CLICK_THS bit7 reads back 0).
 * So we confirm the engine by reading back only the threshold bits [6:0]; if those
 * do not hold, the engine is absent and we fall back to the any-motion INT so the
 * strap stays wakeable (any motion) instead of becoming un-wakeable from sleep.
 * We arm click NON-latched: INT1 pulses for the latency window on a double-tap,
 * which the nRF GPIO SENSE still captures as a System-OFF wake. */
static void accel_init_tap_wake(void)
{
	a_scl_hi(); a_sda_hi(); k_msleep(5);
	acc_wr(0x20, 0x77);   /* CTRL1: 400Hz, XYZ on (fine timing for double-click) */
	acc_wr(0x23, 0x08);   /* CTRL4: HR, +/-2g */

	acc_wr(0x3A, TAP_THS_CNT);         /* CLICK_THS: threshold (no LIR; clone ignores bit7) */
	if ((acc_rd(0x3A) & 0x7F) != TAP_THS_CNT) {   /* CLICK engine not present */
		tap_wake_active = false;
		accel_arm_motion_int();
		return;
	}
	acc_wr(0x21, 0x04);   /* CTRL2: HPCLICK = high-pass the click path (removes gravity) */
	acc_wr(0x22, 0x80);   /* CTRL3: I1_CLICK -> INT1 pin */
	acc_wr(0x24, 0x00);   /* CTRL5: no INT1 latch (non-latched click pulse) */
	acc_wr(0x3B, TAP_TLIM);            /* TIME_LIMIT   */
	acc_wr(0x3C, TAP_TLAT);            /* TIME_LATENCY */
	acc_wr(0x3D, TAP_TWIN);            /* TIME_WINDOW  */
	(void)acc_rd(0x26);   /* dummy read REFERENCE: reset the HP filter */
	acc_wr(0x38, 0x2A);   /* CLICK_CFG: double-click only on X|Y|Z (ZD|YD|XD) */
	(void)acc_rd(0x39);   /* clear CLICK_SRC latch */
	tap_wake_active = true;
}

static void enter_deep_sleep(void)
{
	bt_le_adv_stop();
	led_off();
	if (accel_present) {
		/* double-tap wake: the SC7A20 INT1 on P0.14 goes high on a double-knock.
		 * (If the CLICK engine was absent we fell back to the motion INT: clear
		 * its INT1_SRC instead.) */
		(void)acc_rd(tap_wake_active ? 0x39 : 0x31);   /* clear pending SRC so P0.14 is low */
		nrf_gpio_cfg_sense_input(ACC_INT_PIN, NRF_GPIO_PIN_NOPULL, NRF_GPIO_PIN_SENSE_HIGH);
	} else {
		/* no accel -> no motion-INT wake source. Pull the floating accel-INT pin low
		 * so it cannot spuriously wake us. On the standard board, wake on WEAR
		 * instead: P0.12 (AFE on-body/contact) goes high when the belt is put on.
		 * (On HW_DIFF, P0.12 is the LED and the accel is always present, so this
		 * branch isn't taken; there is no contact-pin wake source.) */
		nrf_gpio_cfg_input(ACC_INT_PIN, NRF_GPIO_PIN_PULLDOWN);
#if !HW_DIFF
		nrf_gpio_cfg_sense_input(CONTACT_PIN, NRF_GPIO_PIN_NOPULL, NRF_GPIO_PIN_SENSE_HIGH);
#endif
	}
	k_msleep(2);
	sys_poweroff();       /* System OFF; motion (P0.14) or wear (P0.12) wakes -> reboot */
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
	if (hp > MOTION_THR || -hp > MOTION_THR) last_motion_ms = now;   /* "moving" for power mgmt */
	if (armed && hp > 3000 && (now - last_ms) > 300) {   /* step: peak + 300ms refractory */
		step_count++; armed = false; last_ms = now;
	} else if (hp < 1500) {
		armed = true;
	}
}

/* Accelerometer thread (25 Hz), decoupled from the 500 Hz sampling loop.
 * The bit-bang I2C read is a ~1-3 ms busy-wait that used to block the loop and
 * cap the effective rate at ~320 Hz. Here it runs at a lower priority (5) than
 * the sampling loop (0), so the loop's timer tick preempts it mid-transaction;
 * the bit-bang I2C clock phase simply stretches across the preemption, which the
 * SC7A20 tolerates (the master drives the clock, a paused clock is harmless).
 * step_update keeps last_motion_ms fresh for the power state machine. */
static volatile bool accel_ready;
static void accel_thread_fn(void *a, void *b, void *c)
{
	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);
	static uint8_t acc_batch[1 + ACC_BATCH * 6 + 2];
	uint8_t acc_n = 0;
	while (!accel_ready) k_msleep(20);
	if (!accel_present) return;   /* no accelerometer on this HW variant */
	for (;;) {
		int16_t xyz[3];
		if (acc_read6(xyz)) {
			step_update(xyz[0], xyz[1], xyz[2]);
			/* batch ACC_BATCH samples into one notify (25 Hz -> 5/s): fewer
			 * packets + less TX-queue pressure. Layout (LE): u8 n, then
			 * n x (int16 x,y,z) oldest first, then u16 steps of the last. */
			if (accs_ccc) {
				uint8_t *s = &acc_batch[1 + acc_n * 6];
				sys_put_le16(xyz[0], &s[0]);
				sys_put_le16(xyz[1], &s[2]);
				sys_put_le16(xyz[2], &s[4]);
				if (++acc_n >= ACC_BATCH) {
					acc_batch[0] = acc_n;
					sys_put_le16(step_count, &acc_batch[1 + acc_n * 6]);
					tx_enqueue(TX_ACCEL, acc_batch, 1 + acc_n * 6 + 2);
					acc_n = 0;
				}
			} else {
				acc_n = 0;
			}
		}
		k_msleep(40);   /* ~25 Hz */
	}
}
K_THREAD_DEFINE(accel_tid, 640, accel_thread_fn, NULL, NULL, NULL, 5, 0, 0);

#if !HW_DIFF
/* True if P0.12 reads on-body for >75% of a ~win_ms window (read-only, no ADC).
 * Kept for diagnostics / future use (the connection-driven loop no longer calls it). */
static bool __maybe_unused onbody_held(int win_ms)
{
	int hi = 0, n = win_ms / 10;
	if (n < 1) n = 1;
	for (int i = 0; i < n; i++) { if (nrf_gpio_pin_read(CONTACT_PIN)) hi++; k_msleep(10); }
	return hi * 4 > n * 3;
}
#endif

/* Drain one filled ADC buffer: average OVERSAMPLE raw samples -> 500 Hz samples,
 * run Levkov 50 Hz notch -> detector -> optional HP-compensation -> BLE stream.
 * Filter/stream state is static (one ECG stream at a time); it simply re-settles
 * (~7 s) when sampling resumes after a gap, which the app discards as warm-up. */
static void process_adc_buffer(const nrf_saadc_value_t *buf)
{
	static uint8_t raw_buf[2 + RAW_BATCH * 2];
	static uint16_t seq;
	static int rn;
#if HP_COMP
	static float hp_y, hp_xp, hpf_y, hpf_xp;
#endif
	for (int i = 0; i < ADC_BUF_SMP; i += OVERSAMPLE) {
		int32_t acc = 0;
		for (int j = 0; j < OVERSAMPLE; j++) acc += buf[i + j];
		int16_t raw = (int16_t)(acc / OVERSAMPLE);   /* 12-bit range preserved */
#if HW_DIFF
		raw = (int16_t)(-raw);   /* differential AFE output is inverted (R points down) */
#endif
		float lv = levkov(raw);
		lv = CLAMP(lv + (lv >= 0 ? 0.5f : -0.5f), -32768.0f, 32767.0f);
		int16_t ns = (int16_t)lv;

		detector_feed(ns);   /* detector runs on the uncompensated signal */

		sample_idx++;
		if (led_off_idx && sample_idx >= led_off_idx) { led_off(); led_off_idx = 0; }

#if HP_COMP
		float hp_x = (float)ns;
		float s1;
		if (g_hp_flags & HP_FLAG_SHELF) {
			hp_y = g_hp_a * hp_y + hp_x - g_hp_b * hp_xp;
			s1 = hp_y;
		} else {
			s1 = hp_x;
		}
		hp_xp = hp_x;
		float s2;
		if (g_hp_flags & HP_FLAG_HPF) {
			hpf_y = g_hpf_c * (hpf_y + s1 - hpf_xp);
			s2 = hpf_y;
		} else {
			s2 = s1;
		}
		hpf_xp = s1;
		int16_t out = (int16_t)CLAMP(s2 + (s2 >= 0 ? 0.5f : -0.5f), -32768.0f, 32767.0f);
#else
		int16_t out = ns;
#endif
		sys_put_le16((uint16_t)out, &raw_buf[2 + rn * 2]);
		if (++rn >= RAW_BATCH) {
			sys_put_le16(seq++, &raw_buf[0]);
			if (cap_ccc) tx_enqueue(TX_ECG, raw_buf, sizeof(raw_buf));
			rn = 0;
		}
	}
}

/* Start / stop hardware-timed continuous ECG sampling (advanced mode, 8 kHz
 * internal timer -> DMA). Gated on an active BLE connection so the ADC + AFE
 * DSP draw nothing while merely advertising. Re-configuring the channel each
 * start is fine: the blocking VDD read already reconfigures the SAADC. */
static volatile bool ecg_running;
static void ecg_start(void)
{
	if (ecg_running) return;
	nrfx_saadc_adv_config_t adv = NRFX_SAADC_DEFAULT_ADV_CONFIG;
	adv.internal_timer_cc = ADC_TIMER_CC;   /* 16 MHz / 8 kHz = 2000 */
	adv.start_on_end      = true;           /* HW re-arms DMA into the next buffer */
	if (nrfx_saadc_channel_config(&ecg_channel) != 0 ||
	    nrfx_saadc_advanced_mode_set(BIT(0), NRF_SAADC_RESOLUTION_12BIT, &adv,
					 saadc_handler) != 0) {
		LOG_ERR("saadc ECG start failed");
		return;
	}
	nrfx_saadc_buffer_set(adc_bufs[0], ADC_BUF_SMP);
	nrfx_saadc_offset_calibrate(saadc_handler);   /* -> CALIBRATEDONE -> trigger: sampling starts */
	ecg_running = true;
}
static void ecg_stop(void)
{
	if (!ecg_running) return;
	nrfx_saadc_abort();
	ecg_running = false;
	k_msleep(2);                  /* let the abort's final DONE settle before draining */
	nrf_saadc_value_t *p;
	while (k_msgq_get(&adc_doneq, &p, K_NO_WAIT) == 0) { }   /* drop stale buffers */
}

int main(void)
{
	LOG_INF("HRM raw-RR+ECG firmware boot");

	nrf_gpio_cfg_output(LED_PIN);
#if !HW_DIFF
	/* P0.12 is the AFE's lead-off/contact status (high=on-body); it self-gates the
	 * AFE. READ it, never drive it — driving it high forced the AFE on off-body and
	 * made the front end oscillate. Off-body it goes low -> AFE off -> no oscillation.
	 * (On HW_DIFF, P0.12 is the LED output configured just above.) */
	nrf_gpio_cfg_input(CONTACT_PIN, NRF_GPIO_PIN_NOPULL);
#endif
	for (int i = 0; i < 2; i++) { led_on(); k_msleep(60); led_off(); k_msleep(120); } /* wake blink */

	accel_present = acc_detect();
	if (accel_present) accel_init_tap_wake();   /* arm SC7A20 double-tap INT -> P0.14 wake */
	accel_ready = true;        /* release the accel thread (it exits if no accel) */

	/* Keep HFXO (16 MHz crystal) running so the SAADC internal sample timer is
	 * crystal-accurate: the BLE stack only requests HFXO around radio events,
	 * leaving HFCLK on the internal RC (~few % off) in between -- which would
	 * detune the 8 kHz sample clock and break the Levkov exact-50 Hz assumption. */
	{
		const struct device *clk = DEVICE_DT_GET_ONE(nordic_nrf_clock);
		if (device_is_ready(clk)) clock_control_on(clk, CLOCK_CONTROL_NRF_SUBSYS_HF);
	}

	/* SAADC: connect IRQ, init, read battery once, then (below) start continuous
	 * hardware-timed ECG sampling. */
	IRQ_CONNECT(DT_IRQN(DT_NODELABEL(adc)), DT_IRQ(DT_NODELABEL(adc), priority),
		    nrfx_isr, nrfx_saadc_irq_handler, 0);
	if (nrfx_saadc_init(DT_IRQ(DT_NODELABEL(adc), priority)) != 0) {
		LOG_ERR("saadc init failed");
		return -1;
	}
	battery_update_mv(adc_read_vdd_mv());   /* one-shot VDD read per wake */

	dev_name_init();   /* build "Govinda-XXXX" into dev_name + ad[2] before advertising */
	if (bt_enable(bt_ready)) {
		LOG_ERR("bt_enable failed");
		return -1;
	}
	bt_set_name(dev_name);   /* keep the GAP Device Name characteristic consistent with adv */
	k_work_init_delayable(&tx_dwork, tx_work_fn);

	/* ---- Power lifecycle: a BLE connection drives sleep/wake ---------------
	 * The on-body check is OUT of the sleep/wake logic. On wake we advertise
	 * immediately; the connection state decides everything from there. */
	last_beat_ms   = k_uptime_get();
	last_motion_ms = k_uptime_get();
#if HW_DIFF
	/* HW_DIFF (accel-equipped): ECG samples only while a central is connected.
	 *   wake -> advertise; nobody connects within PROBATION_MS -> sleep
	 *   connected  -> stream, never sleep while connected
	 *   disconnect -> keep advertising PROBATION_MS, then        -> sleep
	 * A double-tap on the SC7A20 (INT1 -> P0.14) wakes from System OFF. */
	idle_since = k_uptime_get_32();
	for (;;) {
		/* ADVERTISE: idle, waiting for a connection (~0.5 Hz LED blink). */
		while (conn_count == 0) {
			if ((uint32_t)(k_uptime_get_32() - idle_since) > PROBATION_MS)
				enter_deep_sleep();   /* no connection in time -> System OFF */
			led_on(); k_msleep(60); led_off(); k_msleep(1940);
		}
		/* STREAM: connected -> run the ADC and drain buffers until disconnect.
		 * The 100 ms get timeout lets us notice a disconnect promptly. */
		ecg_start();
		while (conn_count > 0) {
			nrf_saadc_value_t *buf;
			if (k_msgq_get(&adc_doneq, &buf, K_MSEC(100)) == 0)
				process_adc_buffer(buf);
		}
		ecg_stop();   /* disconnected() has armed the grace window via idle_since */
	}
#else
	/* Standard board (no accel): same connection-driven lifecycle as HW_DIFF,
	 * but the wake source is the P0.12 on-body signal (armed in enter_deep_sleep)
	 * instead of a double-tap -- it wakes when put on.
	 *
	 * We woke because on-body went high, so first give the AFE its ~5 s pull-up
	 * assist to latch on (as before), then advertise + stream-on-connect.
	 *
	 * Sleep is gated on OFF-body here, NOT on a pure no-connection timer: the
	 * on-body wake is level-sensitive, so sleeping while still worn (P0.12 high)
	 * would wake us again instantly. So: worn -> stay up (advertise/stream);
	 * taken off + no connection for PROBATION_MS -> sleep (and a fresh put-on
	 * wakes it). Connected -> never sleep, exactly like HW_DIFF. */
	nrf_gpio_cfg_input(CONTACT_PIN, NRF_GPIO_PIN_PULLUP);   /* AFE latch assist, NOT a drive */
	for (int64_t a0 = k_uptime_get(); k_uptime_get() - a0 < ASSIST_MS; ) {
		led_on(); k_msleep(100); led_off(); k_msleep(400);
	}
	nrf_gpio_cfg_input(CONTACT_PIN, NRF_GPIO_PIN_NOPULL);   /* back to read-only */

	int64_t offbody_since = 0;   /* when we last went off-body while not connected */
	for (;;) {
		/* ADVERTISE: idle. Sleep only after PROBATION_MS continuously OFF-body. */
		while (conn_count == 0) {
			if (nrf_gpio_pin_read(CONTACT_PIN)) {
				offbody_since = 0;                 /* worn -> stay up */
			} else {
				if (offbody_since == 0) offbody_since = k_uptime_get();
				if (k_uptime_get() - offbody_since > PROBATION_MS)
					enter_deep_sleep();        /* off-body 1 min -> System OFF */
			}
			led_on(); k_msleep(60); led_off(); k_msleep(1940);
		}
		/* STREAM: connected -> run the ADC until disconnect. */
		offbody_since = 0;
		ecg_start();
		while (conn_count > 0) {
			nrf_saadc_value_t *buf;
			if (k_msgq_get(&adc_doneq, &buf, K_MSEC(100)) == 0)
				process_adc_buffer(buf);
		}
		ecg_stop();
	}
#endif
}
