/* HRV analysis of a recorded RR series: artifact correction, time-domain
 * measures, Poincaré SD1/SD2 and detrended fluctuation analysis (DFA).
 *
 * DFA (Peng et al. 1995) measures how the RR fluctuations scale with the
 * window: the RR series is integrated, cut into boxes of n beats, each box is
 * detrended with a straight line, and F(n) is the RMS of what is left. On a
 * log-log plot F(n) ~ n^alpha:
 *   alpha1 (4–16 beats): short-term correlations. ~1 at rest (fractal,
 *          "1/f"), towards 0.5 (uncorrelated, random) and below
 *          (anti-correlated) with exercise intensity: 0.75 is used as the
 *          aerobic threshold, 0.5 as the anaerobic one (Rogers et al. 2021).
 *   alpha2 (16–64 beats): longer-term correlations; ~1 healthy, -> 1.5 more
 *          regular (Brownian), lower = more random.
 *
 * Plain script: defines window.HRV in the browser, module.exports in node.
 */
(function (root) {
  "use strict";

  const RR_MIN = 250, RR_MAX = 2500;   // ms: outside is not a heartbeat
  const DEV_MAX = 0.2;                 // deviation from the local median: artifact / ectopic

  const STALE_RUN = 5;                 // this many identical RRs in a row: a repeated stale value

  // Flag beats that are artifacts or ectopic and replace them with the median
  // of the good beats around them, the usual correction before DFA:
  //  - outside the physiological range,
  //  - runs of STALE_RUN or more identical values (the strap repeating its
  //    last RR while it has no new beat, e.g. poor contact),
  //  - more than DEV_MAX off the median of the 5 good beats either side.
  // gap[i] = beats missing before beat i (lost notifications) -- a break in
  // the series that no window may span.
  function clean(rr, gap) {
    const n = rr.length, rrc = new Float64Array(n), bad = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (!(rr[i] >= RR_MIN && rr[i] <= RR_MAX)) bad[i] = 1;
    for (let i = 0; i < n;) {
      let j = i + 1;
      while (j < n && rr[j] === rr[i]) j++;
      if (j - i >= STALE_RUN) for (let k = i; k < j; k++) bad[k] = 1;
      i = j;
    }
    const W = 5, SEARCH = 40, buf = [];
    const localMed = (i) => {
      buf.length = 0;
      for (let j = i - 1, c = 0; j >= Math.max(0, i - SEARCH) && c < W; j--) if (!bad[j]) { buf.push(rr[j]); c++; }
      for (let j = i + 1, c = 0; j <= Math.min(n - 1, i + SEARCH) && c < W; j++) if (!bad[j]) { buf.push(rr[j]); c++; }
      if (!buf.length) return null;
      buf.sort((x, y) => x - y);
      return buf[buf.length >> 1];
    };
    const dev = new Uint8Array(n), med = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const m = localMed(i);
      med[i] = m == null ? Math.min(RR_MAX, Math.max(RR_MIN, rr[i])) : m;
      if (!bad[i] && m != null && Math.abs(rr[i] - m) > DEV_MAX * m) dev[i] = 1;
    }
    for (let i = 0; i < n; i++) {
      if (dev[i]) bad[i] = 1;
      rrc[i] = bad[i] ? med[i] : rr[i];
    }
    return { rrc, bad, gap: gap || new Uint8Array(n) };
  }

  // F(n) for each box size in `scales` over x[a..b): integrate, then detrend
  // boxes taken from both ends (so no beats are left out).
  function dfaF(x, a, b, scales) {
    const N = b - a;
    let mean = 0;
    for (let i = a; i < b; i++) mean += x[i];
    mean /= N;
    const y = new Float64Array(N);
    let s = 0;
    for (let i = 0; i < N; i++) { s += x[a + i] - mean; y[i] = s; }
    const F = [];
    for (const n of scales) {
      const m = Math.floor(N / n);
      if (m < 2) { F.push(NaN); continue; }
      // least-squares line in box [k, k+n): t = 0..n-1
      const St = n * (n - 1) / 2, Stt = (n - 1) * n * (2 * n - 1) / 6, D = n * Stt - St * St;
      let sum = 0;
      const box = (k) => {
        let Sy = 0, Sty = 0, Syy = 0;
        for (let t = 0; t < n; t++) { const v = y[k + t]; Sy += v; Sty += t * v; Syy += v * v; }
        const slope = (n * Sty - St * Sy) / D, icpt = (Sy - slope * St) / n;
        // residual sum of squares of the fit, closed form
        return Syy - icpt * Sy - slope * Sty;
      };
      for (let j = 0; j < m; j++) sum += box(j * n);
      for (let j = 0; j < m; j++) sum += box(N - (j + 1) * n);
      F.push(Math.sqrt(Math.max(0, sum) / (2 * m * n)));
    }
    return F;
  }

  // slope of log F against log n (NaN-safe least squares)
  function slope(scales, F) {
    let k = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < scales.length; i++) {
      if (!(F[i] > 0)) continue;
      const lx = Math.log10(scales[i]), ly = Math.log10(F[i]);
      k++; sx += lx; sy += ly; sxx += lx * lx; sxy += lx * ly;
    }
    if (k < 3) return null;
    return (k * sxy - sx * sy) / (k * sxx - sx * sx);
  }

  const S1 = [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const S2 = [16, 19, 22, 26, 30, 35, 41, 48, 56, 64];
  function alpha1(x, a, b) { return b - a >= 4 * 16 ? slope(S1, dfaF(x, a, b, S1)) : null; }
  function alpha2(x, a, b) { return b - a >= 4 * 64 ? slope(S2, dfaF(x, a, b, S2)) : null; }

  // log-spaced box sizes 4 .. N/4 for the log-log plot of a selection
  function scalesFor(N) {
    const out = [], top = Math.max(4, Math.floor(N / 4));
    for (let v = 4; v <= top; v = Math.max(v + 1, Math.round(v * 1.12))) out.push(v);
    return out;
  }

  // Time-domain + Poincaré measures over [a, b), from the corrected series;
  // successive differences only between neighbours with no gap between them.
  function stats(t, cl, a, b) {
    const { rrc, bad, gap } = cl, N = b - a;
    if (N < 3) return null;
    let s = 0, nb = 0, miss = 0;
    for (let i = a; i < b; i++) { s += rrc[i]; nb += bad[i]; if (i > a) miss += gap[i]; }
    const mean = s / N;
    let v = 0, d2 = 0, nd = 0, n50 = 0;
    for (let i = a; i < b; i++) {
      v += (rrc[i] - mean) ** 2;
      if (i > a && !gap[i]) { const d = rrc[i] - rrc[i - 1]; d2 += d * d; nd++; if (Math.abs(d) > 50) n50++; }
    }
    const sdnn = Math.sqrt(v / (N - 1)), rmssd = nd ? Math.sqrt(d2 / nd) : null;
    const sd1 = rmssd == null ? null : rmssd / Math.SQRT2;
    const sd2 = sd1 == null ? null : Math.sqrt(Math.max(0, 2 * sdnn * sdnn - sd1 * sd1));
    return {
      beats: N, dur: t[b - 1] - t[a], bad: nb, badPct: 100 * nb / N, missing: miss,
      meanRR: mean, hr: 60000 / mean, sdnn, rmssd, pnn50: nd ? 100 * n50 / nd : null,
      sd1, sd2, sd12: sd1 != null && sd2 ? sd1 / sd2 : null,
      alpha1: alpha1(rrc, a, b), alpha2: alpha2(rrc, a, b),
    };
  }

  // Values in time windows of winS seconds, one every stepS seconds, centred
  // on the window. A window that spans a gap or has more than maxBad % corrected
  // beats gives null (no trustworthy value there); badPct is always given.
  // alpha2 uses a window of win2S (it needs >= 256 beats).
  function rolling(t, cl, o) {
    const { rrc, bad, gap } = cl, n = t.length;
    const winS = o.winS, stepS = o.stepS, win2S = o.win2S, maxBad = o.maxBad;
    const out = { t: [], a1: [], a2: [], rmssd: [], sdnn: [], hr: [], badPct: [] };
    if (n < 2) return out;
    // prefix sums: corrected beats, missing beats; gap positions
    const pBad = new Int32Array(n + 1), pGap = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) { pBad[i + 1] = pBad[i] + bad[i]; pGap[i + 1] = pGap[i] + (gap[i] ? 1 : 0); }
    const lower = (x) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; } return lo; };
    const ok = (a, b) => b - a > 2 && pGap[b] - pGap[a + 1] === 0;
    for (let c = t[0] + winS / 2; c <= t[n - 1] - winS / 2 + 1e-9; c += stepS) {
      const a = lower(c - winS / 2), b = lower(c + winS / 2);
      const bp = b > a ? 100 * (pBad[b] - pBad[a]) / (b - a) : null;
      out.t.push(c); out.badPct.push(bp);
      if (!ok(a, b) || bp > maxBad) {
        out.a1.push(null); out.rmssd.push(null); out.sdnn.push(null); out.hr.push(null);
      } else {
        let s = 0, d2 = 0;
        for (let i = a; i < b; i++) { s += rrc[i]; if (i > a) d2 += (rrc[i] - rrc[i - 1]) ** 2; }
        const mean = s / (b - a);
        let v = 0;
        for (let i = a; i < b; i++) v += (rrc[i] - mean) ** 2;
        out.a1.push(alpha1(rrc, a, b));
        out.rmssd.push(Math.sqrt(d2 / (b - a - 1)));
        out.sdnn.push(Math.sqrt(v / (b - a - 1)));
        out.hr.push(60000 / mean);
      }
      if (win2S) {
        const a2 = lower(c - win2S / 2), b2 = lower(c + win2S / 2);
        const bp2 = b2 > a2 ? 100 * (pBad[b2] - pBad[a2]) / (b2 - a2) : 100;
        out.a2.push(c - win2S / 2 >= t[0] && c + win2S / 2 <= t[n - 1] && ok(a2, b2) && bp2 <= maxBad
          ? alpha2(rrc, a2, b2) : null);
      }
    }
    return out;
  }

  // ---- multifractal analysis -------------------------------------------
  //
  // MFDFA (Kantelhardt et al. 2002): DFA generalised to the q-th moment of the
  // box fluctuations, Fq(n) = { mean over boxes of [F2_box(n)]^(q/2) }^(1/q)
  // (q = 0: geometric mean). Fq(n) ~ n^h(q); q = 2 is plain DFA. Large q
  // weights the boxes with big fluctuations, negative q the quiet ones; a
  // monofractal has the same h for every q. Legendre transform:
  // tau(q) = q h(q) - 1, alpha = tau'(q), f(alpha) = q alpha - tau(q).
  // The width of f(alpha) (alpha_max - alpha_min) is the degree of
  // multifractality; alpha0 (where f peaks) the dominant singularity.
  function qRange(qMax, dq) {
    const out = [];
    for (let q = -qMax; q <= qMax + 1e-9; q += dq) out.push(Math.round(q * 100) / 100);
    return out;
  }

  // box sizes for MFDFA over N beats: log-spaced 10 .. N/4 (small boxes make
  // the negative moments unstable)
  function mfScales(N) {
    const out = [], top = Math.floor(N / 4);
    for (let v = 10; v <= top; v = Math.max(v + 1, Math.round(v * 1.15))) out.push(v);
    return out;
  }

  // bad (optional): corrected-beat flags; boxes with more than 10 % of them
  // are left out (replaced beats flatten a box, and negative q blow that up)
  function mfdfa(x, a, b, qs, scales, bad) {
    const N = b - a;
    scales = scales || mfScales(N);
    if (scales.length < 4) return null;
    let mean = 0;
    for (let i = a; i < b; i++) mean += x[i];
    mean /= N;
    const y = new Float64Array(N);
    let s = 0;
    for (let i = 0; i < N; i++) { s += x[a + i] - mean; y[i] = s; }
    const Fq = qs.map(() => []);
    for (const n of scales) {
      const m = Math.floor(N / n);
      const St = n * (n - 1) / 2, Stt = (n - 1) * n * (2 * n - 1) / 6, D = n * Stt - St * St;
      const v2 = [];                       // per-box variance after detrending
      const box = (k) => {
        let Sy = 0, Sty = 0, Syy = 0;
        for (let t = 0; t < n; t++) { const v = y[k + t]; Sy += v; Sty += t * v; Syy += v * v; }
        const sl = (n * Sty - St * Sy) / D, ic = (Sy - sl * St) / n;
        return Math.max(1e-12, (Syy - ic * Sy - sl * Sty) / n);
      };
      const use = (k) => {
        if (!bad) return true;
        let c = 0;
        for (let t = 0; t < n; t++) c += bad[a + k + t];
        return c <= 0.1 * n;
      };
      for (let j = 0; j < m; j++) if (use(j * n)) v2.push(box(j * n));
      for (let j = 0; j < m; j++) if (use(N - (j + 1) * n)) v2.push(box(N - (j + 1) * n));
      if (v2.length < 4) { qs.forEach((q, k) => Fq[k].push(NaN)); continue; }
      qs.forEach((q, k) => {
        let acc = 0;
        if (Math.abs(q) < 1e-9) {
          for (const v of v2) acc += Math.log(v);
          Fq[k].push(Math.exp(acc / (2 * v2.length)));
        } else {
          for (const v of v2) acc += Math.pow(v, q / 2);
          Fq[k].push(Math.pow(acc / v2.length, 1 / q));
        }
      });
    }
    const h = Fq.map((F) => slope(scales, F));
    return { scales, qs, Fq, h, ...legendre(qs, h) };
  }

  // tau(q), alpha(q) = d tau / dq (central differences), f(alpha)
  function legendre(qs, h) {
    const tau = qs.map((q, i) => h[i] == null ? null : q * h[i] - 1);
    const alpha = [], f = [];
    for (let i = 0; i < qs.length; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(qs.length - 1, i + 1);
      if (tau[i0] == null || tau[i1] == null || tau[i] == null) { alpha.push(null); f.push(null); continue; }
      const al = (tau[i1] - tau[i0]) / (qs[i1] - qs[i0]);
      alpha.push(al); f.push(qs[i] * al - tau[i]);
    }
    return { tau, alpha, f, ...width(alpha, f) };
  }

  function width(alpha, f) {
    let lo = Infinity, hi = -Infinity, a0 = null, fmax = -Infinity;
    alpha.forEach((a, i) => {
      if (a == null || !isFinite(a)) return;
      lo = Math.min(lo, a); hi = Math.max(hi, a);
      if (f[i] > fmax) { fmax = f[i]; a0 = a; }
    });
    return isFinite(lo) ? { width: hi - lo, alpha0: a0, alphaMin: lo, alphaMax: hi } : { width: null, alpha0: null };
  }

  // Chhabra & Jensen (1989): f(alpha) directly from the measure, without the
  // Legendre transform. The series is cut into boxes of L beats (L = 2^k), box
  // probabilities P_i = (sum in box) / total; for every q the "zoomed" measure
  // mu_i = P_i^q / sum_j P_j^q gives
  //   alpha(q) = d [sum mu_i ln P_i] / d ln eps,  f(q) = d [sum mu_i ln mu_i] / d ln eps
  // with eps = L / N (slopes over the box sizes). The measure must be
  // positive: the RR intervals themselves ("rr") or the beat-to-beat changes
  // |dRR| ("drr"; boxes with no change are left out).
  function chhabraJensen(x, a, b, qs, measure) {
    const N0 = b - a;
    const val = new Float64Array(measure === "drr" ? N0 - 1 : N0);
    for (let i = 0; i < val.length; i++) val[i] = measure === "drr" ? Math.abs(x[a + i + 1] - x[a + i]) : x[a + i];
    const Ls = [];
    for (let L = 2; L <= val.length / 8; L *= 2) Ls.push(L);
    if (Ls.length < 3) return null;
    const lnE = [], A = qs.map(() => []), F = qs.map(() => []);
    for (const L of Ls) {
      const m = Math.floor(val.length / L), N = m * L;
      const P = [];
      let tot = 0;
      for (let j = 0; j < m; j++) { let s = 0; for (let i = j * L; i < (j + 1) * L; i++) s += val[i]; P.push(s); tot += s; }
      if (!(tot > 0)) return null;
      const lp = [];
      for (let j = 0; j < m; j++) { P[j] /= tot; lp.push(P[j] > 0 ? Math.log(P[j]) : null); }
      lnE.push(Math.log(L / N));
      qs.forEach((q, k) => {
        // sum_j P_j^q in log space (stable for large |q|)
        let mx = -Infinity;
        for (const l of lp) if (l != null) mx = Math.max(mx, q * l);
        let z = 0;
        for (const l of lp) if (l != null) z += Math.exp(q * l - mx);
        const lz = mx + Math.log(z);
        let sa = 0, sf = 0;
        for (const l of lp) {
          if (l == null) continue;
          const lmu = q * l - lz, mu = Math.exp(lmu);
          sa += mu * l; sf += mu * lmu;
        }
        A[k].push(sa); F[k].push(sf);
      });
    }
    const lin = (ys) => {
      const k = ys.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let i = 0; i < k; i++) { sx += lnE[i]; sy += ys[i]; sxx += lnE[i] ** 2; sxy += lnE[i] * ys[i]; }
      return (k * sxy - sx * sy) / (k * sxx - sx * sx);
    };
    const alpha = A.map(lin), f = F.map(lin);
    return { qs, Ls, alpha, f, ...width(alpha, f) };
  }

  // multifractal measures in sliding windows (fewer, longer windows than the
  // DFA alpha1 ones), same quality rule as rolling()
  function rollingMF(t, cl, o) {
    const { rrc, bad, gap } = cl, n = t.length;
    const out = { t: [], mfW: [], mfA0: [], cjW: [], cjA0: [] };
    if (n < 2) return out;
    const pBad = new Int32Array(n + 1), pGap = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) { pBad[i + 1] = pBad[i] + bad[i]; pGap[i + 1] = pGap[i] + (gap[i] ? 1 : 0); }
    const lower = (x) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; } return lo; };
    const qs = qRange(o.qMax, 1);
    for (let c = t[0] + o.winS / 2; c <= t[n - 1] - o.winS / 2 + 1e-9; c += o.stepS) {
      const a = lower(c - o.winS / 2), b = lower(c + o.winS / 2);
      out.t.push(c);
      const good = b - a > 100 && pGap[b] - pGap[a + 1] === 0 && 100 * (pBad[b] - pBad[a]) / (b - a) <= o.maxBad;
      const m = good ? mfdfa(rrc, a, b, qs, null, bad) : null;
      const j = good ? chhabraJensen(rrc, a, b, qs, o.measure) : null;
      out.mfW.push(m ? m.width : null); out.mfA0.push(m ? m.alpha0 : null);
      out.cjW.push(j ? j.width : null); out.cjA0.push(j ? j.alpha0 : null);
    }
    return out;
  }

  const HRV = { clean, dfaF, slope, alpha1, alpha2, scalesFor, stats, rolling, S1, S2,
                qRange, mfScales, mfdfa, legendre, chhabraJensen, rollingMF };
  if (typeof module !== "undefined" && module.exports) module.exports = HRV;
  else root.HRV = HRV;
})(typeof window !== "undefined" ? window : this);
