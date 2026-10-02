#!/usr/bin/env python3
"""Read thread-stack high-water marks over SWD (CONFIG_INIT_STACKS=0xAA fill).

Stacks grow down, so untouched bytes stay 0xAA at the LOW end of each region.
used = size - (count of leading 0xAA). Reads live (no halt needed)."""
from pyocd.core.helpers import ConnectHelper

# name: (addr, size)  -- from build_measure/zephyr.elf
STACKS = {
    "z_main_stack":           (0x200043d8, 0x600),
    "sys_work_q_stack":       (0x200049d8, 0x500),
    "z_interrupt_stacks":     (0x20003ed8, 0x400),
    "rx_thread_stack":        (0x200033a8, 0x4b0),
    "recv_thread_stack":      (0x20003b58, 0x380),
    "prio_recv_thread_stack": (0x20003998, 0x1c0),
    "z_idle_stacks":          (0x200042d8, 0x100),
}

with ConnectHelper.session_with_chosen_probe(target_override="nrf52") as session:
    t = session.target
    print(f"{'stack':24} {'size':>5} {'used':>5} {'free':>5}  use%  suggest(+30%)")
    print("-" * 70)
    total_free = 0
    for name, (addr, size) in STACKS.items():
        data = t.read_memory_block8(addr, size)
        unused = 0
        for b in data:            # count 0xAA from the low (bottom) end upward
            if b == 0xAA:
                unused += 1
            else:
                break
        used = size - unused
        total_free += unused
        suggest = ((int(used * 1.3) + 31) // 32) * 32   # +30% margin, round up to 32
        print(f"{name:24} {size:5d} {used:5d} {unused:5d}  {100*used/size:3.0f}%  {suggest:5d}")
    print("-" * 70)
    print(f"total currently-unused stack bytes: {total_free}")
