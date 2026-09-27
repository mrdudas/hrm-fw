/* Bit-bang I2C pin+address scanner for the nRF52805 strap.
 * Sweeps candidate SCL/SDA pin pairs, probes every 7-bit address, and for each
 * ACKing device reads a few common WHO_AM_I registers (ST=0x0F, InvenSense=0x75,
 * plus 0x00). Results land in the g_* globals in RAM; read them over SWD:
 *   pyocd cmd -t nrf52 -c halt -c "read32 <addr of g_magic> ..."
 * Open-drain emulated with the nRF internal pull-ups (real bus also has them). */
#include <zephyr/kernel.h>
#include <zephyr/sys/util.h>
#include <hal/nrf_gpio.h>

/* candidate GPIOs (exclude xtal P0.00/01, LED P0.04, ECG P0.05, RESET P0.21) */
static const uint8_t CAND[] = { 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20 };

struct hit { uint8_t scl, sda, addr, r0f, r75, r00; };
volatile struct hit g_found[16];
volatile uint32_t   g_nfound;
volatile uint32_t   g_magic;      /* 0xC0FFEE00 | nfound when done */

static uint32_t SCL, SDA;
#define DLY() k_busy_wait(6)
static inline void scl_hi(void){ nrf_gpio_cfg_input(SCL, NRF_GPIO_PIN_PULLUP); }
static inline void scl_lo(void){ nrf_gpio_pin_clear(SCL); nrf_gpio_cfg_output(SCL); }
static inline void sda_hi(void){ nrf_gpio_cfg_input(SDA, NRF_GPIO_PIN_PULLUP); }
static inline void sda_lo(void){ nrf_gpio_pin_clear(SDA); nrf_gpio_cfg_output(SDA); }
static inline int  sda_rd(void){ return nrf_gpio_pin_read(SDA); }

static void i2c_start(void){ sda_hi(); scl_hi(); DLY(); sda_lo(); DLY(); scl_lo(); DLY(); }
static void i2c_stop(void){ sda_lo(); DLY(); scl_hi(); DLY(); sda_hi(); DLY(); }
static int i2c_wr(uint8_t b){
	for (int i = 0; i < 8; i++) { (b & 0x80) ? sda_hi() : sda_lo(); DLY();
		scl_hi(); DLY(); scl_lo(); DLY(); b <<= 1; }
	sda_hi(); DLY(); scl_hi(); DLY(); int ack = (sda_rd() == 0); scl_lo(); DLY();
	return ack;
}
static uint8_t i2c_rd(int ack){
	uint8_t v = 0; sda_hi();
	for (int i = 0; i < 8; i++) { v <<= 1; scl_hi(); DLY(); if (sda_rd()) v |= 1; scl_lo(); DLY(); }
	ack ? sda_lo() : sda_hi(); DLY(); scl_hi(); DLY(); scl_lo(); DLY(); sda_hi();
	return v;
}
static int probe(uint8_t a){ i2c_start(); int k = i2c_wr((a << 1) | 0); i2c_stop(); return k; }
static int rdreg(uint8_t a, uint8_t reg, uint8_t *v){
	i2c_start(); if (!i2c_wr((a << 1) | 0)) { i2c_stop(); return 0; }
	i2c_wr(reg);
	i2c_start(); if (!i2c_wr((a << 1) | 1)) { i2c_stop(); return 0; }
	*v = i2c_rd(0); i2c_stop(); return 1;
}

int main(void)
{
	k_msleep(50);
	for (unsigned si = 0; si < ARRAY_SIZE(CAND); si++) {
		for (unsigned di = 0; di < ARRAY_SIZE(CAND); di++) {
			if (si == di) continue;
			SCL = CAND[si]; SDA = CAND[di];
			scl_hi(); sda_hi(); k_busy_wait(50);

			uint8_t acks[8]; int n = 0, total = 0;
			for (uint8_t a = 0x08; a <= 0x77; a++) {
				if (probe(a)) { total++; if (n < 8) acks[n++] = a; }
			}
			/* real device ACKs on 1-3 addresses; a stuck-low line ACKs all */
			if (total >= 1 && total <= 3) {
				for (int k = 0; k < n && g_nfound < ARRAY_SIZE(g_found); k++) {
					uint8_t a = acks[k], v;
					volatile struct hit *h = &g_found[g_nfound++];
					h->scl = SCL; h->sda = SDA; h->addr = a;
					h->r0f = rdreg(a, 0x0F, &v) ? v : 0xEE;
					h->r75 = rdreg(a, 0x75, &v) ? v : 0xEE;
					h->r00 = rdreg(a, 0x00, &v) ? v : 0xEE;
				}
			}
			nrf_gpio_cfg_input(SCL, NRF_GPIO_PIN_NOPULL);
			nrf_gpio_cfg_input(SDA, NRF_GPIO_PIN_NOPULL);
		}
	}
	g_magic = 0xC0FFEE00u | (g_nfound & 0xFF);
	while (1) { k_msleep(1000); }
}
