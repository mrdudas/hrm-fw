/* Silan SC7A20 (LIS3DH-compatible) live accel reader on the strap.
 * Bit-bang I2C: SCL=P0.16, SDA=P0.18, address 0x19. Streams raw X/Y/Z (int16)
 * over a custom BLE notify characteristic. */
#include <zephyr/kernel.h>
#include <zephyr/sys/util.h>
#include <zephyr/sys/byteorder.h>
#include <hal/nrf_gpio.h>
#include <zephyr/bluetooth/bluetooth.h>
#include <zephyr/bluetooth/conn.h>
#include <zephyr/bluetooth/uuid.h>
#include <zephyr/bluetooth/gatt.h>

#define SCL 16
#define SDA 18
#define ADDR 0x19
#define DLY() k_busy_wait(6)
static inline void scl_hi(void){ nrf_gpio_cfg_input(SCL, NRF_GPIO_PIN_PULLUP); }
static inline void scl_lo(void){ nrf_gpio_pin_clear(SCL); nrf_gpio_cfg_output(SCL); }
static inline void sda_hi(void){ nrf_gpio_cfg_input(SDA, NRF_GPIO_PIN_PULLUP); }
static inline void sda_lo(void){ nrf_gpio_pin_clear(SDA); nrf_gpio_cfg_output(SDA); }
static inline int  sda_rd(void){ return nrf_gpio_pin_read(SDA); }
static void i2c_start(void){ sda_hi(); scl_hi(); DLY(); sda_lo(); DLY(); scl_lo(); DLY(); }
static void i2c_stop(void){ sda_lo(); DLY(); scl_hi(); DLY(); sda_hi(); DLY(); }
static int i2c_wr(uint8_t b){
	for (int i=0;i<8;i++){ (b&0x80)?sda_hi():sda_lo(); DLY(); scl_hi(); DLY(); scl_lo(); DLY(); b<<=1; }
	sda_hi(); DLY(); scl_hi(); DLY(); int ack=(sda_rd()==0); scl_lo(); DLY(); return ack;
}
static uint8_t i2c_rd(int ack){
	uint8_t v=0; sda_hi();
	for(int i=0;i<8;i++){ v<<=1; scl_hi(); DLY(); if(sda_rd())v|=1; scl_lo(); DLY(); }
	ack?sda_lo():sda_hi(); DLY(); scl_hi(); DLY(); scl_lo(); DLY(); sda_hi(); return v;
}
static void wr(uint8_t reg, uint8_t val){ i2c_start(); i2c_wr((ADDR<<1)|0); i2c_wr(reg); i2c_wr(val); i2c_stop(); }
static int rd(uint8_t reg, uint8_t *buf, int n){
	i2c_start(); if(!i2c_wr((ADDR<<1)|0)){i2c_stop();return 0;}
	i2c_wr(reg|0x80); /* auto-increment */
	i2c_start(); if(!i2c_wr((ADDR<<1)|1)){i2c_stop();return 0;}
	for(int i=0;i<n;i++) buf[i]=i2c_rd(i<n-1);
	i2c_stop(); return 1;
}

static uint8_t ccc;
static void ccc_cb(const struct bt_gatt_attr *a, uint16_t v){ ccc = (v==BT_GATT_CCC_NOTIFY); }
#define SVC BT_UUID_128_ENCODE(0xa1b30001,0,0x1000,0x8000,0x00805f9b34fb)
#define CHR BT_UUID_128_ENCODE(0xa1b30002,0,0x1000,0x8000,0x00805f9b34fb)
static struct bt_uuid_128 su=BT_UUID_INIT_128(SVC), cu=BT_UUID_INIT_128(CHR);
BT_GATT_SERVICE_DEFINE(accel_svc,
	BT_GATT_PRIMARY_SERVICE(&su),
	BT_GATT_CHARACTERISTIC(&cu.uuid, BT_GATT_CHRC_NOTIFY, BT_GATT_PERM_NONE, NULL, NULL, NULL),
	BT_GATT_CCC(ccc_cb, BT_GATT_PERM_READ|BT_GATT_PERM_WRITE));
static const struct bt_data ad[]={
	BT_DATA_BYTES(BT_DATA_FLAGS,(BT_LE_AD_GENERAL|BT_LE_AD_NO_BREDR)),
	BT_DATA(BT_DATA_NAME_COMPLETE,"HRM Accel",9) };
static void adv(struct k_work *w){ bt_le_adv_start(BT_LE_ADV_CONN_FAST_1,ad,ARRAY_SIZE(ad),NULL,0); }
static K_WORK_DEFINE(advw,adv);
static void disc(struct bt_conn*c,uint8_t r){ k_work_submit(&advw); }
BT_CONN_CB_DEFINE(cb)={.disconnected=disc};
static void ready(int e){ if(!e) k_work_submit(&advw); }

int main(void)
{
	scl_hi(); sda_hi(); k_msleep(20);
	/* SC7A20 / LIS3DH init: CTRL_REG1=0x57 (100Hz, XYZ on), CTRL_REG4=0x08 (HR, +/-2g) */
	wr(0x20, 0x57);
	wr(0x23, 0x08);
	uint8_t who=0; rd(0x0F,&who,1);          /* expect 0x11 */
	bt_enable(ready);
	uint8_t buf[6];
	while (1) {
		int16_t v[4];
		if (rd(0x28, buf, 6)) {
			v[0]=(int16_t)(buf[1]<<8|buf[0]);
			v[1]=(int16_t)(buf[3]<<8|buf[2]);
			v[2]=(int16_t)(buf[5]<<8|buf[4]);
			v[3]=who;                        /* stash WHO_AM_I in 4th slot */
			if (ccc) bt_gatt_notify(NULL, &accel_svc.attrs[2], v, sizeof(v));
		}
		k_msleep(50);   /* ~20 Hz */
	}
}
