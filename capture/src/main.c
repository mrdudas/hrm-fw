/*
 * Raw ADC capture firmware — streams the heartbeat electrode signal over BLE
 * so we can SEE the waveform and design the right QRS detector (wavelet /
 * matched filter) from real data instead of guessing.
 *
 * Samples AIN3 (P0.05 / ball F6) at SAMPLE_HZ, batches BATCH samples into one
 * notification on a custom characteristic, with a 16-bit sequence counter so
 * dropped packets are detectable.
 */
#include <zephyr/kernel.h>
#include <zephyr/drivers/adc.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/logging/log.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/bluetooth/gatt.h>

LOG_MODULE_REGISTER(cap, LOG_LEVEL_INF);

#define SAMPLE_HZ 250
#define BATCH     20            /* 20 * int16 = 40 bytes + 2 seq = 42 (< MTU) */

static const struct adc_dt_spec adc_ch = ADC_DT_SPEC_GET(DT_PATH(zephyr_user));
static int16_t adc_raw;
static struct adc_sequence adc_seq = {
	.buffer = &adc_raw, .buffer_size = sizeof(adc_raw),
};

/* Custom capture service: 0xFExx-based 128-bit UUID */
#define CAP_SVC_UUID BT_UUID_128_ENCODE(0xa1b20001,0x0000,0x1000,0x8000,0x00805f9b34fb)
#define CAP_CHR_UUID BT_UUID_128_ENCODE(0xa1b20002,0x0000,0x1000,0x8000,0x00805f9b34fb)
static struct bt_uuid_128 cap_svc = BT_UUID_INIT_128(CAP_SVC_UUID);
static struct bt_uuid_128 cap_chr = BT_UUID_INIT_128(CAP_CHR_UUID);

static uint8_t notify_on;
static void ccc_changed(const struct bt_gatt_attr *a, uint16_t v) { notify_on = (v == BT_GATT_CCC_NOTIFY); }

BT_GATT_SERVICE_DEFINE(cap_service,
	BT_GATT_PRIMARY_SERVICE(&cap_svc),
	BT_GATT_CHARACTERISTIC(&cap_chr.uuid, BT_GATT_CHRC_NOTIFY,
			       BT_GATT_PERM_NONE, NULL, NULL, NULL),
	BT_GATT_CCC(ccc_changed, BT_GATT_PERM_READ | BT_GATT_PERM_WRITE),
);

static const struct bt_data ad[] = {
	BT_DATA_BYTES(BT_DATA_FLAGS, (BT_LE_AD_GENERAL | BT_LE_AD_NO_BREDR)),
	BT_DATA(BT_DATA_NAME_COMPLETE, "HRM Capture", 11),
};

static void adv_work_fn(struct k_work *w)
{
	int e = bt_le_adv_start(BT_LE_ADV_CONN_FAST_1, ad, ARRAY_SIZE(ad), NULL, 0);
	LOG_INF("adv %s", e ? "FAIL" : "on");
}
static K_WORK_DEFINE(adv_work, adv_work_fn);
static void disconnected(struct bt_conn *c, uint8_t r) { k_work_submit(&adv_work); }
BT_CONN_CB_DEFINE(cb) = { .disconnected = disconnected };
static void bt_ready(int e) { if (!e) k_work_submit(&adv_work); }

static K_SEM_DEFINE(tick_sem, 0, 1);
static void tick(struct k_timer *t) { k_sem_give(&tick_sem); }
static K_TIMER_DEFINE(timer, tick, NULL);

int main(void)
{
	uint8_t buf[2 + BATCH * 2];
	uint16_t seq = 0;
	int n = 0;

	if (!adc_is_ready_dt(&adc_ch) || adc_channel_setup_dt(&adc_ch)) {
		LOG_ERR("adc setup failed");
		return -1;
	}
	adc_sequence_init_dt(&adc_ch, &adc_seq);
	if (bt_enable(bt_ready)) {
		LOG_ERR("bt_enable failed");
		return -1;
	}
	k_timer_start(&timer, K_NO_WAIT, K_USEC(1000000 / SAMPLE_HZ));

	while (1) {
		k_sem_take(&tick_sem, K_FOREVER);
		if (adc_read_dt(&adc_ch, &adc_seq) != 0) {
			continue;
		}
		sys_put_le16((uint16_t)adc_raw, &buf[2 + n * 2]);
		if (++n >= BATCH) {
			sys_put_le16(seq++, &buf[0]);
			if (notify_on) {
				bt_gatt_notify(NULL, &cap_service.attrs[2], buf, sizeof(buf));
			}
			n = 0;
		}
	}
}
