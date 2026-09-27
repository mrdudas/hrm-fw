/* LED finder: sweeps candidate GPIOs, blinking pin at list-index (i+1) times,
 * so counting the blinks reveals which pin drives the LED. Polarity-agnostic
 * (it toggles). Skips xtal (P0.00/01), ECG (P0.05) and RESET (P0.21). */
#include <zephyr/kernel.h>
#include <zephyr/sys/util.h>
#include <hal/nrf_gpio.h>

/* order = the "index" the user counts (1-based) */
static const uint8_t pins[] = { 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 20, 28, 29, 30 };

int main(void)
{
	while (1) {
		for (int i = 0; i < (int)ARRAY_SIZE(pins); i++) {
			uint32_t p = pins[i];
			nrf_gpio_cfg_output(p);
			for (int b = 0; b <= i; b++) {   /* i+1 blinks */
				nrf_gpio_pin_set(p);   k_msleep(120);
				nrf_gpio_pin_clear(p); k_msleep(160);
			}
			nrf_gpio_cfg_input(p, NRF_GPIO_PIN_NOPULL);  /* release */
			k_msleep(2000);              /* gap between pins */
		}
		k_msleep(6000);                      /* long gap = sweep restarts */
	}
}
