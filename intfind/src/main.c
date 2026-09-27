/* Find the SC7A20 INT pin: configure the accel to latch INT1 on motion, then
 * watch which nRF GPIO tracks the interrupt (agree count high). Shake the strap
 * intermittently during the ~15 s run. Results in g_* globals, read over SWD. */
#include <zephyr/kernel.h>
#include <zephyr/sys/util.h>
#include <hal/nrf_gpio.h>

#define SCL 16
#define SDA 18
#define ADDR 0x19
#define DLY() k_busy_wait(6)
static inline void scl_hi(void){ nrf_gpio_cfg_input(SCL, NRF_GPIO_PIN_PULLUP); }
static inline void scl_lo(void){ nrf_gpio_pin_clear(SCL); nrf_gpio_cfg_output(SCL); }
static inline void sda_hi(void){ nrf_gpio_cfg_input(SDA, NRF_GPIO_PIN_PULLUP); }
static inline void sda_lo(void){ nrf_gpio_pin_clear(SDA); nrf_gpio_cfg_output(SDA); }
static inline int  sda_rd(void){ return nrf_gpio_pin_read(SDA); }
static void st(void){ sda_hi(); scl_hi(); DLY(); sda_lo(); DLY(); scl_lo(); DLY(); }
static void sp(void){ sda_lo(); DLY(); scl_hi(); DLY(); sda_hi(); DLY(); }
static int wrb(uint8_t b){ for(int i=0;i<8;i++){(b&0x80)?sda_hi():sda_lo();DLY();scl_hi();DLY();scl_lo();DLY();b<<=1;} sda_hi();DLY();scl_hi();DLY();int a=(sda_rd()==0);scl_lo();DLY();return a; }
static uint8_t rdb(int ack){ uint8_t v=0;sda_hi();for(int i=0;i<8;i++){v<<=1;scl_hi();DLY();if(sda_rd())v|=1;scl_lo();DLY();}ack?sda_lo():sda_hi();DLY();scl_hi();DLY();scl_lo();DLY();sda_hi();return v; }
static void awr(uint8_t r,uint8_t v){ st();wrb((ADDR<<1)|0);wrb(r);wrb(v);sp(); }
static uint8_t ard(uint8_t r){ st();wrb((ADDR<<1)|0);wrb(r);st();wrb((ADDR<<1)|1);uint8_t v=rdb(0);sp();return v; }

static const uint8_t CAND[] = { 2,3,6,7,8,9,10,11,12,13,14,15,17,19,20 };
volatile uint32_t g_agree[16], g_dis[16], g_total, g_iacount, g_done, g_ncand;

int main(void)
{
	scl_hi(); sda_hi(); k_msleep(20);
	/* SC7A20 motion INT on INT1, latched, any-axis high event */
	awr(0x20, 0x57);   /* 100Hz, XYZ */
	awr(0x23, 0x08);   /* HR, +/-2g */
	awr(0x22, 0x40);   /* CTRL_REG3: I1_IA1 -> route to INT1 pin */
	awr(0x24, 0x08);   /* CTRL_REG5: LIR_INT1 (latch) */
	awr(0x32, 0x12);   /* INT1_THS ~ shake threshold */
	awr(0x33, 0x00);   /* INT1_DURATION = 0 */
	awr(0x30, 0x2A);   /* INT1_CFG: OR of XH|YH|ZH (movement) */
	(void)ard(0x31);   /* clear */

	g_ncand = ARRAY_SIZE(CAND);
	for (unsigned c = 0; c < ARRAY_SIZE(CAND); c++)
		nrf_gpio_cfg_input(CAND[c], NRF_GPIO_PIN_PULLDOWN);

	for (int i = 0; i < 1500; i++) {          /* ~15 s at 10 ms */
		uint8_t lv[ARRAY_SIZE(CAND)];
		for (unsigned c = 0; c < ARRAY_SIZE(CAND); c++)
			lv[c] = nrf_gpio_pin_read(CAND[c]);
		int ia = (ard(0x31) >> 6) & 1;        /* INT1_SRC.IA, also clears latch */
		if (ia) g_iacount++;
		g_total++;
		for (unsigned c = 0; c < ARRAY_SIZE(CAND); c++) {
			if (lv[c] == ia) g_agree[c]++; else g_dis[c]++;
		}
		k_msleep(10);
	}
	g_done = 0xD05ED09E;
	while (1) k_msleep(1000);
}
