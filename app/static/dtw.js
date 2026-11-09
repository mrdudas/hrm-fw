/* Beat timing against an averaged reference beat, by dynamic time warping.
 *
 * The raw ECG around each beat is cut out (aligned on its R peak to a fraction
 * of a sample), the clean beats are averaged into a reference, and every beat
 * is warped onto the reference with DTW. The warping path says, for each
 * point of the reference cycle, where the same part of the waveform lies in
 * this beat: delta(t) = (time in the beat) - (time in the reference), in ms,
 * both measured from the R peak. Positive: this part of the cycle comes later
 * than in the reference (e.g. a later T wave = a longer QT).
 *
 * Pure functions, no DOM: window.BeatDTW (also require()-able for tests).
 */
(function (root) {
  "use strict";

  // ---------- zero-phase filters (forward-backward biquads: no timing shift) ----------
  function biquad(kind, f0, fs, q) {
    const w = 2 * Math.PI * f0 / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    let b0, b1, b2;
    if (kind === "lp") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
    else if (kind === "hp") { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
    else { b0 = 1; b1 = -2 * c; b2 = 1; }                    // notch
    const a0 = 1 + al;
    return [b0 / a0, b1 / a0, b2 / a0, -2 * c / a0, (1 - al) / a0];
  }
  function runBiquad(x, k, out) {
    const [b0, b1, b2, a1, a2] = k;
    // start from the first sample's steady state (DC gain g), so the edge does not ring
    const g = (b0 + b1 + b2) / (1 + a1 + a2), x0 = x[0], y0 = isFinite(g) ? g * x0 : 0;
    let x1 = x0, x2 = x0, y1 = y0, y2 = y0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i], y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = v; y2 = y1; y1 = y;
      out[i] = y;
    }
    return out;
  }
  function filtfilt(x, k) {
    const n = x.length, t = new Float64Array(n);
    runBiquad(x, k, t);
    t.reverse();
    runBiquad(t.slice(), k, t);
    return t.reverse();
  }
  /** Baseline (high-pass), noise (low-pass) and optional mains notch, all zero-phase. */
  function prep(v, fs, o = {}) {
    let x = Float64Array.from(v);
    if (o.notch && o.notch < fs / 2) x = filtfilt(x, biquad("notch", o.notch, fs, 30));
    if (o.hp !== 0) x = filtfilt(x, biquad("hp", o.hp || 0.5, fs, Math.SQRT1_2));   // hp: 0 = none
    if ((o.lp || 40) < fs / 2) x = filtfilt(x, biquad("lp", o.lp || 40, fs, Math.SQRT1_2));
    return x;
  }

  // linear interpolation of x at fractional index p
  function at(x, p) {
    const i = Math.floor(p), f = p - i;
    if (i < 0) return x[0];
    if (i >= x.length - 1) return x[x.length - 1];
    return x[i] + f * (x[i + 1] - x[i]);
  }
  function median(a) {
    const s = Float64Array.from(a).sort(), n = s.length;
    return n ? (n & 1 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN;
  }

  /**
   * R peaks found in the ECG itself (not the strap's beat times: those are
   * placed from BLE arrival times and can be off by a few hundred ms).
   * QRS energy: 5-25 Hz band-pass, |x|; peaks above 40 % of the typical 2-s
   * maximum (median over +-10 s), at least 280 ms apart. The R is then the
   * extreme of the (0.5-40 Hz) ECG within +-40 ms, on the lead's polarity,
   * refined to a fraction of a sample.
   * f: [{t, x}] (prep()ed); returns {pol, beats: [{seg, p (fractional index), r (unix s), rr (ms; NaN = first after a break)}]}
   */
  function detect(f, fs) {
    const hp = biquad("hp", 5, fs, Math.SQRT1_2), lp = biquad("lp", 25, fs, Math.SQRT1_2);
    const REF = Math.round(0.28 * fs), SN = Math.round(0.04 * fs), EDGE = Math.round(0.5 * fs), BL = 2 * fs;
    const cand = [];
    for (const s of f) {
      const e = filtfilt(filtfilt(s.x, hp), lp).map(Math.abs), n = e.length;
      const bmax = [];
      for (let i = 0; i < n; i += BL) { let m = 0; for (let j = i; j < Math.min(n, i + BL); j++) m = Math.max(m, e[j]); bmax.push(m); }
      const thr = bmax.map((_, k) => 0.4 * median(bmax.slice(Math.max(0, k - 5), k + 6)));
      let last = null;
      for (let i = Math.max(1, EDGE); i < n - Math.max(1, EDGE); i++) {
        if (!(e[i] >= e[i - 1] && e[i] > e[i + 1] && e[i] >= thr[Math.floor(i / BL)])) continue;
        if (last && i - last.i < REF) { if (e[i] > last.e) { last.i = i; last.e = e[i]; } continue; }
        last = { s, i, e: e[i] };
        cand.push(last);
      }
    }
    // polarity of the lead: the sign of the larger deflection at most peaks
    let vote = 0;
    for (const c of cand) {
      let mx = -Infinity, mn = Infinity;
      for (let j = c.i - SN; j <= c.i + SN; j++) { mx = Math.max(mx, c.s.x[j]); mn = Math.min(mn, c.s.x[j]); }
      const lev = median(c.s.x.subarray(Math.max(0, c.i - fs), c.i));
      vote += mx - lev >= lev - mn ? 1 : -1;
    }
    const pol = vote >= 0 ? 1 : -1, beats = [];
    let prev = null;
    for (const c of cand) {
      const x = c.s.x;
      let best = c.i, bv = -Infinity;
      for (let j = c.i - SN; j <= c.i + SN; j++) if (pol * x[j] > bv) { bv = pol * x[j]; best = j; }
      const y0 = x[best - 1], y1 = x[best], y2 = x[best + 1], den = y0 - 2 * y1 + y2;
      const p = best + (den ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / den)) : 0);
      if (prev && prev.seg === c.s && p - prev.p < REF) continue;          // two candidates on one QRS
      const r = c.s.t + p / fs;
      beats.push({ seg: c.s, p, r, rr: prev && prev.seg === c.s ? (p - prev.p) * 1000 / fs : NaN });
      prev = beats[beats.length - 1];
    }
    return { pol, beats };
  }

  /** Cut the detected beats out: {pre, post, n, fs, pol, beats: [{k, r, rr, bad, seg, p, y}]} */
  function extract(det, bad, o) {
    const fs = o.fs, pre = Math.round(o.pre * fs / 1000), post = Math.round(o.post * fs / 1000), n = pre + post + 1;
    const beats = [];
    det.beats.forEach((b, k) => {
      if (b.p - pre < 1 || b.p + post > b.seg.x.length - 2) return;      // window runs off the fetched ECG
      beats.push({ k, r: b.r, t: b.r, rr: b.rr, bad: !!bad[k] || !isFinite(b.rr), seg: b.seg, p: b.p, y: cut(b.seg.x, b.p, pre, n) });
    });
    return { pre, post, n, fs, pol: det.pol, beats };
  }
  function cut(x, p, pre, n) {
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = at(x, p - pre + i);
    return y;
  }
  function baseline(y, pre, fs) {
    const a = Math.max(0, pre - Math.round(0.09 * fs)), b = Math.max(a + 1, pre - Math.round(0.06 * fs));
    const m = median(y.subarray(a, b));
    for (let i = 0; i < y.length; i++) y[i] -= m;
    return y;
  }

  /**
   * Reference beat, beat-to-reference alignment and amplitude.
   * Beats used for the reference: not corrected (bad), and the neighbouring
   * QRS outside the window. Each beat is shifted by cross-correlation of its
   * QRS (R +-40 ms) against the reference (fraction of a sample), so the
   * R-to-R alignment is as tight as the waveform allows; then re-cut.
   */
  function reference(ex, o = {}) {
    const { pre, post, n, fs, beats } = ex;
    const preS = pre / fs, postS = post / fs;
    const byK = new Map(beats.map((b) => [b.k, b]));
    for (const b of beats) {
      b.fits = !b.bad && b.rr / 1000 > preS + 0.06;           // previous QRS not inside the window
      const nx = byK.get(b.k + 1);
      if (nx && nx.rr / 1000 < postS + 0.06) b.fits = false;  // next QRS inside the window
      baseline(b.y, pre, fs);
    }
    let ref = mean(beats.filter((b) => b.fits).map((b) => b.y), n, o.median);
    if (!ref) return null;
    const Q = Math.round(0.04 * fs), L = Math.round(0.012 * fs);
    for (let pass = 0; pass < 2; pass++) {
      for (const b of beats) {
        // best lag (samples) of the beat's QRS against the reference's, parabolic peak
        let bl = 0, bv = -Infinity;
        const xc = [];
        for (let l = -L; l <= L; l++) {
          let s = 0;
          for (let i = pre - Q; i <= pre + Q; i++) s += ref[i] * at(b.y, i + l);
          xc.push(s);
          if (s > bv) { bv = s; bl = l; }
        }
        const j = bl + L, y0 = xc[j - 1], y2 = xc[j + 1], den = y0 - 2 * bv + y2;
        const fine = j > 0 && j < xc.length - 1 && den ? Math.max(-0.5, Math.min(0.5, 0.5 * (y0 - y2) / den)) : 0;
        b.p += bl + fine;
        b.y = baseline(cut(b.seg.x, b.p, pre, n), pre, fs);
      }
      ref = mean(beats.filter((b) => b.fits).map((b) => b.y), n, o.median);
    }
    // amplitude: least-squares gain against the reference over the QRS, so the DTW
    // compares shapes (breathing changes the amplitude, not the timing)
    for (const b of beats) {
      let sxy = 0, sxx = 0;
      for (let i = pre - Q; i <= pre + Q; i++) { sxy += b.y[i] * ref[i]; sxx += b.y[i] * b.y[i]; }
      b.gain = sxx > 0 ? sxy / sxx : 1;
      b.r = b.seg.t + b.p / fs;
    }
    return ref;
  }
  function mean(ys, n, useMedian) {
    if (!ys.length) return null;
    const m = new Float64Array(n);
    if (useMedian) {
      const col = new Float64Array(ys.length);
      for (let i = 0; i < n; i++) { for (let k = 0; k < ys.length; k++) col[k] = ys[k][i]; m[i] = median(col); }
    } else {
      for (const y of ys) for (let i = 0; i < n; i++) m[i] += y[i];
      for (let i = 0; i < n; i++) m[i] /= ys.length;
    }
    return m;
  }

  /**
   * DTW of beat y onto reference x (same length n).
   * Features: amplitude and slope, each scaled by the reference's spread; o.wv,
   * o.wd their weights. o.band (samples): Sakoe-Chiba band. o.pen: extra cost of
   * a non-diagonal step, in units of the mean feature cost (keeps the path from
   * warping on noise). Path pinned at both ends; the R peak (index pre) is NOT
   * pinned, so timing shifts around the QRS show too.
   * Returns {delta (Float64Array n, samples: beat index - reference index), dist, warped (y on x's time)}
   */
  function dtw(x, y, o) {
    const n = x.length, B = Math.max(1, o.band | 0), W = 2 * B + 1;
    const dx = slope(x), dy = slope(y);
    const sv = spread(x) || 1, sd = spread(dx) || 1;
    const wv = o.wv / (sv * sv), wd = o.wd / (sd * sd);
    const cost = (i, j) => { const a = x[i] - y[j], b = dx[i] - dy[j]; return wv * a * a + wd * b * b; };
    let pen = 0;
    if (o.pen) { let s = 0; for (let i = 0; i < n; i++) s += cost(i, i); pen = o.pen * (s / n + 1e-9); }
    // banded accumulated cost: D[i][j], j in [i-B, i+B] stored at column j-i+B
    const D = new Float64Array(n * W).fill(Infinity), S = new Int8Array(n * W);   // step: 0 diag, 1 up (i-1), 2 left (j-1)
    for (let i = 0; i < n; i++) {
      for (let d = -B; d <= B; d++) {
        const j = i + d;
        if (j < 0 || j >= n) continue;
        const c = cost(i, j), q = i * W + d + B;
        if (i === 0 && j === 0) { D[q] = c; continue; }
        let best = Infinity, st = 0;
        if (i > 0 && j > 0) { best = D[(i - 1) * W + d + B]; st = 0; }                             // (i-1, j-1)
        if (i > 0 && d + 1 <= B) { const v = D[(i - 1) * W + d + 1 + B] + pen; if (v < best) { best = v; st = 1; } }  // (i-1, j)
        if (j > 0 && d - 1 >= -B) { const v = D[i * W + d - 1 + B] + pen; if (v < best) { best = v; st = 2; } }      // (i, j-1)
        D[q] = c + best; S[q] = st;
      }
    }
    // back-track from (n-1, n-1)
    const sum = new Float64Array(n), cnt = new Float64Array(n), wsum = new Float64Array(n);
    let i = n - 1, j = n - 1, len = 0;
    while (true) {
      sum[i] += j - i; wsum[i] += y[j]; cnt[i]++; len++;
      if (i === 0 && j === 0) break;
      const st = S[i * W + (j - i) + B];
      if (st === 0) { i--; j--; } else if (st === 1) i--; else j--;
    }
    const delta = new Float64Array(n), warped = new Float64Array(n);
    for (let k = 0; k < n; k++) { delta[k] = sum[k] / cnt[k]; warped[k] = wsum[k] / cnt[k]; }
    return { delta, warped, dist: D[(n - 1) * W + B] / len };
  }
  function slope(x) {
    const n = x.length, d = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) d[i] = (x[i + 1] - x[i - 1]) / 2;
    d[0] = d[1]; d[n - 1] = d[n - 2];
    return d;
  }
  function spread(x) {
    let m = 0;
    for (const v of x) m += v;
    m /= x.length;
    let s = 0;
    for (const v of x) s += (v - m) * (v - m);
    return Math.sqrt(s / x.length);
  }
  // centred moving average over w samples (odd)
  function smooth(x, w) {
    if (w <= 1) return x;
    const h = w >> 1, n = x.length, out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - h); j <= Math.min(n - 1, i + h); j++) { s += x[j]; c++; }
      out[i] = s / c;
    }
    return out;
  }

  /**
   * The whole analysis.
   * segs: [{t, v}] raw ECG; o: {fs, notch, pre, post (ms) or null (from the median RR), band (ms),
   *   feat: "both"|"amp"|"slope", pen, median, smoothMs, from, to (unix s: beats to keep),
   *   clean(rr, gap) -> bad flags (optional: the app's artifact / ectopy rules)}
   * Returns {fs, pre, n, tms (ms from R per sample), ref, pol, beats: [{k, t, r, rr, bad, fits, gain, y, warped, delta (ms), dist}],
   *          stats: {med, q1, q3} per sample (ms, over the reference beats)}
   */
  function analyse(segs, o) {
    const fs = o.fs;
    const f = segs.filter((s) => s.v.length > 3 * fs).map((s) => ({ t: s.t, x: prep(s.v, fs, { notch: o.notch }) }));
    const det = detect(f, fs);
    det.beats = det.beats.filter((b) => b.r >= (o.from ?? -Infinity) && b.r <= (o.to ?? Infinity));
    if (det.beats.length < 3) return null;
    const rr = det.beats.map((b) => b.rr), good = rr.filter(isFinite);
    const rrMed = good.length ? median(good) : 800;
    const gap = rr.map((v) => (isFinite(v) ? 0 : 1));
    const bad = o.clean ? o.clean(rr.map((v) => (isFinite(v) ? v : rrMed)), gap) : gap;
    o = { ...o, pre: o.pre ?? Math.min(250, Math.round(rrMed / 3 / 10) * 10), post: o.post ?? Math.min(500, Math.round(0.6 * rrMed / 10) * 10) };
    const ex = extract(det, bad, o);
    if (!ex.beats.length) return null;
    const ref = reference(ex, o);
    if (!ref) return null;
    const { n, pre } = ex;
    const wv = o.feat === "slope" ? 0 : 1, wd = o.feat === "amp" ? 0 : 1;
    const band = Math.max(1, Math.round(o.band * fs / 1000)), sm = Math.max(1, Math.round((o.smoothMs || 0) * fs / 1000)) | 1;
    const res = [];
    for (const b of ex.beats) {
      const y = b.y.map((v) => v * b.gain);
      const r = dtw(ref, y, { band, wv, wd, pen: o.pen });
      const delta = smooth(r.delta, sm).map((v) => v * 1000 / fs);
      res.push({ k: b.k, t: b.t, r: b.r, rr: b.rr, fits: b.fits, bad: b.bad, gain: b.gain, y, warped: r.warped, delta, dist: r.dist });
    }
    const tms = Float64Array.from({ length: n }, (_, i) => (i - pre) * 1000 / fs);
    const use = res.filter((b) => b.fits);
    const med = new Float64Array(n), q1 = new Float64Array(n), q3 = new Float64Array(n), col = new Float64Array(use.length);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < use.length; k++) col[k] = use[k].delta[i];
      const s = Float64Array.from(col).sort(), m = s.length;
      med[i] = s[Math.floor(0.5 * (m - 1))]; q1[i] = s[Math.floor(0.25 * (m - 1))]; q3[i] = s[Math.floor(0.75 * (m - 1))];
    }
    return { fs, pre, n, tms, ref, pol: ex.pol, beats: res, stats: { med, q1, q3 }, win: [o.pre, o.post], rrMed };
  }

  // ======================================================================
  // Kernel method: R-R cycles, a sliding DTW-averaged kernel, each cycle
  // warped onto the kernel of its neighbours (R peaks pinned: no slip).
  // ======================================================================

  /**
   * DTW of y (length m) onto x (length n), lengths may differ. The band is
   * +-B samples around the straight line from (0, 0) to (n-1, m-1), so a
   * longer cycle is first stretched uniformly and only the rest is warping.
   * Ends pinned. Returns {map (Float64Array n: mean index in y matched to x[i]),
   * warped (y on x's grid), dist (mean cost per path step)}.
   */
  function dtw2(x, y, o) {
    const n = x.length, m = y.length, B = Math.max(1, o.band | 0), W = 2 * B + 1;
    const dx = slope(x), dy = slope(y);
    const sv = o.sv || spread(x) || 1, sd = o.sd || spread(dx) || 1;
    const wv = o.wv / (sv * sv), wd = o.wd / (sd * sd);
    const cost = (i, j) => { const a = x[i] - y[j], b = dx[i] - dy[j]; return wv * a * a + wd * b * b; };
    const sc = n > 1 ? (m - 1) / (n - 1) : 0, lo = new Int32Array(n);
    for (let i = 0; i < n; i++) lo[i] = Math.round(i * sc) - B;
    let pen = 0;
    if (o.pen) { let t = 0; for (let i = 0; i < n; i++) t += cost(i, Math.round(i * sc)); pen = o.pen * (t / n + 1e-9); }
    const D = new Float64Array(n * W).fill(Infinity), S = new Int8Array(n * W);
    const get = (i, j) => { const c = j - lo[i]; return c >= 0 && c < W ? D[i * W + c] : Infinity; };
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < W; c++) {
        const j = lo[i] + c;
        if (j < 0 || j >= m) continue;
        const q = i * W + c, cc = cost(i, j);
        if (i === 0 && j === 0) { D[q] = cc; continue; }
        let best = Infinity, st = 0;
        if (i > 0 && j > 0) best = get(i - 1, j - 1);
        if (i > 0) { const v = get(i - 1, j) + pen; if (v < best) { best = v; st = 1; } }
        if (j > 0 && c > 0) { const v = D[q - 1] + pen; if (v < best) { best = v; st = 2; } }
        D[q] = cc + best; S[q] = st;
      }
    }
    const sum = new Float64Array(n), cnt = new Float64Array(n), wsum = new Float64Array(n);
    let i = n - 1, j = m - 1, len = 0;
    const end = get(n - 1, m - 1);
    if (!isFinite(end)) return null;                     // band too narrow for these lengths
    while (true) {
      sum[i] += j; wsum[i] += y[j]; cnt[i]++; len++;
      if (i === 0 && j === 0) break;
      const st = S[i * W + (j - lo[i])];
      if (st === 0) { i--; j--; } else if (st === 1) i--; else j--;
    }
    const map = new Float64Array(n), warped = new Float64Array(n);
    for (let k = 0; k < n; k++) { map[k] = sum[k] / cnt[k]; warped[k] = wsum[k] / cnt[k]; }
    return { map, warped, dist: end / len };
  }

  // linear resampling of y to n points (end to end)
  function resample(y, n) {
    const out = new Float64Array(n), sc = n > 1 ? (y.length - 1) / (n - 1) : 0;
    for (let i = 0; i < n; i++) out[i] = at(y, i * sc);
    return out;
  }

  /**
   * The kernel analysis.
   * segs: [{t, v}]; o: {fs, notch, pre (ms before R shown, null: a third of the median RR),
   *   band (ms), feat, pen, smoothMs, from, to, clean, kn (kernel = mean of kn cycles),
   *   causal (kernel from the kn cycles before; else centred), iter (DBA passes)}
   * A cycle runs from one R to the next. Its head (0 ... L0 - pre) belongs to the
   * beat at its start, its tail (the last `pre`) to the beat at its end, so a beat
   * is shown as usual (P before R, T after) with both parts timed from its own R.
   * Returns the same shape as analyse() (tms rows, ref, beats[].delta, stats) plus
   * cycles[] (y, kernel, map, ...) and segs (filtered ECG) for the kernel-train view.
   */
  function kernelAnalyse(segs, o) {
    const fs = o.fs;
    const f = segs.filter((s) => s.v.length > 3 * fs).map((s) => ({ t: s.t, v: s.v, x: prep(s.v, fs, { notch: o.notch }) }));
    const det = detect(f, fs);
    det.beats = det.beats.filter((b) => b.r >= (o.from ?? -Infinity) - 2 && b.r <= (o.to ?? Infinity) + 2);
    if (det.beats.length < 5) return null;
    const rr = det.beats.map((b) => b.rr), good = rr.filter(isFinite);
    const rrMed = good.length ? median(good) : 800;
    const gap = rr.map((v) => (isFinite(v) ? 0 : 1));
    const bad = o.clean ? o.clean(rr.map((v) => (isFinite(v) ? v : rrMed)), gap) : gap;
    const pol = det.pol;

    // ---- baseline: the isoelectric level before each R (PR segment, R-90 ... R-50 ms) ----
    // g: the ECG without high-pass (notch + 40 Hz low-pass); hf: what the low-pass removed (EMG)
    const I0 = Math.round(0.09 * fs), I1 = Math.round(0.05 * fs);
    for (const s of f) {
      const nt = prep(s.v, fs, { notch: o.notch, hp: 0, lp: fs });
      s.g = prep(s.v, fs, { notch: o.notch, hp: 0 });
      s.hf = nt.map((v, i) => v - s.g[i]);
      s.kx = []; s.ky = [];
    }
    for (const b of det.beats) {
      const s = b.seg, p = Math.round(b.p);
      b.iso = p - I0 >= 0 ? median(s.g.subarray(p - I0, p - I1)) : NaN;
      if (isFinite(b.iso)) { s.kx.push(p - (I0 + I1) / 2); s.ky.push(b.iso); }
    }
    // analysis signal: g minus a cubic spline through those levels (follows wander and DC steps
    // without the ringing a high-pass leaves after a step), or the high-passed ECG
    const spl = o.baseline !== "hp";
    for (const s of f) s.a = spl && s.kx.length >= 2 ? (() => { const bl = splineEval(s.kx, s.ky, s.g.length); return s.g.map((v, i) => v - bl[i]); })() : s.x;

    // ---- cycles: R(k) -> R(k+1) in one segment ----
    const cyc = [];
    for (let k = 0; k + 1 < det.beats.length; k++) {
      const a = det.beats[k], b = det.beats[k + 1];
      if (a.seg !== b.seg || !isFinite(b.rr)) continue;
      const m = Math.max(2, Math.round(b.p - a.p) + 1), y = new Float64Array(m), step = (b.p - a.p) / (m - 1);
      for (let i = 0; i < m; i++) y[i] = at(a.seg.a, a.p + i * step);
      cyc.push({ k0: k, k1: k + 1, r0: a.r, r1: b.r, len: (b.p - a.p) / fs * 1000, step, seg: a.seg, p0: a.p, y,
                 clean: !bad[k] && !bad[k + 1] });
    }
    if (cyc.length < 4) return null;
    // level and amplitude: the cycle's median set to 0, its R (both ends) scaled to the typical R
    for (const c of cyc) {
      c.off = spl ? 0 : median(c.y);
      c.amp = pol * ((c.y[0] + c.y[c.y.length - 1]) / 2 - c.off);
    }
    const ampMed = median(cyc.filter((c) => c.clean && c.amp > 0).map((c) => c.amp)) || 1;
    for (const c of cyc) {
      c.gain = c.amp > 0.2 * ampMed ? ampMed / c.amp : 1;
      for (let i = 0; i < c.y.length; i++) c.y[i] = (c.y[i] - c.off) * c.gain;
    }
    const cleanC = cyc.filter((c) => c.clean);
    if (cleanC.length < 3) return null;

    // ---- global kernel K0 (DBA): start from the time-normalised mean, then align and average ----
    const L0 = Math.round(median(cleanC.map((c) => c.y.length - 1)));
    const N0 = L0 + 1;
    let K0 = new Float64Array(N0);
    for (const c of cleanC) { const r = resample(c.y, N0); for (let i = 0; i < N0; i++) K0[i] += r[i] / cleanC.length; }
    const wv = o.feat === "slope" ? 0 : 1, wd = o.feat === "amp" ? 0 : 1;
    const band = Math.max(2, Math.round(o.band * fs / 1000));
    const iters = o.iter ?? 3;
    let sv, sd;
    for (let it = 0; it <= iters; it++) {
      sv = spread(K0) || 1; sd = spread(slope(K0)) || 1;
      const acc = new Float64Array(N0);
      let nAcc = 0;
      for (const c of (it < iters ? cleanC : cyc)) {
        const r = dtw2(K0, c.y, { band, wv, wd, pen: o.pen, sv, sd });
        c.g = r;                                               // alignment to K0 (last pass: all cycles)
        if (r && c.clean) { for (let i = 0; i < N0; i++) acc[i] += r.warped[i]; nAcc++; }
      }
      if (it < iters && nAcc) K0 = acc.map((v) => v / nAcc);
    }

    // ---- local kernel of each cycle: mean shape and timing of its kn neighbours (not itself) ----
    const kn = Math.max(2, o.kn | 0);
    const sp = Math.max(0, Math.min(L0 - 2, L0 - Math.round((o.pre ?? Math.min(250, rrMed / 3)) * fs / 1000)));   // split: head 0..sp, tail sp..L0
    let ok = [];
    const localPass = () => {
    ok = cyc.filter((c) => c.clean && c.g);
    const idx = new Map(ok.map((c, i) => [c, i]));
    // prefix sums over the clean cycles of their warped shape and time map on K0's grid
    const PW = [new Float64Array(N0)], PT = [new Float64Array(N0)], PL = [0];
    for (const c of ok) {
      const w = new Float64Array(N0), t = new Float64Array(N0), lw = PW[PW.length - 1], lt = PT[PT.length - 1];
      for (let i = 0; i < N0; i++) { w[i] = lw[i] + c.g.warped[i]; t[i] = lt[i] + c.g.map[i]; }
      PW.push(w); PT.push(t); PL.push(PL[PL.length - 1] + c.y.length - 1);
    }
    for (const c of cyc) {
      // neighbours among the clean cycles: the kn nearest in time (centred) or the kn before
      let pos = idx.has(c) ? idx.get(c) : lowerBoundBy(ok, c.r0);
      const self = idx.has(c);
      let a, b;
      if (o.causal) { b = pos; a = Math.max(0, b - kn); }
      else {
        a = pos - (kn >> 1); b = a + kn + (self ? 1 : 0);
        if (a < 0) { b -= a; a = 0; }
        if (b > ok.length) { a = Math.max(0, a - (b - ok.length)); b = ok.length; }
      }
      let nN = b - a;
      const W = new Float64Array(N0), T = new Float64Array(N0);
      for (let i = 0; i < N0; i++) { W[i] = PW[b][i] - PW[a][i]; T[i] = PT[b][i] - PT[a][i]; }
      let Ls = PL[b] - PL[a];
      if (self && pos >= a && pos < b) {                       // leave the cycle itself out
        for (let i = 0; i < N0; i++) { W[i] -= c.g.warped[i]; T[i] -= c.g.map[i]; }
        Ls -= c.y.length - 1; nN--;
      }
      if (nN < 1) { c.kernel = null; continue; }
      for (let i = 0; i < N0; i++) { W[i] /= nN; T[i] /= nN; }
      // the kernel on its own uniform time grid: points (T[i], W[i]) resampled
      const Lk = Math.max(2, Math.round(Ls / nN)), ker = new Float64Array(Lk + 1);
      let i = 0;
      for (let s = 0; s <= Lk; s++) {
        const ts = s * T[N0 - 1] / Lk;
        while (i < N0 - 2 && T[i + 1] < ts) i++;
        const d = T[i + 1] - T[i];
        ker[s] = d > 0 ? W[i] + (W[i + 1] - W[i]) * Math.max(0, Math.min(1, (ts - T[i]) / d)) : W[i];
      }
      c.kernel = ker; c.T = T.map((v) => v * Lk / T[N0 - 1]);  // K0 point i -> kernel sample
      c.nN = nN;
      // this cycle warped onto its kernel
      const r = dtw2(ker, c.y, { band, wv, wd, pen: o.pen, sv, sd });
      if (!r) { c.kernel = null; continue; }
      c.map = r.map; c.warped = r.warped; c.dist = r.dist; c.Lk = Lk;
      const m = c.y.length - 1, sm = Math.max(1, Math.round((o.smoothMs || 0) * fs / 1000)) | 1;
      // timing deviation on the kernel grid: head from the start R, tail from the end R
      const dh = new Float64Array(Lk + 1), dt = new Float64Array(Lk + 1);
      for (let s = 0; s <= Lk; s++) { dh[s] = (r.map[s] - s) * c.step; dt[s] = ((r.map[s] - m) - (s - Lk)) * c.step; }
      c.dh = smooth(dh, sm).map((v) => v * 1000 / fs);
      c.dt = smooth(dt, sm).map((v) => v * 1000 / fs);
      c.spK = c.T[sp];                                          // the split on the kernel grid
    }
    };
    localPass();
    // ---- artifacts: score every cycle, leave the bad ones out of the kernels, redo ----
    const nArt = scoreArtifacts(cyc, det, { ...o, fs, pol, ampMed }) ;
    if (nArt) { for (const c of cyc) if (c.art) c.clean = false; localPass(); }

    // ---- beats: tail of the cycle before + head of the cycle after, rows on K0's grid ----
    const rows = L0, pre = L0 - sp;                             // tail rows sp..L0-1, then head rows 0..sp-1
    const tms = new Float64Array(rows);
    for (let q = 0; q < rows; q++) tms[q] = (q < pre ? (sp + q - L0) : (q - pre)) * 1000 / fs;
    const ref = new Float64Array(rows);
    for (let q = 0; q < rows; q++) ref[q] = q < pre ? K0[sp + q] : K0[q - pre];
    const byK1 = new Map(cyc.map((c) => [c.k1, c])), byK0 = new Map(cyc.map((c) => [c.k0, c]));
    const beats = [];
    det.beats.forEach((b, k) => {
      const cp = byK1.get(k), cn = byK0.get(k);
      if (!cp || !cn || !cp.kernel || !cn.kernel) return;
      if (b.r < (o.from ?? -Infinity) || b.r > (o.to ?? Infinity)) return;
      const delta = new Float64Array(rows);
      for (let q = 0; q < rows; q++) {
        if (q < pre) delta[q] = at(cp.dt, cp.T[sp + q]);
        else delta[q] = at(cn.dh, cn.T[q - pre]);
      }
      const why = [...new Set([...(cp.why || []), ...(cn.why || [])])];
      beats.push({ k, t: b.r, r: b.r, rr: cp.len, rrNext: cn.len, bad: !!bad[k], fits: cp.clean && cn.clean,
                   art: !!(cp.art || cn.art), why, q: Math.max(cp.z || 0, cn.z || 0),
                   delta, dist: (cp.dist + cn.dist) / 2, cp, cn, gain: cn.gain });
    });
    if (!beats.length) return null;
    const use = beats.filter((b) => b.fits);
    const med = new Float64Array(rows), q1 = new Float64Array(rows), q3 = new Float64Array(rows);
    for (let q = 0; q < rows; q++) {
      const s = Float64Array.from(use.map((b) => b.delta[q])).sort(), m = s.length;
      if (!m) continue;
      med[q] = s[Math.floor(0.5 * (m - 1))]; q1[q] = s[Math.floor(0.25 * (m - 1))]; q3[q] = s[Math.floor(0.75 * (m - 1))];
    }
    return { method: "kernel", fs, pre, n: rows, tms, ref, pol, beats, stats: { med, q1, q3 }, win: [Math.round(pre * 1000 / fs), Math.round(sp * 1000 / fs)],
             rrMed, L0, sp, K0, cycles: cyc, segs: f, kn, nClean: ok.length, nArt, artZ: o.artZ ?? 5 };
  }
  // natural cubic spline through (xs, ys) (xs increasing), evaluated at 0 ... n-1; flat outside
  function splineEval(xs, ys, n) {
    const k = xs.length, out = new Float64Array(n);
    const h = new Float64Array(k - 1), al = new Float64Array(k), l = new Float64Array(k), mu = new Float64Array(k), z = new Float64Array(k);
    const c = new Float64Array(k), b = new Float64Array(k - 1), d = new Float64Array(k - 1);
    for (let i = 0; i < k - 1; i++) h[i] = Math.max(1e-9, xs[i + 1] - xs[i]);
    for (let i = 1; i < k - 1; i++) al[i] = 3 / h[i] * (ys[i + 1] - ys[i]) - 3 / h[i - 1] * (ys[i] - ys[i - 1]);
    l[0] = 1;
    for (let i = 1; i < k - 1; i++) {
      l[i] = 2 * (xs[i + 1] - xs[i - 1]) - h[i - 1] * mu[i - 1];
      mu[i] = h[i] / l[i]; z[i] = (al[i] - h[i - 1] * z[i - 1]) / l[i];
    }
    l[k - 1] = 1;
    for (let j = k - 2; j >= 0; j--) {
      c[j] = z[j] - mu[j] * c[j + 1];
      b[j] = (ys[j + 1] - ys[j]) / h[j] - h[j] * (c[j + 1] + 2 * c[j]) / 3;
      d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
    }
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (i <= xs[0]) { out[i] = ys[0]; continue; }
      if (i >= xs[k - 1]) { out[i] = ys[k - 1]; continue; }
      while (j < k - 2 && xs[j + 1] < i) j++;
      const dx = i - xs[j];
      out[i] = ys[j] + b[j] * dx + c[j] * dx * dx + d[j] * dx * dx * dx;
    }
    return out;
  }
  // robust z-scores: (x - median) / (1.4826 MAD); NaN stays NaN
  function robustZ(xs) {
    const f = xs.filter(isFinite), m = median(f), mad = median(f.map((v) => Math.abs(v - m))) * 1.4826 || 1e-9;
    return xs.map((v) => (isFinite(v) ? (v - m) / mad : NaN));
  }

  /**
   * Signal quality of every cycle (Clifford-style SQIs), each as a robust z
   * against the period's cycles; c.z = the largest, c.why = the reasons,
   * c.art = artifact. Strong alone (z > artZ): distance to its kernel, poor
   * correlation with it, odd R amplitude, a baseline (DC) step, high-frequency
   * noise; saturation (the raw ADC stuck). Weaker evidence (z > 0.6 artZ) counts
   * when the strap's own beat disagrees with the ECG R or the strap moved.
   */
  function scoreArtifacts(cyc, det, o) {
    const fs = o.fs, thr = o.artZ ?? 5;
    for (const c of cyc) { c.art = false; c.z = 0; c.why = []; }
    if (!(thr > 0)) return 0;
    const live = cyc.filter((c) => c.kernel && c.warped);
    if (live.length < 8) return 0;
    const val = (fn) => robustZ(live.map(fn));
    const corr = (x, y) => {
      let mx = 0, my = 0;
      for (let i = 0; i < x.length; i++) { mx += x[i]; my += y[i]; }
      mx /= x.length; my /= y.length;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < x.length; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
      return sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
    };
    const rms = (s, p0, m) => { let t = 0; for (let i = 0; i < m; i++) { const v = at(s.hf, p0 + i); t += v * v; } return Math.sqrt(t / m); };
    const zs = {
      "kernel distance": val((c) => Math.log(c.dist + 1e-9)),
      "low correlation": val((c) => Math.log(1 - corr(c.warped, c.kernel) + 1e-4)),
      "R amplitude": val((c) => Math.log(Math.max(1e-6, c.amp / o.ampMed))).map(Math.abs),
      "baseline step": val((c) => Math.abs(det.beats[c.k1].iso - det.beats[c.k0].iso) / o.ampMed),
      "HF noise": val((c) => Math.log(rms(c.seg, c.p0, c.y.length) / o.ampMed + 1e-6)),
    };
    // the strap's beat at each R (after the typical offset; its times can drift with BLE)
    let fwMis = null;
    if (o.fw && o.fw.length) {
      const fw = o.fw, off = det.beats.map((b) => {
        let lo = 0, hi = fw.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (fw[m] < b.r) lo = m + 1; else hi = m; }
        const c = [fw[lo - 1], fw[lo]].filter((v) => v != null);
        return c.length ? c.reduce((p, v) => (Math.abs(v - b.r) < Math.abs(p - b.r) ? v : p)) - b.r : NaN;
      });
      fwMis = off.map((d, i) => {
        const w = off.slice(Math.max(0, i - 20), i + 21).filter(isFinite);
        return !isFinite(d) || Math.abs(d - median(w)) > 0.15;
      });
    }
    // movement: spread of |a| in the cycle
    let mz = null;
    if (o.acc && o.acc.t && o.acc.t.length) {
      const A = o.acc, mag = A.t.map((_, i) => Math.hypot(A.x[i], A.y[i], A.z[i]));
      mz = robustZ(live.map((c) => {
        let s = 0, s2 = 0, n = 0;
        for (let i = 0; i < A.t.length; i++) if (A.t[i] >= c.r0 && A.t[i] <= c.r1) { s += mag[i]; s2 += mag[i] * mag[i]; n++; }
        return n > 1 ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : NaN;
      }));
    }
    // a quiet recording makes the spread tiny: also require a size that matters
    const floor = {
      "baseline step": (c) => Math.abs(det.beats[c.k1].iso - det.beats[c.k0].iso) > 0.1 * o.ampMed,   // > 10 % of the R
      "R amplitude": (c) => c.amp < 0.75 * o.ampMed || c.amp > 1.33 * o.ampMed,
    };
    const runMax = Math.max(5, Math.round(0.02 * fs));
    let n = 0;
    live.forEach((c, i) => {
      let z = 0;
      for (const [k, arr] of Object.entries(zs)) if (isFinite(arr[i]) && arr[i] > 0) {
        if (floor[k] && !floor[k](c)) continue;             // statistically odd but too small to matter
        if (arr[i] > z) z = arr[i];
        if (arr[i] > thr) c.why.push(k);
      }
      // saturation: the raw value stuck at the segment's extreme (a rail) for runMax samples;
      // quiet signal repeats values too, so a run elsewhere means nothing
      const v = c.seg.v, p0 = Math.floor(c.p0), p1 = Math.min(v.length - 1, Math.ceil(c.p0 + (c.y.length - 1) * c.step));
      if (c.seg.vlo == null) { let lo = Infinity, hi = -Infinity; for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; } c.seg.vlo = lo; c.seg.vhi = hi; }
      const tol = 0.01 * (c.seg.vhi - c.seg.vlo);
      for (let j = p0 + 1, run = 1; j <= p1; j++) {
        run = v[j] === v[j - 1] ? run + 1 : 1;
        if (run >= runMax && (v[j] >= c.seg.vhi - tol || v[j] <= c.seg.vlo + tol)) { c.why.push("saturation"); break; }
      }
      const weak = z > 0.6 * thr;
      if (weak && fwMis && (fwMis[c.k0] || fwMis[c.k1])) c.why.push("strap beat disagrees");
      if (weak && mz && mz[i] > 3) c.why.push("movement");
      c.z = z;
      c.art = c.why.length > 0;
      if (c.art) n++;
    });
    return n;
  }
  function lowerBoundBy(cs, t) {
    let lo = 0, hi = cs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cs[m].r0 < t) lo = m + 1; else hi = m; }
    return lo;
  }

  // ======================================================================
  // Beat categories: features of each clean beat -> PCA -> k-means
  // ======================================================================

  /**
   * Feature vector of every usable beat of a kernel analysis: its timing
   * deviation (ms) and its shape residual after the warping (warped - kernel,
   * in units of the reference's range), each binned to `bins` points along
   * the cycle; mode: "both" | "timing" | "shape". The two blocks are scaled to
   * the same total spread so neither dominates. Returns {idx (beat indices), X}.
   */
  function beatFeatures(res, mode = "both", bins = 48) {
    const n = res.n, pre = res.pre, sp = res.sp;
    let lo = Infinity, hi = -Infinity;
    for (const v of res.ref) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const amp = hi - lo || 1;
    const edges = Array.from({ length: bins + 1 }, (_, i) => Math.round(i * n / bins));
    const idx = [], T = [], S = [];
    res.beats.forEach((b, k) => {
      if (!b.fits || b.art || !b.cp || !b.cn) return;
      const t = new Float64Array(bins), s = new Float64Array(bins);
      for (let j = 0; j < bins; j++) {
        let st = 0, ss = 0, c = 0;
        for (let q = edges[j]; q < Math.max(edges[j] + 1, edges[j + 1]); q++) {
          const cy = q < pre ? b.cp : b.cn, kq = q < pre ? cy.T[sp + q] : cy.T[q - pre];
          st += b.delta[q]; ss += (at(cy.warped, kq) - at(cy.kernel, kq)) / amp; c++;
        }
        t[j] = st / c; s[j] = ss / c;
      }
      idx.push(k); T.push(t); S.push(s);
    });
    const scale = (M) => {                       // centre; divide by the block's RMS spread
      if (!M.length) return M;
      const d = M[0].length, mu = new Float64Array(d);
      for (const r of M) for (let j = 0; j < d; j++) mu[j] += r[j] / M.length;
      let ss = 0;
      for (const r of M) for (let j = 0; j < d; j++) ss += (r[j] - mu[j]) ** 2;
      const f = Math.sqrt(ss / M.length) || 1;
      return M.map((r) => r.map((v, j) => (v - mu[j]) / f));
    };
    const Ts = scale(T), Ss = scale(S);
    const X = idx.map((_, i) => mode === "timing" ? Ts[i] : mode === "shape" ? Ss[i]
      : Float64Array.from([...Ts[i], ...Ss[i]]));
    return { idx, X, T, S, bins, edges };
  }

  /** PCA by the covariance's eigenvectors (Jacobi). Returns {Y (n x m scores), vals, frac (explained, per comp)}. */
  function pca(X, maxComp = 10, keep = 0.9) {
    const n = X.length, d = X[0].length, mu = new Float64Array(d);
    for (const r of X) for (let j = 0; j < d; j++) mu[j] += r[j] / n;
    const C = Array.from({ length: d }, () => new Float64Array(d));
    for (const r of X) for (let a = 0; a < d; a++) { const va = r[a] - mu[a]; for (let b = a; b < d; b++) C[a][b] += va * (r[b] - mu[b]); }
    for (let a = 0; a < d; a++) for (let b = a; b < d; b++) { C[a][b] /= n; C[b][a] = C[a][b]; }
    const V = Array.from({ length: d }, (_, i) => { const r = new Float64Array(d); r[i] = 1; return r; });
    for (let sweep = 0; sweep < 30; sweep++) {
      let off = 0;
      for (let p = 0; p < d; p++) for (let q = p + 1; q < d; q++) off += C[p][q] * C[p][q];
      if (off < 1e-14) break;
      for (let p = 0; p < d; p++) for (let q = p + 1; q < d; q++) {
        if (Math.abs(C[p][q]) < 1e-15) continue;
        const th = (C[q][q] - C[p][p]) / (2 * C[p][q]);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < d; k++) {
          const a = C[k][p], b = C[k][q];
          C[k][p] = c * a - s * b; C[k][q] = s * a + c * b;
        }
        for (let k = 0; k < d; k++) {
          const a = C[p][k], b = C[q][k];
          C[p][k] = c * a - s * b; C[q][k] = s * a + c * b;
        }
        for (let k = 0; k < d; k++) {
          const a = V[k][p], b = V[k][q];
          V[k][p] = c * a - s * b; V[k][q] = s * a + c * b;
        }
      }
    }
    const order = Array.from({ length: d }, (_, i) => i).sort((a, b) => C[b][b] - C[a][a]);
    const vals = order.map((i) => Math.max(0, C[i][i])), tot = vals.reduce((a, b) => a + b, 0) || 1;
    let m = 0, cum = 0;
    while (m < Math.min(maxComp, d) && (m < 2 || cum < keep)) { cum += vals[m] / tot; m++; }
    const Y = X.map((r) => Float64Array.from({ length: m }, (_, c) => {
      const col = order[c];
      let v = 0;
      for (let j = 0; j < d; j++) v += (r[j] - mu[j]) * V[j][col];
      return v;
    }));
    return { Y, vals: vals.slice(0, m), frac: vals.slice(0, m).map((v) => v / tot), m };
  }

  // k-means++ (seeded, best of `restarts`), returns {lab, cent, sse}
  function kmeans(Y, k, restarts = 8, seed = 1) {
    let rnd = seed;
    const rand = () => { rnd = (rnd * 16807) % 2147483647; return (rnd - 1) / 2147483646; };
    const n = Y.length, d = Y[0].length, dist2 = (a, b) => { let s = 0; for (let j = 0; j < d; j++) s += (a[j] - b[j]) ** 2; return s; };
    let best = null;
    for (let r = 0; r < restarts; r++) {
      const cent = [Float64Array.from(Y[Math.floor(rand() * n)])];
      while (cent.length < k) {
        const dd = Y.map((y) => Math.min(...cent.map((c) => dist2(y, c))));
        let u = rand() * dd.reduce((a, b) => a + b, 0), i = 0;
        while (i < n - 1 && (u -= dd[i]) > 0) i++;
        cent.push(Float64Array.from(Y[i]));
      }
      const lab = new Int32Array(n);
      for (let it = 0; it < 100; it++) {
        let moved = 0;
        for (let i = 0; i < n; i++) {
          let bj = 0, bd = Infinity;
          for (let j = 0; j < k; j++) { const v = dist2(Y[i], cent[j]); if (v < bd) { bd = v; bj = j; } }
          if (lab[i] !== bj) { lab[i] = bj; moved++; }
        }
        const sum = cent.map(() => new Float64Array(d)), cnt = new Int32Array(k);
        for (let i = 0; i < n; i++) { cnt[lab[i]]++; for (let j = 0; j < d; j++) sum[lab[i]][j] += Y[i][j]; }
        for (let j = 0; j < k; j++) if (cnt[j]) cent[j] = sum[j].map((v) => v / cnt[j]);
        if (!moved && it) break;
      }
      let sse = 0;
      for (let i = 0; i < n; i++) sse += dist2(Y[i], cent[lab[i]]);
      if (!best || sse < best.sse) best = { lab, cent, sse };
    }
    return best;
  }
  // mean silhouette (Euclidean)
  function silhouette(Y, lab, k) {
    const n = Y.length, d = Y[0].length;
    if (k < 2) return 0;
    let tot = 0;
    for (let i = 0; i < n; i++) {
      const sum = new Float64Array(k), cnt = new Int32Array(k);
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        let s = 0;
        for (let q = 0; q < d; q++) s += (Y[i][q] - Y[j][q]) ** 2;
        sum[lab[j]] += Math.sqrt(s); cnt[lab[j]]++;
      }
      const a = cnt[lab[i]] ? sum[lab[i]] / cnt[lab[i]] : 0;
      let b = Infinity;
      for (let c = 0; c < k; c++) if (c !== lab[i] && cnt[c]) b = Math.min(b, sum[c] / cnt[c]);
      tot += isFinite(b) && Math.max(a, b) > 0 ? (b - a) / Math.max(a, b) : 0;
    }
    return tot / n;
  }

  /**
   * Categories of the beats. o: {mode, k (0 = choose 2..6 by the silhouette)}.
   * Beats further from their centre than median + 4 MAD (of all such
   * distances) are outliers (label -1). Clusters are renumbered by size.
   * Returns {idx, lab (per idx), pc (2-D scores), k, sil, sils, frac, X}.
   */
  function categorize(res, o = {}) {
    const F = beatFeatures(res, o.mode || "both");
    if (F.idx.length < 20) return null;
    const P = pca(F.X, 10, 0.9);
    // isolated beats first (far from their 5th nearest neighbour): they would otherwise pull a centroid of their own.
    // A real group, however far from the bulk, has close neighbours and stays.
    const nn = P.Y.map((y, i) => {
      const d = [];
      for (let j = 0; j < P.Y.length; j++) if (j !== i) d.push(y.reduce((s, v, q) => s + (v - P.Y[j][q]) ** 2, 0));
      d.sort((a, b) => a - b);
      return Math.sqrt(d[Math.min(4, d.length - 1)]);
    });
    const m0 = median(nn), mad0 = median(nn.map((v) => Math.abs(v - m0))) * 1.4826 || 1e-9;
    const inl = [];
    nn.forEach((d, i) => { if (d <= m0 + 6 * mad0) inl.push(i); });
    const Yi = inl.map((i) => P.Y[i]);
    const minSize = Math.max(5, Math.ceil(0.03 * Yi.length));          // a group of fewer is not a kind of beat
    const tries = o.k ? [o.k] : [2, 3, 4, 5, 6];
    let best = null;
    const sils = {};
    for (const k of tries) {
      const km = kmeans(Yi, k);
      const sil = silhouette(Yi, km.lab, k);
      sils[k] = sil;
      const small = Array.from({ length: k }, (_, c) => km.lab.filter((l) => l === c).length).some((n) => n < minSize);
      const cand = { ...km, k, sil, small };
      if (!best || (best.small && !small) || (best.small === small && sil > best.sil)) best = cand;
    }
    const lab = new Int32Array(P.Y.length).fill(-1);
    inl.forEach((i, j) => { lab[i] = best.lab[j]; });
    const dd = P.Y.map((y, i) => (lab[i] < 0 ? Infinity : Math.sqrt(y.reduce((s, v, j) => s + (v - best.cent[lab[i]][j]) ** 2, 0))));
    const fin = dd.filter(isFinite), m = median(fin), mad = median(fin.map((v) => Math.abs(v - m))) * 1.4826 || 1e-9;
    for (let i = 0; i < lab.length; i++) if (dd[i] > m + 4 * mad) lab[i] = -1;
    const cnt = Array.from({ length: best.k }, (_, c) => lab.filter((l) => l === c).length);
    for (let i = 0; i < lab.length; i++) if (lab[i] >= 0 && cnt[lab[i]] < minSize) lab[i] = -1;
    // renumber by size, dropping groups that ended up too small
    const keep = cnt.map((c, i) => i).filter((c) => cnt[c] >= minSize).sort((a, b) => cnt[b] - cnt[a]), ren = new Map(keep.map((c, i) => [c, i]));
    best.k = keep.length;
    return { idx: F.idx, lab: Array.from(lab, (l) => (l < 0 ? -1 : ren.get(l))), pc: P.Y.map((y) => [y[0], y[1] || 0]), k: best.k,
             sil: best.sil, sils, frac: P.frac, T: F.T, S: F.S, bins: F.bins, edges: F.edges };
  }

  /** Pearson r and least-squares slope of y on x (finite pairs only). */
  function fit(x, y) {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < x.length; i++) {
      if (!isFinite(x[i]) || !isFinite(y[i])) continue;
      n++; sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; syy += y[i] * y[i];
    }
    if (n < 3) return null;
    const vx = sxx - sx * sx / n, vy = syy - sy * sy / n, c = sxy - sx * sy / n;
    return { n, slope: vx ? c / vx : NaN, icept: (sy - (vx ? c / vx : 0) * sx) / n, r: vx && vy ? c / Math.sqrt(vx * vy) : NaN };
  }

  const BeatDTW = { prep, filtfilt, biquad, detect, extract, dtw2, kernelAnalyse, resample, beatFeatures, pca, kmeans, silhouette, categorize, reference, dtw, smooth, analyse, fit, median };
  root.BeatDTW = BeatDTW;
  if (typeof module !== "undefined") module.exports = BeatDTW;
})(typeof window !== "undefined" ? window : globalThis);
