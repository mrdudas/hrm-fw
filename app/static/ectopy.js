/* ECG ectopy analysis from the raw single-lead ECG (works in the browser and in node).
 *
 *   R peaks      band-pass 5–25 Hz, energy envelope, adaptive threshold with search-back,
 *                250 ms refractory, peak refined on the 0.5–40 Hz trace (dominant polarity).
 *   quality      per beat (sqi 0..1): noise between the QRS complexes, high-frequency (EMG)
 *                noise, the accelerometer's movement; QRS correlation to the dominant template.
 *                Only a bad signal makes an ARTIFACT -- an irregular R-R in a clean signal never does.
 *   sinus R-R    the median of the clean, non-premature, non-alternating R-Rs of the last 3 min,
 *                so a bigeminy (half the beats early) does not drag it down.
 *   patterns     bigeminy: dRR changes sign beat to beat with |dRR| >= max(80 ms, 8 % sinus),
 *                >= 6 alternating R-Rs to start, ends after 2 non-alternating pairs; short/long
 *                0.70–0.92, its CV < 0.10. Trigeminy: an early beat every third beat.
 *                Type from short + long against the sinus R-R and the QRS shape:
 *                  S + L < 1.97 x sinus                       -> PAC (no compensatory pause)
 *                  S + L = 2 x sinus +-3 %, wide / other QRS  -> PVC
 *                  mean R-R in the episode > sinus            -> GROUPED_BLOCK_SUSPECT
 *                A slow (breathing) R-R wave rises and falls over several beats: no beat-to-beat
 *                sign change, so it never makes an episode.
 *   isolated     an early beat (<= sinus - threshold, the next R-R longer) outside episodes:
 *                PAC, or PVC when its QRS is wide (>= 120 ms) or unlike the template (r < 0.9).
 *                The P wave is not used to rule anything out.
 *   gaps         R-Rs across lost ECG samples are invalid (GAP), never a pause.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Ectopy = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const P = {
    version: 1,
    refractory: 0.25,      // s
    minDelta: 80,          // ms: alternation threshold floor ...
    deltaFrac: 0.08,       // ... or this share of the sinus R-R
    startRR: 6,            // alternating R-Rs to start an episode
    endPairs: 2,           // non-alternating pairs (R-Rs) to end it
    ratioLo: 0.70, ratioHi: 0.92, ratioCV: 0.10,
    pacSum: 1.97, pvcTol: 0.03,
    sinusWin: 300,         // s
    pauseFrac: 1.5,
    boutGap: 30,           // s: episodes closer than this make one bout (overview)        // R-R > this x sinus in a clean signal: pause
    sqiMin: 0.35,          // below: ARTIFACT
    wideQRS: 120, corrPVC: 0.9,
  };
  const median = (a) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const pct = (a, q) => { const s = Float64Array.from(a).sort(); return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))] : NaN; };

  // ---------- filters (biquads, run forward and backward: zero phase) ----------
  function biquad(type, f, fs, q = Math.SQRT1_2) {
    const w = 2 * Math.PI * f / fs, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    let b0, b1, b2;
    if (type === "lp") { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; } else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
    const a0 = 1 + al;
    return [b0 / a0, b1 / a0, b2 / a0, (-2 * c) / a0, (1 - al) / a0];
  }
  function run(x, k) {
    const [b0, b1, b2, a1, a2] = k, y = new Float64Array(x.length);
    let x1 = x[0], x2 = x[0], y1 = 0, y2 = 0;
    // start settled at the first sample (no step at the start)
    const dc = (b0 + b1 + b2) / (1 + a1 + a2); y1 = y2 = x[0] * dc;
    for (let i = 0; i < x.length; i++) {
      const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
    }
    return y;
  }
  function filtfilt(x, ks) {
    let y = Float64Array.from(x);
    for (const k of ks) { y = run(y, k); y.reverse(); y = run(y, k); y.reverse(); }
    return y;
  }
  function notch(x, f0, fs) {
    if (!f0) return x;
    const w = 2 * Math.PI * f0 / fs, c = Math.cos(w), r = 0.985;
    const k = [1, -2 * c, 1, -2 * r * c, r * r], g = (1 + -2 * r * c + r * r) / (2 - 2 * c);
    return filtfilt(x, [[k[0] * g, k[1] * g, k[2] * g, k[3], k[4]]]);
  }

  // ---------- A) R peaks in one segment ----------
  function detectR(v, fs) {
    const n = v.length;
    if (n < fs * 2) return { r: [], y: null, bp: null };
    const bp = filtfilt(v, [biquad("hp", 5, fs), biquad("lp", 25, fs)]);
    const y = filtfilt(v, [biquad("hp", 0.5, fs), biquad("lp", 40, fs)]);
    // energy envelope: squared slope, 120 ms moving mean
    const e = new Float64Array(n), W = Math.round(0.12 * fs);
    for (let i = 1; i < n; i++) { const d = bp[i] - bp[i - 1]; e[i] = d * d; }
    const env = new Float64Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) { acc += e[i]; if (i >= W) acc -= e[i - W]; env[i] = acc / W; }
    const sh = W >> 1;                              // centre the moving window
    // candidates: envelope maxima at least the refractory period apart
    const R = Math.round(P.refractory * fs), cand = [];
    for (let i = 1; i < n - 1; i++) {
      if (env[i] <= env[i - 1] || env[i] < env[i + 1]) continue;
      if (cand.length && i - cand[cand.length - 1] < R) { if (env[i] > env[cand[cand.length - 1]]) cand[cand.length - 1] = i; continue; }
      cand.push(i);
    }
    // adaptive threshold (signal / noise peak levels), seeded on the first 2 s
    const first = cand.filter((i) => i < 2 * fs).map((i) => env[i]);
    let spk = first.length ? Math.max(...first) * 0.6 : env[cand[0]] || 1, npk = spk * 0.1;
    const beats = [];
    let rrAvg = fs * 0.9;
    for (let k = 0; k < cand.length; k++) {
      const i = cand[k], thr = npk + 0.25 * (spk - npk);
      // search back: nothing for 1.66 x the mean R-R -> the largest candidate in it over half the threshold
      if (beats.length) {
        const last = beats[beats.length - 1];
        if (i - last > 1.66 * rrAvg) {
          let best = -1;
          for (let j = k - 1; j >= 0 && cand[j] > last; j--) if (cand[j] - last >= R && i - cand[j] >= R && env[cand[j]] > thr / 2 && (best < 0 || env[cand[j]] > env[best])) best = cand[j];
          if (best >= 0) { beats.push(best); spk = 0.25 * env[best] + 0.75 * spk; }
        }
      }
      if (env[i] > thr) {
        if (beats.length && i - beats[beats.length - 1] < R) continue;
        if (beats.length) { const rr = i - beats[beats.length - 1]; if (rr < 2.5 * fs) rrAvg = 0.875 * rrAvg + 0.125 * rr; }
        beats.push(i); spk = 0.125 * env[i] + 0.875 * spk;
      } else npk = 0.125 * env[i] + 0.875 * npk;
    }
    beats.sort((a, b) => a - b);
    // refine on the 0.5–40 Hz trace: the largest deviation of the dominant polarity, +-80 ms
    const H = Math.round(0.08 * fs), raw = [];
    for (const b0 of beats) {
      const c = Math.min(n - 1, b0 - sh + Math.round(0.03 * fs));
      let hi = -Infinity, lo = Infinity, ih = c, il = c;
      for (let j = Math.max(0, c - H); j <= Math.min(n - 1, c + H); j++) { if (y[j] > hi) { hi = y[j]; ih = j; } if (y[j] < lo) { lo = y[j]; il = j; } }
      raw.push([ih, il, hi, lo]);
    }
    // polarity: whichever side is larger in most beats
    let up = 0;
    for (const [ih, il, hi, lo] of raw) { const base = y[Math.max(0, ih - Math.round(0.2 * fs))]; if (hi - base > base - lo) up++; }
    const pos = up >= raw.length / 2;
    const r = [];
    for (const q of raw) { const j = pos ? q[0] : q[1]; if (!r.length || j - r[r.length - 1] >= R) r.push(j); }
    const missed = searchMissed(r, y, fs, pos ? 1 : -1);
    return { r, y, bp, pol: pos ? 1 : -1, missed };
  }

  /* A long interval may hide a beat the threshold missed (a smaller QRS in noise): slide the
   * segment's QRS template over it; a place that matches (r >= 0.8) at >= 35 % of the usual
   * R amplitude is a beat. Changes r in place, returns how many were added. */
  function searchMissed(r, y, fs, pol) {
    if (r.length < 20) return 0;
    const H = Math.round(0.08 * fs), L = 2 * H + 1, wins = [], amps = [], rrs = [];
    for (let k = 1; k < r.length; k++) rrs.push(r[k] - r[k - 1]);
    const mrr = median(rrs);
    for (let k = 0; k < r.length; k += Math.max(1, Math.floor(r.length / 300))) {
      const i = r[k]; if (i - H < 0 || i + H >= y.length) continue;
      const base = baseAt(y, i, fs), w = new Float64Array(L);
      for (let j = 0; j < L; j++) w[j] = y[i - H + j] - base;
      wins.push(w); amps.push(Math.abs(y[i] - base));
    }
    const tp = new Float64Array(L);
    for (let j = 0; j < L; j++) tp[j] = median(wins.map((w) => w[j]));
    const amp = median(amps);
    let added = 0;
    for (let k = 1; k < r.length; k++) {
      const a = r[k - 1], b = r[k];
      if (b - a < Math.max(1.4 * mrr, 1.2 * fs)) continue;
      let best = -1, bc = 0;
      const lo = a + Math.round(0.3 * fs), hi = b - Math.round(0.3 * fs);
      for (let c = Math.max(lo, H); c <= Math.min(hi, y.length - H - 1); c += 2) {
        if (pol * (y[c] - y[c - 1]) < 0 || pol * (y[c + 1] - y[c]) > 0) continue;   // only at a peak of the right polarity
        const w = y.subarray(c - H, c + H + 1), cc = corr(w, tp);
        if (cc > bc && Math.abs(y[c] - baseAt(y, c, fs)) >= 0.35 * amp) { bc = cc; best = c; }
      }
      if (best >= 0 && bc >= 0.8) { r.splice(k, 0, best); added++; }
    }
    return added;
  }

  // ---------- B) beat features ----------
  const TW = [-0.1, 0.15];                          // template window around R, s
  function beatWin(y, i, fs, a = TW[0], b = TW[1]) {
    const i0 = i + Math.round(a * fs), i1 = i + Math.round(b * fs);
    if (i0 < 0 || i1 >= y.length) return null;
    const w = new Float64Array(i1 - i0 + 1), base = baseAt(y, i, fs);
    for (let j = i0; j <= i1; j++) w[j - i0] = y[j] - base;
    return w;
  }
  function baseAt(y, i, fs) {                      // PR-segment level: median of -130..-70 ms
    const a = Math.max(0, i - Math.round(0.13 * fs)), b = Math.max(0, i - Math.round(0.07 * fs)), v = [];
    for (let j = a; j <= b; j++) v.push(y[j]);
    return median(v);
  }
  function corr(a, b, i0 = 0, i1 = a.length - 1) {
    let sa = 0, sb = 0, n = 0;
    for (let i = i0; i <= i1; i++) { sa += a[i]; sb += b[i]; n++; }
    sa /= n; sb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = i0; i <= i1; i++) { const x = a[i] - sa, z = b[i] - sb; num += x * z; da += x * x; db += z * z; }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
  }
  // QRS width: where the band-passed slope energy stays above 10 % of its peak around R
  function qrsWidth(y, i, fs) {
    const H = Math.round(0.12 * fs), a = Math.max(2, i - H), b = Math.min(y.length - 3, i + H);
    const sm = Math.max(1, Math.round(0.004 * fs)), sl = (j) => Math.abs(y[j + sm] - y[j - sm]);
    let pk = 0;
    for (let j = a; j <= b; j++) pk = Math.max(pk, sl(j));
    const thr = 0.12 * pk, run = Math.round(0.012 * fs);        // quiet for 12 ms marks the edge
    const edge = (from, dir, lim) => {
      let q = 0;
      for (let j = from; dir < 0 ? j > lim : j < lim; j += dir) { if (sl(j) < thr) { if (++q >= run) return j - dir * (run - 1); } else q = 0; }
      return lim;
    };
    return (edge(i, 1, b) - edge(i, -1, a)) / fs * 1000;
  }

  // ---------- the whole analysis ----------
  /* ecg: {fs, segs:[{t, v}], notched}, acc (optional): {t, x, y, z, steps?} in raw counts.
   * onProgress(fraction, text) optional. */
  function analyze(ecg, acc, onProgress) {
    const fs = ecg.fs, prog = onProgress || (() => {});
    const beats = [];                                // {t, seg, i, amp, w (window), width, nq, hf}
    const segs = ecg.segs.filter((s) => s.v.length > 2 * fs).sort((a, b) => a.t - b.t);
    let missedAdded = 0, done = 0, total = segs.reduce((s, g) => s + g.v.length, 0);
    for (let si = 0; si < segs.length; si++) {
      const s = segs[si];
      const v = ecg.notched ? Float64Array.from(s.v) : notch(Float64Array.from(s.v), 50, fs);
      const d = detectR(v, fs);
      const hf = filtfilt(v, [biquad("hp", 40, fs)]);
      for (let k = 0; k < d.r.length; k++) {
        const i = d.r[k];
        const amp = Math.abs(d.y[i] - baseAt(d.y, i, fs));
        // noise between the QRS complexes: p2p of the 0.5–40 trace in [R+0.45 s, next R-0.15 s]
        // (or in the 0.6 s before R when the gap is short) against the R amplitude
        const nxt = k + 1 < d.r.length ? d.r[k + 1] : Math.min(v.length - 1, i + fs);
        let a0 = i + Math.round(0.45 * fs), a1 = nxt - Math.round(0.15 * fs);
        if (a1 - a0 < 0.1 * fs) { a0 = Math.max(0, i - Math.round(0.6 * fs)); a1 = i - Math.round(0.15 * fs); }
        let lo = Infinity, hi = -Infinity;
        for (let j = Math.max(0, a0); j <= Math.min(v.length - 1, a1); j++) { if (d.y[j] < lo) lo = d.y[j]; if (d.y[j] > hi) hi = d.y[j]; }
        let e = 0, m = 0;
        for (let j = Math.max(0, i - fs / 2); j < Math.min(v.length, i + fs / 2); j++) { if (Math.abs(j - i) < 0.06 * fs) continue; e += hf[j] * hf[j]; m++; }
        beats.push({ t: s.t + i / fs, seg: si, first: k === 0, amp, nq: hi > lo ? (hi - lo) / Math.max(1, amp) : 0,
                     hf: Math.sqrt(e / Math.max(1, m)) / Math.max(1, amp), width: qrsWidth(d.y, i, fs),
                     w: beatWin(d.y, i, fs, -0.25, 0.4) });
      }
      missedAdded += d.missed || 0;
      done += s.v.length;
      prog(0.8 * done / total, "R peaks");
    }
    // segments can overlap after a reconnect: keep time order, drop beats closer than the refractory period
    beats.sort((a, b) => a.t - b.t);
    for (let i = beats.length - 1; i > 0; i--) if (beats[i].t - beats[i - 1].t < P.refractory) beats.splice(i, 1);
    const n = beats.length;
    // wide QRS: >= 120 ms and 40 ms wider than this recording's usual QRS (a single-lead strap with its
    // filters can measure every QRS wide; a PVC is wide against the beats around it)
    const wUsual = median(beats.map((b) => b.width));
    const wide = (b) => b.width >= Math.max(P.wideQRS, wUsual + 40) || b.corr < P.corrPVC;
    // accelerometer: movement (SD of |a| over +-1 s, in g) and gravity
    let accT = null, accM = null, G = 16384;
    if (acc && acc.t && acc.t.length > 10) {
      accT = acc.t; accM = acc.t.map((_, i) => Math.hypot(acc.x[i], acc.y[i], acc.z[i]));
      G = median(accM) || 16384;
    }
    const movement = (t) => {
      if (!accT) return null;
      let lo = 0, hi = accT.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (accT[m] < t - 1) lo = m + 1; else hi = m; }
      const v = [];
      for (let i = lo; i < accT.length && accT[i] <= t + 1; i++) v.push(accM[i] / G);
      if (v.length < 3) return null;
      const m = mean(v);
      return Math.sqrt(mean(v.map((x) => (x - m) ** 2)));
    };
    // dominant template: median of beats with a quiet surrounding (pass 1), then per-beat correlation
    const off = Math.round(0.25 * fs), q0 = off + Math.round(TW[0] * fs), q1 = off + Math.round(TW[1] * fs);
    const tplOf = (sel) => {
      const L = q1 - q0 + 1, tp = new Float64Array(L), cols = Array.from({ length: L }, () => []);
      for (const b of sel) for (let j = 0; j < L; j++) cols[j].push(b.w[q0 + j]);
      for (let j = 0; j < L; j++) tp[j] = median(cols[j]);
      return tp;
    };
    const quiet = beats.filter((b) => b.w && b.nq < 0.6 && b.hf < 0.1);
    const pick = quiet.length > 50 ? quiet : beats.filter((b) => b.w);
    const step = Math.max(1, Math.floor(pick.length / 400));
    const tpl = tplOf(pick.filter((_, i) => i % step === 0));
    const tq = Math.round(0.08 * fs);                // correlation over the QRS: R +-80 ms
    const c0 = off - tq - q0, c1 = off + tq - q0;
    for (const b of beats) {
      if (b.w) { const seg = b.w.subarray(q0, q1 + 1); b.corr = corr(seg, tpl, Math.max(0, c0), Math.min(seg.length - 1, c1)); }
      else b.corr = 1;                                 // at a segment's edge: no window, judged by the noise only
      b.mov = movement(b.t);
      // sqi: the worst of noise between beats, EMG, movement; a beat unlike the template counts
      // against it only when the surroundings are noisy too (a PVC in a clean trace is not noise)
      const sNq = clamp01((1.6 - b.nq) / 1.0), sHf = clamp01((0.35 - b.hf) / 0.25);
      const sMov = b.mov == null ? 1 : clamp01((0.12 - b.mov) / 0.08);
      let sqi = Math.min(sNq, sHf, sMov);
      if (b.corr < 0.5 && sqi < 0.7) sqi = Math.min(sqi, 0.3);
      b.sqi = sqi;
    }
    prog(0.85, "rhythm");

    // R-R: invalid across lost samples (a new segment) -- not a pause
    const rr = new Float64Array(n).fill(NaN);
    for (let i = 1; i < n; i++) if (beats[i].seg === beats[i - 1].seg) rr[i] = (beats[i].t - beats[i - 1].t) * 1000;
    // a long R-R is believed only in a quiet interval: twice the recording's usual noise there makes
    // it an artifact (most often a QRS lost in the noise), not a pause
    const nqMed = median(beats.map((b) => b.nq)), noisy = (b) => b.nq > Math.max(0.35, 2 * nqMed);
    const bad = (i) => !(rr[i] === rr[i]) || beats[i].sqi < P.sqiMin || beats[i - 1].sqi < P.sqiMin;

    // sinus R-R per beat, two passes: first a global median, then without the alternating / early beats
    const valid = []; for (let i = 1; i < n; i++) if (!bad(i)) valid.push(rr[i]);
    let sinus = new Float64Array(n).fill(median(valid));
    let altIdx = null, early = null;
    for (let pass = 0; pass < 2; pass++) {
      const thr = (i) => Math.max(P.minDelta, P.deltaFrac * sinus[i]);
      // alternation at R-R i: dRR before and after change sign, both large enough
      altIdx = new Uint8Array(n);
      for (let i = 2; i < n - 1; i++) {
        if (bad(i) || bad(i - 1) || bad(i + 1)) continue;
        const d1 = rr[i] - rr[i - 1], d2 = rr[i + 1] - rr[i];
        if (d1 * d2 < 0 && Math.abs(d1) >= thr(i) && Math.abs(d2) >= thr(i)) altIdx[i] = 1;
      }
      // early beat: shorter than the sinus R-R by the threshold, and the next R-R longer
      early = new Uint8Array(n);
      for (let i = 2; i < n - 1; i++) if (!bad(i) && !bad(i - 1) && !bad(i + 1) && rr[i] <= sinus[i] - thr(i) &&
                                          rr[i - 1] - rr[i] >= thr(i) && rr[i + 1] - rr[i] >= thr(i)) early[i] = 1;
      if (pass === 1) break;
      // the sinus R-R: clean R-Rs of the last sinusWin s, leaving out alternating, early and post-early beats
      const near = (arr, i, k) => { for (let j = Math.max(0, i - k); j <= Math.min(n - 1, i + k); j++) if (arr[j]) return true; return false; };
      const ok = []; for (let i = 1; i < n; i++) if (!bad(i) && !near(altIdx, i, 8) && !near(early, i, 1)) ok.push(i);
      const s2 = new Float64Array(n);
      let lo = 0;
      for (let i = 0, k = 0; i < n; i++) {
        while (k < ok.length && beats[ok[k]].t <= beats[i].t) k++;
        while (lo < k && beats[ok[lo]].t < beats[i].t - P.sinusWin) lo++;
        const win = []; for (let j = lo; j < k; j++) win.push(rr[ok[j]]);
        // few clean beats (a long bigeminy, its short breaks are early beats too): the upper part of the
        // R-Rs around, i.e. of the long ones
        let all = 0; for (let j = Math.max(1, i - 400); j < Math.min(n, i + 1); j++) if (!bad(j) && beats[j].t >= beats[i].t - P.sinusWin) all++;
        if (win.length < 30 || win.length < 0.3 * all) {
          const near = []; for (let j = 1; j < n; j++) if (!bad(j) && Math.abs(beats[j].t - beats[i].t) < P.sinusWin) near.push(rr[j]);
          s2[i] = near.length ? pct(near, 0.75) : sinus[i];
        } else s2[i] = median(win);
      }
      sinus = s2;
    }

    // C) bigeminy episodes: >= startRR alternating R-Rs; end after endPairs non-alternating pairs
    const label = new Array(n).fill("N"), ep = new Int32Array(n).fill(-1), episodes = [];
    const closeEp = (i0, i1, kind) => {
      // short R-Rs: the ones below both neighbours inside [i0, i1]
      const sh = [], lo = [], ratios = [];
      // (R-Rs of a bad signal are left out of everything)
      for (let i = i0; i <= i1; i++) {
        if (bad(i)) continue;
        const a = i > i0 && !bad(i - 1) ? rr[i - 1] : rr[i + 1], b = i < i1 && !bad(i + 1) ? rr[i + 1] : rr[i - 1];
        if (rr[i] < Math.min(a, b)) { sh.push(i); if (i + 1 <= i1 && !bad(i + 1)) { lo.push(i + 1); ratios.push(rr[i] / rr[i + 1]); } }
      }
      if (sh.length < 3 || ratios.length < 3) return;
      // robust CV (1.4826 x MAD / median): a pair or two out of step must not void a long episode
      const ratio = median(ratios), cv = 1.4826 * median(ratios.map((r) => Math.abs(r - ratio))) / ratio;
      const sMean = mean(sh.map((i) => rr[i])), lMean = mean(lo.map((i) => rr[i]));
      const sin = median(sh.map((i) => sinus[i])), sum = sMean + lMean;
      const all = []; for (let i = i0; i <= i1; i++) if (!bad(i) && !(rr[i] > P.pauseFrac * sinus[i] && noisy(beats[i - 1]))) all.push(rr[i]);
      const meanRR = mean(all);
      const wideEp = sh.filter((i) => wide(beats[i])).length > sh.length / 2;
      let type;
      if (!(ratio >= P.ratioLo && ratio <= P.ratioHi) || cv >= P.ratioCV) type = "IRREGULAR";
      else if (meanRR > 1.03 * sin) type = "GROUPED_BLOCK_SUSPECT";
      else if (Math.abs(sum / (2 * sin) - 1) <= P.pvcTol && wideEp) type = "PVC";
      else if (sum < P.pacSum * sin) type = "PAC";
      else type = wideEp ? "PVC" : "PAC";
      const k = episodes.length;
      for (let i = i0 - 1; i <= i1; i++) if (i >= 0) ep[i] = k;
      if (type !== "IRREGULAR") for (const i of sh) label[i] = (kind === "tri" ? "TRIGEMINY_" : "BIGEMINY_") + (type === "GROUPED_BLOCK_SUSPECT" ? "BLOCK" : type);
      const t0 = beats[Math.max(0, i0 - 1)].t, t1 = beats[i1].t;
      const mv = []; for (let i = i0; i <= i1; i++) if (beats[i].mov != null) mv.push(beats[i].mov);
      episodes.push({ kind: kind === "tri" ? "trigeminy" : "bigeminy", type, t0, t1, dur: t1 - t0, i0, i1, pairs: sh.length,
                      shortMean: sMean, longMean: lMean, ratio, ratioCV: cv, sinusRR: sin, sum, sumRatio: sum / sin,
                      meanRR, hr: 60000 / meanRR, movement: mv.length ? median(mv) : null, posture: null });
    };
    let run = 0, start = -1, fails = 0, last = -1;
    for (let i = 2; i < n - 1; i++) {
      if (altIdx[i]) {
        run++; fails = 0; last = i;
        if (start < 0 && run >= P.startRR) start = i - run + 1;
      } else {
        run = 0;
        if (start >= 0) {
          fails++;
          if (fails >= 2 * P.endPairs || !(rr[i] === rr[i])) { closeEp(start - 1, last + 1, "bi"); start = -1; fails = 0; }
        }
      }
    }
    if (start >= 0) closeEp(start - 1, last + 1, "bi");
    // trigeminy: early beats exactly every third beat, >= 3 cycles, outside bigeminy
    for (let i = 1; i < n; i++) {
      if (!early[i] || ep[i] >= 0) continue;
      let j = i, cyc = 1;
      while (j + 3 < n && early[j + 3] && !early[j + 1] && !early[j + 2] && ep[j + 3] < 0) { j += 3; cyc++; }
      if (cyc >= 3) { closeEp(i, j + 1, "tri"); i = j + 1; }
    }
    // isolated early beats, pauses, artifacts
    for (let i = 1; i < n; i++) {
      if (!(rr[i] === rr[i])) { label[i] = beats[i].first ? "GAP" : label[i]; continue; }
      if (beats[i].sqi < P.sqiMin) { label[i] = "ARTIFACT"; continue; }
      if (label[i] !== "N") continue;
      if (rr[i] > P.pauseFrac * sinus[i]) {            // also inside an episode (a blocked early beat looks like this)
        label[i] = bad(i) || noisy(beats[i - 1]) ? "ARTIFACT" : "PAUSE";
        if (label[i] === "PAUSE" && ep[i] >= 0) episodes[ep[i]].pauses = (episodes[ep[i]].pauses || 0) + 1;
        continue;
      }
      if (ep[i] >= 0 && episodes[ep[i]].type !== "IRREGULAR") continue;
      if (early[i]) label[i] = wide(beats[i]) ? "PVC" : "PAC";
    }
    for (let i = 0; i < n; i++) if (!(rr[i] === rr[i]) && i > 0 && beats[i].first) label[i] = "GAP";

    // posture: gravity against the "upright" direction learned while walking (steps), if any
    if (acc && acc.steps && accT) {
      const up = [0, 0, 0]; let c = 0;
      for (let i = 1; i < accT.length; i++) if (acc.steps[i] > acc.steps[i - 1]) { up[0] += acc.x[i]; up[1] += acc.y[i]; up[2] += acc.z[i]; c++; }
      if (c > 50) {
        const nu = Math.hypot(...up);
        for (const e of episodes) {
          const g = [0, 0, 0]; let m = 0;
          for (let i = 0; i < accT.length; i++) if (accT[i] >= e.t0 && accT[i] <= e.t1) { g[0] += acc.x[i]; g[1] += acc.y[i]; g[2] += acc.z[i]; m++; }
          if (!m) continue;
          const cos = (g[0] * up[0] + g[1] * up[1] + g[2] * up[2]) / (Math.hypot(...g) * nu);
          e.posture = cos > 0.85 ? "upright" : cos < 0.5 ? "lying" : "reclined";
        }
      }
    }

    // bouts: the episodes (spec rule: 2 non-alternating pairs end one) joined when < boutGap s apart
    const eps = episodes.filter((e) => e.type !== "IRREGULAR"), bouts = [];
    for (const e of eps) {
      const b = bouts[bouts.length - 1];
      if (b && b.kind === e.kind && e.t0 - b.t1 < P.boutGap) { b.t1 = e.t1; b.n++; b.pairs += e.pairs; b.types.add(e.type); b.eps.push(e); }
      else bouts.push({ kind: e.kind, t0: e.t0, t1: e.t1, n: 1, pairs: e.pairs, types: new Set([e.type]), eps: [e] });
    }
    for (const b of bouts) {
      b.dur = b.t1 - b.t0; b.types = [...b.types];
      const w = b.eps.reduce((s, e) => s + e.pairs, 0), wm = (k) => b.eps.reduce((s, e) => s + e[k] * e.pairs, 0) / w;
      b.shortMean = wm("shortMean"); b.longMean = wm("longMean"); b.ratio = wm("ratio"); b.sinusRR = wm("sinusRR");
      b.inEpisodes = b.eps.reduce((s, e) => s + e.dur, 0);
      delete b.eps;
    }

    // G) burden, per hour, HRV mask
    const isEarly = (l) => l === "PAC" || l === "PVC" || /^(BI|TRI)GEMINY_/.test(l);
    let nValid = 0, nEarly = 0, nArt = 0;
    const hours = new Map();
    for (let i = 0; i < n; i++) {
      const l = label[i];
      if (l === "ARTIFACT") { nArt++; continue; }
      if (l === "GAP") continue;
      nValid++;
      const h = Math.floor(beats[i].t / 3600) * 3600;
      if (!hours.has(h)) hours.set(h, { t: h, beats: 0, early: 0, pac: 0, pvc: 0 });
      const H = hours.get(h); H.beats++;
      if (isEarly(l)) { nEarly++; H.early++; if (/PVC/.test(l)) H.pvc++; else H.pac++; }
    }
    const hrvBad = new Uint8Array(n);
    for (let i = 1; i < n; i++) if (!(rr[i] === rr[i]) || label[i] !== "N" || isEarly(label[i - 1]) || label[i - 1] === "ARTIFACT") hrvBad[i] = 1;
    for (let i = 0; i < n; i++) if (!(rr[i] === rr[i])) hrvBad[i] = 0;   // only valid R-Rs are counted (and corrected)
    const nRR = Array.from(rr).filter((v) => v === v).length;
    prog(1, "done");
    return {
      params: P, fs,
      beats: beats.map((b, i) => ({ t: b.t, label: label[i], rr: rr[i] === rr[i] ? Math.round(rr[i]) : null,
                                    coupling: isEarly(label[i]) ? Math.round(rr[i]) : null,
                                    pause: isEarly(label[i]) && i + 1 < n && rr[i + 1] === rr[i + 1] ? Math.round(rr[i + 1]) : null,
                                    sqi: +b.sqi.toFixed(2), corr: +b.corr.toFixed(3), nq: +b.nq.toFixed(2), hf: +b.hf.toFixed(3), mov: b.mov == null ? null : +b.mov.toFixed(3), width: Math.round(b.width), sinus: Math.round(sinus[i]),
                                    ep: ep[i] })),
      episodes: eps, bouts,
      missedBeatsFound: missedAdded, usualQRS: wUsual,
      irregular: episodes.filter((e) => e.type === "IRREGULAR"),
      template: Array.from(tpl), templateT0: TW[0],
      burden: { beats: nValid, early: nEarly, pct: nValid ? 100 * nEarly / nValid : 0, artifacts: nArt,
                pac: label.filter((l) => /PAC$/.test(l) || l === "PAC").length, pvc: label.filter((l) => /PVC$/.test(l)).length,
                hours: [...hours.values()].sort((a, b) => a.t - b.t) },
      hrv: { corrected: hrvBad.reduce((s, v) => s + v, 0), of: nRR, pct: nRR ? 100 * hrvBad.reduce((s, v) => s + v, 0) / nRR : 0, mask: hrvBad },
    };
  }

  return { P, analyze, detectR, filtfilt, biquad, median };
});
