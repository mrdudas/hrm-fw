/* StreamClock: maps a stream's sample index to a smooth display time.
 *
 * BLE delivers packets in bursts and, on some hosts (notably MacBooks, where
 * Wi-Fi and Bluetooth share a radio), stalls for 1–2 s and then catches up.
 * Plotting by arrival time makes the trace jump, so instead:
 *
 *  - rate: least-squares slope of (index, arrival) over the last RATE_WIN s,
 *    clamped near nominal. A new slope pivots around the newest sample, so
 *    already-plotted samples don't move.
 *  - offset: follows the EARLIEST arrivals of the last ENV_WIN s (a late packet
 *    only arrives late, it doesn't pull the mapping), and is slewed at most
 *    SLEW s per s — the trace may run imperceptibly faster or slower, but it
 *    never jumps. Only a gross error (> HARD_JUMP, e.g. a broken clock) snaps.
 *  - delay: displayDelay() tracks how late packets arrive relative to the
 *    mapping (max over JIT_WIN s) so the playout delay covers the host's real
 *    burstiness: grows fairly quickly, shrinks slowly.
 *
 * Plain script: defines window.StreamClock in the browser, module.exports in node
 * (used by the simulation tests).
 */
(function (root) {
  "use strict";

  const RATE_WIN = 60, ENV_WIN = 8, JIT_WIN = 20;    // seconds
  const SLEW = 0.02, SLEW_FAST = 0.2, FAST_S = 5;    // s/s; faster while settling
  const HARD_JUMP = 3;                               // s
  const D_MIN = 0.3, D_MAX = 3, D_MARGIN = 0.08;     // playout delay (s)
  const D_UP = 0.3, D_DOWN = 0.03;                   // delay slew (s/s)

  class StreamClock {
    constructor(period, tol = 0.05) {
      this.nom = period; this.tol = tol;
      this.reset();
    }
    reset() {
      this.ready = false;
      this.b = this.nom;      // seconds per sample
      this.i0 = 0; this.c = 0; // mapping: t(i) = c + b * (i - i0)
      this.hist = [];         // [i, t] arrivals, last RATE_WIN s
      this.tStart = 0; this.lastT = 0;
      this.lateMax = 0;       // max lateness over JIT_WIN (s)
      this.delay = null; this.delayAt = null;
    }
    t(i) { return this.c + this.b * (i - this.i0); }
    idx(t) { return (t - this.c) / this.b + this.i0; }

    add(i, t) {
      const h = this.hist;
      if (!this.ready) {
        this.ready = true; this.i0 = i; this.c = t; this.tStart = this.lastT = t;
        h.push([i, t]);
        return;
      }
      h.push([i, t]);
      while (h.length > 2 && h[0][1] < t - RATE_WIN) h.shift();

      // 1) rate, pivoting around the newest index
      const span = h[h.length - 1][1] - h[0][1];
      if (span > 5) {
        const n = h.length, ia = h[0][0], ta = h[0][1];
        let mi = 0, mt = 0;
        for (const [ii, tt] of h) { mi += ii - ia; mt += tt - ta; }
        mi /= n; mt /= n;
        let sxy = 0, sxx = 0;
        for (const [ii, tt] of h) { const dx = ii - ia - mi; sxy += dx * (tt - ta - mt); sxx += dx * dx; }
        if (sxx > 0) {
          const b = Math.min(this.nom * (1 + this.tol), Math.max(this.nom * (1 - this.tol), sxy / sxx));
          const pivot = this.t(i);
          this.b = b; this.i0 = i; this.c = pivot;
        }
      }

      // 2) lateness of recent packets against the current mapping
      let minEnv = Infinity, maxJit = -Infinity;
      for (let k = h.length - 1; k >= 0; k--) {
        const [ii, tt] = h[k];
        if (tt < t - JIT_WIN) break;
        const late = tt - this.t(ii);
        if (late > maxJit) maxJit = late;
        if (tt >= t - ENV_WIN && late < minEnv) minEnv = late;
      }

      // 3) slew the offset so the earliest arrivals sit on the mapping
      const dt = Math.max(0, t - this.lastT);
      this.lastT = t;
      if (Math.abs(minEnv) > HARD_JUMP) this.c += minEnv;
      else {
        const rate = t - this.tStart < FAST_S ? SLEW_FAST : SLEW;
        const step = rate * dt;
        this.c += Math.max(-step, Math.min(step, minEnv));
      }
      this.lateMax = Math.max(0, maxJit);
    }

    // Playout delay for this stream at wall time `now` (call once per frame).
    displayDelay(now, dtFrame) {
      const target = Math.min(D_MAX, Math.max(D_MIN, this.lateMax + D_MARGIN));
      if (this.delay == null) { this.delay = target; return this.delay; }
      const dt = Math.min(0.1, dtFrame != null ? dtFrame : (this.delayAt == null ? 0 : now - this.delayAt));
      this.delayAt = now;
      const d = target - this.delay;
      this.delay += d > 0 ? Math.min(d, D_UP * dt) : Math.max(d, -D_DOWN * dt);
      return this.delay;
    }
  }

  if (typeof module !== "undefined" && module.exports) module.exports = { StreamClock };
  else root.StreamClock = StreamClock;
})(typeof window !== "undefined" ? window : this);
