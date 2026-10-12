/* QRST delineation of a signal-averaged beat.
 *
 * Input: one clean, R-aligned average (R at t = 0 ms). An averaged beat has very
 * little noise, so instead of a full wavelet transform this uses what wavelet
 * delineators do at heart -- Gaussian-smoothed derivatives at a scale matched to
 * each wave (narrow for the QRS, wide for P and T):
 *   - QRS onset / offset: where the slope stays below a small fraction of the
 *     steepest QRS slope;
 *   - P: the most prominent upright wave before the QRS, from 12 % to 12 % of its height;
 *   - T: largest deflection after the J point; T end by the tangent method (the
 *     tangent at the steepest return slope, where it meets the baseline).
 *
 * Optional front-end compensation: the strap's input stage is a high-pass that
 * flattens the low-frequency waves (T above all). If its corner frequency is
 * known, hpHz undoes a first-order high-pass (x = y + 2*pi*fc * integral(y)) and
 * pins the baseline at both ends of the cycle. Without it the wave TIMINGS are
 * still meaningful, but amplitudes and the T end (QT) are only estimates.
 *
 * Plain script: window.QRST in the browser, module.exports in node (tests).
 */
(function (root) {
  "use strict";

  function smooth(x, sigma) {                 // Gaussian, sigma in samples, reflected ends
    if (!(sigma > 0.3)) return Float64Array.from(x);
    const r = Math.ceil(3 * sigma), k = new Float64Array(2 * r + 1), n = x.length, out = new Float64Array(n);
    let s = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-0.5 * (i / sigma) ** 2); s += k[i + r]; }
    for (let i = 0; i < n; i++) {
      let a = 0;
      for (let j = -r; j <= r; j++) {
        let q = i + j;
        if (q < 0) q = -q; else if (q >= n) q = 2 * n - 2 - q;
        a += x[Math.max(0, Math.min(n - 1, q))] * k[j + r];
      }
      out[i] = a / s;
    }
    return out;
  }
  function deriv(x, fs) {                     // units per second
    const n = x.length, d = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) d[i] = (x[i + 1] - x[i - 1]) * fs / 2;
    d[0] = d[1]; d[n - 1] = d[n - 2];
    return d;
  }
  function median(a) {
    const b = Array.from(a).sort((p, q) => p - q), m = b.length >> 1;
    return b.length ? (b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2) : 0;
  }
  const mean = (a, i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) s += a[i]; return s / Math.max(1, i1 - i0); };

  // From `from`, step in direction `dir` (within `limit`) until `quiet(i)` has held
  // for `run` samples; returns the index where that quiet run began.
  function edge(from, dir, limit, run, quiet) {
    let c = 0;
    for (let i = from; dir > 0 ? i <= limit : i >= limit; i += dir) {
      if (quiet(i)) { if (++c >= run) return i - dir * (run - 1); } else c = 0;
    }
    return null;
  }

  /* tms: time axis in ms (R at 0), y: averaged beat, fs: Hz, rrMs: beat period.
   * opts.hpHz: front-end high-pass corner to compensate (0 = off).
   *
   * All wave TIMINGS (P, QRS, T peak) are found on the signal as measured: they
   * hardly move with the compensation, and searching the raw signal keeps them
   * independent of the corner frequency entered. With hpHz > 0 the compensated
   * signal is used for what the high-pass does distort: amplitudes and the T end.
   *
   * Returns { t, sig (baseline removed), base, tEnd, fid: {name: ms}, amp: {name: value}, m: {intervals}, comp } */
  function analyze(tms, y, fs, rrMs, opts) {
    const hp = (opts && opts.hpHz) || 0;
    const ms = (v) => Math.round(v * fs / 1000);                  // ms -> samples
    const i0 = tms.findIndex((v) => v >= 0);
    if (i0 < ms(120) || !(rrMs > 250)) return null;
    // one cardiac cycle: stop well before the next beat's P wave
    // (at high heart rates the next P wave follows the T wave closely)
    const tEndMs = Math.min(tms[tms.length - 1], Math.max(Math.min(350, rrMs - 110), rrMs - 180));
    const n = Math.min(y.length, i0 + ms(tEndMs) + 1);
    const t = Array.from(tms).slice(0, n);
    const T = (i) => t[Math.max(0, Math.min(n - 1, Math.round(i)))];
    const base = median(Array.from(y).slice(0, Math.max(4, ms(50))));
    const x = new Float64Array(n);
    for (let i = 0; i < n; i++) x[i] = y[i] - base;
    const fid = {}, amp = {};

    // ---- QRS (narrow scale): R peak and the J point
    const xs = smooth(x, 0.003 * fs), d = deriv(smooth(x, 0.004 * fs), fs);
    let R = i0;
    for (let i = i0 - ms(20); i <= i0 + ms(20); i++) if (xs[i] > xs[R]) R = i;
    const Rv = xs[R];
    if (!(Rv > 0)) return null;
    let dmax = 0;
    for (let i = R - ms(60); i <= Math.min(n - 1, R + ms(60)); i++) dmax = Math.max(dmax, Math.abs(d[i]));
    const thr = 0.06 * dmax, run = Math.max(3, ms(12));
    const off = edge(R, +1, Math.min(n - 1 - run, R + ms(170)), run, (i) => Math.abs(d[i]) < thr);
    if (off == null) return null;

    // ---- T (wide scale); baseline = end of the cycle (TP segment)
    const sT = 0.014 * fs;
    const xt = smooth(x, sT), dt = deriv(xt, fs);
    const tailRef = (a) => mean(a, n - Math.max(4, ms(40)), n);
    const tLo = off + ms(60), tHi = n - 1 - ms(50);
    let tIdx = -1, tSgn = 0;
    if (tHi - tLo > ms(60)) {
      // the T wave is the local extremum that stands out most: its deviation from
      // the baseline plus its height above the chord joining the signal 100 ms
      // before and after (so a sloping ST segment is not mistaken for it)
      const tb = tailRef(xt), wT = ms(100);
      let best = 0;
      const cand = [];
      for (let i = tLo + 1; i < tHi; i++) {
        if ((dt[i - 1] > 0) === (dt[i] > 0)) continue;              // not a local extremum
        const a = Math.max(tLo, i - wT), b = Math.min(tHi, i + wT);
        const prom = Math.abs(xt[i] - (xt[a] + (xt[b] - xt[a]) * (i - a) / (b - a)));
        const score = Math.abs(xt[i] - tb) + prom;
        cand.push([i, score]);
        if (score > best) { best = score; tIdx = i; }
      }
      // a wave of the opposite polarity right before the winner, nearly as strong:
      // that one is the T wave and the winner its rebound (the second phase of a
      // biphasic T, or the undershoot a high-pass front end adds after the T)
      for (const [i, score] of cand) {
        if (i >= tIdx || tIdx - i > ms(200) || score < 0.6 * best) continue;
        if (Math.sign(xt[i] - tb) !== Math.sign(xt[tIdx] - tb)) { tIdx = i; best = score; break; }
      }
      if (tIdx > 0 && best > 0.008 * Rv) { tSgn = Math.sign(xt[tIdx] - tb) || 1; fid.T = T(tIdx); }
      else tIdx = -1;
    }

    // ---- P (wide scale): an upright wave in this lead, so the most prominent local
    // MAXIMUM before the QRS -- its height above the line joining the lowest points
    // on either side. (The largest deviation from a fixed level picks the valley
    // between the previous T wave and the P wave at higher heart rates.)
    const xp = smooth(x, 0.008 * fs);
    // not further back than the previous beat's T peak (this beat's T, one RR earlier)
    const tPrev = tIdx > 0 ? tIdx - ms(rrMs) + ms(40) : R - ms(Math.min(340, 0.5 * rrMs));
    const pLo = Math.max(ms(12), R - ms(340), tPrev), pHi = R - ms(60), pEnd = R - ms(35);
    let pIdx = -1, pL = 0, pR = 0;
    const pBase = (a) => a[pL] + (a[pR] - a[pL]) * (pIdx - pL) / Math.max(1, pR - pL);
    if (pHi - pLo > ms(30)) {
      const reach = ms(90);
      let best = 0.008 * Rv;
      for (let i = pLo + 1; i < pHi; i++) {
        if (!(xp[i] >= xp[i - 1] && xp[i] > xp[i + 1])) continue;        // local maximum
        let l = i, r = i;
        for (let k = i; k >= Math.max(pLo - ms(20), 0, i - reach); k--) if (xp[k] < xp[l]) l = k;
        for (let k = i; k <= Math.min(pEnd, i + reach); k++) if (xp[k] < xp[r]) r = k;
        if (l === i || r === i) continue;
        const prom = xp[i] - (xp[l] + (xp[r] - xp[l]) * (i - l) / (r - l));
        if (prom > best) { best = prom; pIdx = i; pL = l; pR = r; }
      }
    }

    // ---- QRS onset: flat AND back at the baseline (a small initial deflection
    // before the main complex has a flat top, but is not at the baseline). Never
    // searched back past the P wave: with a short PQ segment the P's own slope
    // would otherwise be taken for the start of the QRS.
    const lim = Math.max(run, R - ms(140), pIdx > 0 ? pIdx + ms(16) : 0);
    let on = edge(R, -1, lim, run, (i) => Math.abs(d[i]) < 0.04 * dmax && Math.abs(xs[i]) < 0.03 * Rv);
    if (on == null) on = edge(R, -1, lim, run, (i) => Math.abs(d[i]) < thr);
    if (on == null && pIdx > 0) {             // no flat PQ segment: its flattest point
      on = lim;
      for (let i = lim; i <= R - ms(10); i++) if (Math.abs(d[i]) < Math.abs(d[on])) on = i;
    }
    if (on == null) return null;
    fid.qrsOn = T(on); fid.R = T(R); fid.qrsOff = T(off);
    let q = on, sIdx = R;
    for (let i = on; i <= R; i++) if (xs[i] < xs[q]) q = i;
    for (let i = R; i <= off; i++) if (xs[i] < xs[sIdx]) sIdx = i;
    const hasQ = xs[q] < -0.03 * Rv && q > on && q < R;
    const hasS = xs[sIdx] < -0.03 * Rv && sIdx > R && sIdx < off;
    if (hasQ) fid.Q = T(q);
    if (hasS) fid.S = T(sIdx);

    if (pIdx > 0) {
      // P onset / offset: where the wave has come down to 12 % of its height above
      // the line joining its feet. (A slope criterion wanders by tens of ms on a
      // small, broad P wave.)
      const p = pIdx, h = xp[p] - pBase(xp);
      const above = (i) => xp[i] - (xp[pL] + (xp[pR] - xp[pL]) * (i - pL) / Math.max(1, pR - pL));
      let pOn = pL, pOff = Math.min(pR, on);
      for (let i = p; i >= pL; i--) if (above(i) < 0.12 * h) { pOn = i; break; }
      for (let i = p; i <= Math.min(pR, on); i++) if (above(i) < 0.12 * h) { pOff = i; break; }
      fid.P = T(p); fid.pOn = T(pOn); fid.pOff = T(pOff);
    }

    // ---- amplitudes and T end: on the compensated signal if a corner is given
    let sig = xs, ap = xp, at = xt, adt = dt;
    if (hp > 0) {
      const c = Float64Array.from(x), w = 2 * Math.PI * hp / fs;     // inverse 1st-order high-pass
      let acc = 0;
      for (let i = 0; i < n; i++) { acc += x[i]; c[i] += w * acc; }
      const e = Math.max(3, ms(15)), a = mean(c, 0, e), b = mean(c, n - e, n);
      for (let i = 0; i < n; i++) c[i] -= a + (b - a) * i / (n - 1);  // isoelectric at both ends
      sig = smooth(c, 0.003 * fs); ap = smooth(c, 0.008 * fs); at = smooth(c, sT); adt = deriv(at, fs);
      if (tIdx > 0) {                         // same-polarity extremum next to the raw T peak
        let k = tIdx;
        for (let i = Math.max(tLo, tIdx - ms(60)); i <= Math.min(tHi, tIdx + ms(60)); i++) if (tSgn * at[i] > tSgn * at[k]) k = i;
        tIdx = k; fid.T = T(k);
      }
    }
    amp.R = sig[R];
    if (hasQ) amp.Q = sig[q];
    if (hasS) amp.S = sig[sIdx];
    if (pIdx > 0) amp.P = ap[pIdx] - pBase(ap);
    if (tIdx > 0) {
      const tb = tailRef(at);
      amp.T = at[tIdx] - tb;
      // tangent method: steepest slope back toward the baseline after the peak
      let m = tIdx;
      for (let i = tIdx; i <= Math.min(n - 2, tIdx + ms(220)); i++) if (-tSgn * adt[i] > -tSgn * adt[m]) m = i;
      if (-tSgn * adt[m] > 0) {
        const te = t[m] + (tb - at[m]) / adt[m] * 1000;       // ms where the tangent meets the baseline
        if (te > t[tIdx] && te <= t[n - 1]) fid.tEnd = te;
      }
    }

    // ---- intervals
    const m = { rr: rrMs, hr: 60000 / rrMs, qrs: fid.qrsOff - fid.qrsOn };
    if (fid.pOn != null) m.pr = fid.qrsOn - fid.pOn;
    if (fid.P != null) m.pPeakR = fid.R - fid.P;
    if (fid.T != null) m.rtPeak = fid.T - fid.R;
    if (fid.tEnd != null) {
      m.qt = fid.tEnd - fid.qrsOn;
      const rrS = rrMs / 1000;
      m.qtcB = m.qt / Math.sqrt(rrS);          // Bazett
      m.qtcF = m.qt / Math.cbrt(rrS);          // Fridericia
    }
    return { t, sig: Array.from(sig), base, tEnd: tEndMs, fid, amp, m, comp: hp > 0 ? hp : 0 };
  }

  const api = { analyze, smooth };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.QRST = api;
})(typeof window !== "undefined" ? window : this);
