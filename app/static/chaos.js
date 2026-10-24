/* Telling chaos from noise in an RR series: two established methods.
 *
 * 1) Noise titration (Barahona & Poon, Nature 1996; Poon & Barahona, PNAS
 *    2001; applied to heart rate: Poon & Merrill, Nature 1997).
 *    Volterra–Wiener autoregressive models y[n] = polynomial of degree d in the
 *    previous kappa values are fitted by least squares, kappa = 1..KAPPA,
 *    d = 1 (linear) and 2..DEG (nonlinear). Each gets the information
 *    criterion C(r) = ln(normalised residual SD) + r/N (r = number of terms).
 *    Nonlinear determinism is detected when the best nonlinear model beats the
 *    best linear one AND is significantly better than the linear model with
 *    the same memory (F-test, p < P_SIG). Then white noise of increasing SD is
 *    added until that is no longer detected: the noise limit NL (in % of the
 *    signal SD) measures how much chaos there is. NL > 0 = chaotic dynamics
 *    (as far as the test can tell), NL = 0 = no nonlinear determinism seen.
 *
 * 2) Complexity–entropy causality plane (Bandt & Pompe, PRL 2002; Rosso et
 *    al., PRL 2007, "Distinguishing noise from chaos"). The ordinal patterns
 *    of D successive beats (which is the largest, which the smallest, ...)
 *    are counted; H = their normalised Shannon entropy, C = H x the
 *    normalised Jensen–Shannon distance from the uniform distribution
 *    (statistical complexity). Noises, also correlated 1/f^k ones, lie on a
 *    curve at high H; chaotic maps sit higher, near the maximum complexity
 *    at intermediate H; periodic signals at low H.
 *
 * Plain script: window.Chaos in the browser, module.exports in node.
 */
(function (root) {
  "use strict";

  const KAPPA = 5, DEG = 3, P_SIG = 0.01, N_MIN = 300, BP_D = 4;

  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-300)) * Math.cos(2 * Math.PI * r()); }
  function zscore(x) {
    const n = x.length; let m = 0; for (const v of x) m += v; m /= n;
    let s = 0; for (const v of x) s += (v - m) ** 2; s = Math.sqrt(s / (n - 1)) || 1;
    return Float64Array.from(x, (v) => (v - m) / s);
  }

  // ---------- Volterra–Wiener models ----------
  // monomials of the lags 1..KAPPA up to degree DEG: [lags...], with their
  // highest lag and degree, so every model (kappa, d) is a subset of the terms
  const TERMS = (() => {
    const out = [{ lags: [], kap: 0, deg: 0 }];
    const rec = (start, lags) => {
      if (lags.length) out.push({ lags: lags.slice(), kap: lags[lags.length - 1], deg: lags.length });
      if (lags.length === DEG) return;
      for (let l = start; l <= KAPPA; l++) { lags.push(l); rec(l, lags); lags.pop(); }
    };
    rec(1, []);
    return out;
  })();

  // Gram matrix X'X, X'y and y'y over n = KAPPA .. N-1 (all terms at once)
  function gram(y) {
    const N = y.length, P = TERMS.length, G = new Float64Array(P * P), b = new Float64Array(P);
    const row = new Float64Array(P);
    let yy = 0, ym = 0, cnt = 0;
    for (let n = KAPPA; n < N; n++) {
      for (let p = 0; p < P; p++) { let v = 1; for (const l of TERMS[p].lags) v *= y[n - l]; row[p] = v; }
      const t = y[n];
      for (let p = 0; p < P; p++) {
        const rp = row[p]; b[p] += rp * t;
        for (let q = p; q < P; q++) G[p * P + q] += rp * row[q];
      }
      yy += t * t; ym += t; cnt++;
    }
    for (let p = 0; p < P; p++) for (let q = 0; q < p; q++) G[p * P + q] = G[q * P + p];
    return { G, b, yy, ss: yy - ym * ym / cnt, cnt, P };
  }

  // residual sum of squares of the model using the terms in idx (Cholesky)
  function rss(g, idx) {
    const r = idx.length, A = new Float64Array(r * r), z = new Float64Array(r);
    for (let i = 0; i < r; i++) { z[i] = g.b[idx[i]]; for (let j = 0; j < r; j++) A[i * r + j] = g.G[idx[i] * g.P + idx[j]]; }
    const ridge = 1e-9 * (A[0] || 1);
    for (let i = 0; i < r; i++) A[i * r + i] += ridge;
    for (let j = 0; j < r; j++) {                         // A = L L'
      let s = A[j * r + j];
      for (let k = 0; k < j; k++) s -= A[j * r + k] ** 2;
      if (!(s > 0)) return null;
      const d = Math.sqrt(s); A[j * r + j] = d;
      for (let i = j + 1; i < r; i++) {
        let t = A[i * r + j];
        for (let k = 0; k < j; k++) t -= A[i * r + k] * A[j * r + k];
        A[i * r + j] = t / d;
      }
    }
    // b'(X'X)^-1 b = |L^-1 z|^2
    let q = 0;
    for (let i = 0; i < r; i++) {
      let t = z[i];
      for (let k = 0; k < i; k++) t -= A[i * r + k] * z[k];
      z[i] = t / A[i * r + i]; q += z[i] * z[i];
    }
    return Math.max(1e-12 * g.ss, g.yy - q);
  }

  function modelSearch(y) {
    const g = gram(y), N = g.cnt;
    const models = [];
    for (let kap = 1; kap <= KAPPA; kap++) for (let deg = 1; deg <= DEG; deg++) {
      const idx = [];
      TERMS.forEach((t, i) => { if (t.kap <= kap && t.deg <= deg) idx.push(i); });
      const e = rss(g, idx);
      if (e == null) continue;
      models.push({ kap, deg, r: idx.length, rss: e, C: 0.5 * Math.log(e / g.ss) + idx.length / N });
    }
    const best = (f) => models.filter(f).reduce((a, m) => (!a || m.C < a.C ? m : a), null);
    const lin = best((m) => m.deg === 1), nl = best((m) => m.deg > 1);
    if (!lin || !nl) return { detected: false, p: 1 };
    const linRes = Math.sqrt(lin.rss / g.ss);           // what the best linear model leaves unexplained
    // nested comparison: the nonlinear winner against the linear model of the same memory
    const ref = models.find((m) => m.deg === 1 && m.kap === nl.kap);
    const d1 = nl.r - ref.r, d2 = N - nl.r;
    const F = ((ref.rss - nl.rss) / d1) / (nl.rss / d2);
    const p = F > 0 ? fSurvival(F, d1, d2) : 1;
    return { detected: nl.C < lin.C && p < P_SIG, p, lin, nl, linRes };
  }

  // P(F' > F) for the F(d1, d2) distribution: regularised incomplete beta
  function fSurvival(F, d1, d2) { return ibeta(d2 / (d2 + d1 * F), d2 / 2, d1 / 2); }
  function ibeta(x, a, b) {
    if (x <= 0) return 0; if (x >= 1) return 1;
    const lbt = lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x);
    if (x < (a + 1) / (a + b + 2)) return Math.exp(lbt) * betacf(x, a, b) / a;
    return 1 - Math.exp(lbt) * betacf(1 - x, b, a) / b;
  }
  function betacf(x, a, b) {                 // Lentz's continued fraction
    const FP = 1e-300; let c = 1, d = 1 - (a + b) * x / (a + 1);
    if (Math.abs(d) < FP) d = FP; d = 1 / d; let h = d;
    for (let m = 1; m <= 300; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FP) d = FP; c = 1 + aa / c; if (Math.abs(c) < FP) c = FP; d = 1 / d; h *= d * c;
      aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1));
      d = 1 + aa * d; if (Math.abs(d) < FP) d = FP; c = 1 + aa / c; if (Math.abs(c) < FP) c = FP; d = 1 / d;
      const del = d * c; h *= del;
      if (Math.abs(del - 1) < 1e-12) break;
    }
    return h;
  }
  function lgamma(z) {                       // Lanczos
    const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
    z -= 1; let x = c[0];
    for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
    const t = z + g + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  // noise limit: the smallest added white-noise SD (% of the signal SD) at
  // which nonlinearity is no longer detected (bisection, same noise sample)
  // the noise limit depends on the noise sample: the median over nSeeds samples
  function titrate(series, nSeeds) {
    if (series.length < N_MIN) return null;
    const x = zscore(series), N = x.length;
    const m0 = modelSearch(x);
    // almost fully predictable by a linear model: periodic (+ a little noise);
    // the test then reacts to tiny model errors, so no noise limit is given
    if (m0.linRes < 0.15) return { nl: null, periodic: true, detected: false, p: m0.p, linRes: m0.linRes, n: N };
    if (!m0.detected) return { nl: 0, detected: false, p: m0.p, model: m0.nl, linRes: m0.linRes, n: N };
    const limits = [];
    for (let s = 0; s < (nSeeds || 1); s++) {
      const r = rng(4242 + 7919 * s), e = Float64Array.from({ length: N }, () => gauss(r));
      const at = (pct) => modelSearch(Float64Array.from(x, (v, i) => v + e[i] * pct / 100));
      let lo = 0, hi = 25;
      while (at(hi).detected && hi < 400) { lo = hi; hi *= 2; }
      for (let k = 0; k < 7; k++) { const mid = (lo + hi) / 2; if (at(mid).detected) lo = mid; else hi = mid; }
      limits.push((lo + hi) / 2);
    }
    limits.sort((a, b) => a - b);
    return { nl: limits[limits.length >> 1], detected: true, p: m0.p, model: m0.nl, linRes: m0.linRes, n: N, limits };
  }

  // ---------- complexity–entropy plane ----------
  const FACT = [1, 1, 2, 6, 24, 120, 720];
  function patternIndex(x, i, D) {         // rank pattern of x[i..i+D-1] -> 0 .. D!-1 (Lehmer code)
    let idx = 0;
    for (let a = 0; a < D; a++) {
      let smaller = 0;
      for (let b = a + 1; b < D; b++) if (x[i + b] < x[i + a] || (x[i + b] === x[i + a] && b < a)) smaller++;
      idx += smaller * FACT[D - 1 - a];
    }
    return idx;
  }
  function hc(P) {
    const n = P.length, lnN = Math.log(n);
    const S = (p) => { let s = 0; for (const v of p) if (v > 0) s -= v * Math.log(v); return s; };
    const H = S(P) / lnN;
    const M = P.map((v) => (v + 1 / n) / 2);
    const js = S(M) - S(P) / 2 - lnN / 2;
    const q0 = -2 / (((n + 1) / n) * Math.log(n + 1) - 2 * Math.log(2 * n) + lnN);
    return { H, C: q0 * js * H };
  }
  function entropyPlane(series, D) {
    D = D || BP_D;
    const n = FACT[D], cnt = new Float64Array(n), x = series;
    let tot = 0;
    for (let i = 0; i + D <= x.length; i++) {
      // jitter-free ties: equal RRs (1 ms resolution) count as "the earlier is smaller"
      cnt[patternIndex(x, i, D)]++; tot++;
    }
    if (tot < 10 * n) return null;
    return { ...hc(Array.from(cnt, (c) => c / tot)), n: x.length, D };
  }
  // boundaries of the plane for D! patterns (Martin, Plastino & Rosso 2006)
  function planeBounds(D) {
    const n = FACT[D || BP_D], lo = [], hi = [];
    for (let k = 0; k <= 200; k++) {
      const p = 1 / n + (1 - 1 / n) * k / 200;
      lo.push(hc([p, ...Array(n - 1).fill((1 - p) / (n - 1))]));
    }
    for (let z = 0; z < n - 1; z++) for (let k = 0; k <= 60; k++) {
      const m = n - z, p = (k / 60) / m;                       // m nonzero entries, one of them p
      if (m < 2) continue;
      const P = [p, ...Array(m - 1).fill((1 - p) / (m - 1)), ...Array(z).fill(0)];
      hi.push(hc(P));
    }
    // upper envelope of the second family over H
    hi.sort((a, b) => a.H - b.H);
    const env = [];
    const bins = 120;
    for (let b = 0; b < bins; b++) {
      const sel = hi.filter((q) => q.H >= b / bins && q.H < (b + 1) / bins);
      if (sel.length) env.push(sel.reduce((a, q) => (q.C > a.C ? q : a)));
    }
    return { lo: lo.sort((a, b) => a.H - b.H), hi: env };
  }

  // f^-k noises on the plane for D = 4 (2^18 samples each; k = 0 .. 3)
  const NOISE_K = [[0, 1, 0], [0.25, 0.9991, 0.0011], [0.5, 0.9965, 0.0046], [0.75, 0.9916, 0.0108], [1, 0.9833, 0.0212],
    [1.25, 0.972, 0.0347], [1.5, 0.9574, 0.0514], [1.75, 0.9356, 0.0745], [2, 0.9077, 0.1015], [2.25, 0.8648, 0.1372],
    [2.5, 0.8021, 0.1795], [2.75, 0.6991, 0.2288], [3, 0.5452, 0.2637]];
  const REF_CHAOS = [["logistic", 0.7388, 0.2918], ["Hénon", 0.6884, 0.3098]];
  // complexity above the noise curve at the same entropy (> 0: more structured than any 1/f^k noise)
  function aboveNoise(H, C) {
    const pts = NOISE_K.slice().sort((a, b) => a[1] - b[1]);
    if (H <= pts[0][1]) return C - pts[0][2];
    for (let i = 1; i < pts.length; i++) if (H <= pts[i][1]) {
      const [, h0, c0] = pts[i - 1], [, h1, c1] = pts[i];
      return C - (c0 + (c1 - c0) * (H - h0) / (h1 - h0));
    }
    return C;
  }

  function analyze(rr) {
    const ti = titrate(rr, 3), pl = entropyPlane(zscore(rr));
    if (pl) pl.dC = aboveNoise(pl.H, pl.C);
    return { ti, pl, n: rr.length, verdict: verdict(ti, pl) };
  }
  function verdict(ti, pl) {
    if (!ti) return { kind: "none", text: `needs at least ${N_MIN} beats` };
    if (ti.periodic) return { kind: "periodic", text: "periodic: a linear model predicts it almost perfectly" };
    if (!ti.detected) return { kind: "noise", text: "no chaos detected: as well described by a linear (noise-driven) model" };
    const above = pl && pl.dC > 0.01;
    return { kind: "chaos", text: `chaotic component: survives ${ti.nl.toFixed(0)} % added noise` +
      (pl ? (above ? ", and more complex than correlated noise" : ", though its complexity is noise-like") : "") };
  }

  // sliding windows over a beat series: noise limit and plane position
  // (time windows of winS, every stepS; a window spanning a gap or with too
  // many corrected beats gives nulls); onPart(partial result) for progress
  function rolling(t, rrc, bad, gap, o, onPart) {
    const n = t.length, out = { t: [], nl: [], H: [], C: [], dC: [] };
    const pBad = new Int32Array(n + 1), pGap = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) { pBad[i + 1] = pBad[i] + bad[i]; pGap[i + 1] = pGap[i] + (gap[i] ? 1 : 0); }
    const lower = (x) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; } return lo; };
    let lastPost = Date.now();
    for (let c = t[0] + o.winS / 2; c <= t[n - 1] - o.winS / 2 + 1e-9; c += o.stepS) {
      const a = lower(c - o.winS / 2), b = lower(c + o.winS / 2);
      const good = b - a >= N_MIN && pGap[b] - pGap[a + 1] === 0 && 100 * (pBad[b] - pBad[a]) / (b - a) <= o.maxBad;
      out.t.push(c);
      if (!good) { out.nl.push(null); out.H.push(null); out.C.push(null); out.dC.push(null); continue; }
      const seg = Array.prototype.slice.call(rrc, a, b);
      const ti = titrate(seg, 1), pl = entropyPlane(zscore(seg));
      out.nl.push(ti && !ti.periodic ? ti.nl : null);
      out.H.push(pl ? pl.H : null); out.C.push(pl ? pl.C : null); out.dC.push(pl ? aboveNoise(pl.H, pl.C) : null);
      if (onPart && Date.now() - lastPost > 700) { lastPost = Date.now(); onPart(out, (c - t[0]) / (t[n - 1] - t[0])); }
    }
    return out;
  }

  // ---------- drawing (browser) ----------
  const COL = { text: "#8b96a5", grid: "#232936", fg: "#e6edf3", bound: "rgba(139,150,165,0.6)", noise: "#5aa2ff",
                chaos: "#ffb454", pt: "#4bd1a0", now: "#ff5470" };
  const FONT = "11px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
  let BOUNDS = null;
  function canvas2d(cv) {
    const W = cv.clientWidth, H = cv.clientHeight, k = (typeof devicePixelRatio !== "undefined" && devicePixelRatio) || 1;
    if (cv.width !== Math.round(W * k) || cv.height !== Math.round(H * k)) { cv.width = Math.round(W * k); cv.height = Math.round(H * k); }
    const ctx = cv.getContext("2d"); ctx.setTransform(k, 0, 0, k, 0, 0); ctx.clearRect(0, 0, W, H); ctx.font = FONT;
    return { ctx, W, H };
  }

  // pts: [{H, C, w (0..1, older = smaller)}]; cur: {H, C} or null
  function renderPlane(cv, pts, cur) {
    const { ctx, W, H } = canvas2d(cv);
    BOUNDS = BOUNDS || planeBounds(BP_D);
    const L = 44, R = 10, T = 8, B = 30, w = W - L - R, h = H - T - B;
    const h0 = 0.4, h1 = 1, c0 = 0, c1 = 0.38;
    const X = (v) => L + (v - h0) / (h1 - h0) * w, Y = (v) => T + h - (v - c0) / (c1 - c0) * h;
    ctx.strokeStyle = COL.grid; ctx.fillStyle = COL.text; ctx.lineWidth = 1; ctx.textAlign = "center";
    for (let v = 0.4; v <= 1.001; v += 0.1) { ctx.beginPath(); ctx.moveTo(X(v), T); ctx.lineTo(X(v), T + h); ctx.stroke(); ctx.fillText(v.toFixed(1), X(v), T + h + 13); }
    ctx.fillText("permutation entropy H  (→ random)", L + w / 2, H - 3);
    ctx.textAlign = "right";
    for (let v = 0; v <= c1 + 1e-9; v += 0.1) { ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(L + w, Y(v)); ctx.stroke(); ctx.fillText(v.toFixed(1), L - 5, Y(v) + 4); }
    ctx.save(); ctx.translate(11, T + h / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.fillText("complexity C", 0, 0); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(L, T, w, h); ctx.clip();
    const curve = (arr, col, wd, dash) => {
      ctx.strokeStyle = col; ctx.lineWidth = wd; ctx.setLineDash(dash || []); ctx.beginPath();
      arr.forEach((q, i) => (i ? ctx.lineTo(X(q.H), Y(q.C)) : ctx.moveTo(X(q.H), Y(q.C)))); ctx.stroke(); ctx.setLineDash([]);
    };
    curve(BOUNDS.hi, COL.bound, 1, [3, 3]); curve(BOUNDS.lo, COL.bound, 1, [3, 3]);
    curve(NOISE_K.map(([, H, C]) => ({ H, C })), COL.noise, 2);
    ctx.fillStyle = COL.noise; ctx.textAlign = "left";
    for (const [k, Hh, Cc] of NOISE_K) if (k % 1 === 0) { ctx.fillRect(X(Hh) - 2, Y(Cc) - 2, 4, 4); ctx.fillText("k=" + k, X(Hh) + 5, Y(Cc) + 12); }
    ctx.fillText("1/f^k noise", X(0.86) + 4, Y(0.13) - 14);
    ctx.fillStyle = COL.chaos;
    for (const [name, Hh, Cc] of REF_CHAOS) {
      ctx.beginPath(); ctx.arc(X(Hh), Y(Cc), 3.5, 0, 2 * Math.PI); ctx.fill();
      ctx.fillText(name + " (chaos)", X(Hh) + 6, Y(Cc) - 4);
    }
    for (const q of pts) {
      if (q.H == null) continue;
      ctx.globalAlpha = 0.2 + 0.6 * (q.w == null ? 1 : q.w);
      ctx.fillStyle = COL.pt; ctx.beginPath(); ctx.arc(X(q.H), Y(q.C), 2.5, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (cur) {
      ctx.fillStyle = COL.now; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(X(cur.H), Y(cur.C), 5.5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
    // magnified view of where the points are (heart rate sits close to the noise
    // curve at high H), in the empty corner below the minimum-complexity bound
    const all = pts.filter((q) => q.H != null).concat(cur ? [cur] : []);
    if (!all.length) return;
    let hA = Math.min(...all.map((q) => q.H)), hB = Math.max(...all.map((q) => q.H));
    const padH = Math.max(0.01, (hB - hA) * 0.25); hA = Math.max(0, hA - padH); hB = Math.min(1, hB + padH);
    const nz = NOISE_K.filter(([, Hh]) => Hh >= hA && Hh <= hB).map(([, , Cc]) => Cc).concat([noiseC(hA), noiseC(hB)]);
    const cs = all.map((q) => q.C).concat(nz);
    let cA = Math.min(...cs), cB = Math.max(...cs);
    const padC = Math.max(0.005, (cB - cA) * 0.25); cA = Math.max(0, cA - padC); cB += padC;
    const iw = Math.min(200, w * 0.42), ih = Math.min(120, h * 0.45), ix = L + 6, iy = T + h - ih - 6;
    const IX = (v) => ix + (v - hA) / (hB - hA) * iw, IY = (v) => iy + ih - (v - cA) / (cB - cA) * ih;
    ctx.fillStyle = "rgba(14,17,22,0.92)"; ctx.fillRect(ix, iy, iw, ih);
    ctx.strokeStyle = COL.grid; ctx.strokeRect(ix + 0.5, iy + 0.5, iw - 1, ih - 1);
    // where the inset is on the plane
    ctx.strokeStyle = "rgba(230,237,243,0.35)"; ctx.setLineDash([2, 2]);
    ctx.strokeRect(X(hA), Y(cB), X(hB) - X(hA), Y(cA) - Y(cB)); ctx.setLineDash([]);
    ctx.save(); ctx.beginPath(); ctx.rect(ix, iy, iw, ih); ctx.clip();
    ctx.strokeStyle = COL.noise; ctx.lineWidth = 2; ctx.beginPath();
    const fine = [];
    for (let k = 0; k <= 60; k++) { const Hh = hA + (hB - hA) * k / 60; fine.push([Hh, noiseC(Hh)]); }
    fine.forEach(([Hh, Cc], i) => (i ? ctx.lineTo(IX(Hh), IY(Cc)) : ctx.moveTo(IX(Hh), IY(Cc)))); ctx.stroke();
    for (const q of pts) {
      if (q.H == null) continue;
      ctx.globalAlpha = 0.25 + 0.65 * (q.w == null ? 1 : q.w); ctx.fillStyle = COL.pt;
      ctx.beginPath(); ctx.arc(IX(q.H), IY(q.C), 2.5, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (cur) { ctx.fillStyle = COL.now; ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(IX(cur.H), IY(cur.C), 4.5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke(); }
    ctx.restore();
    ctx.fillStyle = COL.text; ctx.textAlign = "left";
    ctx.fillText(`zoom: H ${hA.toFixed(2)}–${hB.toFixed(2)}`, ix + 4, iy + 12);
    ctx.textAlign = "right"; ctx.fillStyle = COL.noise; ctx.fillText("noise", ix + iw - 4, iy + 12);
  }
  // C of the 1/f^k noise curve at entropy H (piecewise linear)
  function noiseC(H) { return C_at(H); }
  function C_at(H) {
    const pts = NOISE_K.slice().sort((a, b) => a[1] - b[1]);
    if (H <= pts[0][1]) return pts[0][2];
    for (let i = 1; i < pts.length; i++) if (H <= pts[i][1]) {
      const [, h0, c0] = pts[i - 1], [, h1, c1] = pts[i];
      return c0 + (c1 - c0) * (H - h0) / (h1 - h0);
    }
    return 0;
  }

  // a value over time (live: noise limit history)
  function renderSeries(cv, ts, ys, o) {
    const { ctx, W, H } = canvas2d(cv);
    const L = 44, R = 10, T = 8, B = 30, w = W - L - R, h = H - T - B;
    const v = ys.filter((q) => q != null);
    const y1 = Math.max(o.minTop || 1, ...v) * 1.1, y0 = 0;
    const tt0 = ts.length ? ts[0] : 0, tt1 = ts.length > 1 ? ts[ts.length - 1] : tt0 + 60;
    const X = (q) => L + (q - tt0) / Math.max(1, tt1 - tt0) * w, Y = (q) => T + h - (q - y0) / (y1 - y0) * h;
    ctx.strokeStyle = COL.grid; ctx.fillStyle = COL.text; ctx.lineWidth = 1; ctx.textAlign = "right";
    const st = niceStep(y1 / 4);
    for (let q = 0; q <= y1; q += st) { ctx.beginPath(); ctx.moveTo(L, Y(q)); ctx.lineTo(L + w, Y(q)); ctx.stroke(); ctx.fillText(q.toFixed(0) + (o.unit || ""), L - 5, Y(q) + 4); }
    ctx.textAlign = "center";
    const fmt = (s) => new Date(s * 1000).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit" });
    if (ts.length) { ctx.fillText(fmt(tt0), L + 20, T + h + 13); ctx.fillText(fmt(tt1), L + w - 20, T + h + 13); }
    ctx.fillText(o.xlabel || "", L + w / 2, H - 3);
    if (!v.length) { ctx.fillText(o.empty || "no value yet", L + w / 2, T + h / 2); return; }
    ctx.strokeStyle = COL.chaos; ctx.fillStyle = COL.chaos; ctx.lineWidth = 2; ctx.beginPath();
    let pen = false;
    ts.forEach((q, i) => { if (ys[i] == null) { pen = false; return; } if (pen) ctx.lineTo(X(q), Y(ys[i])); else { ctx.moveTo(X(q), Y(ys[i])); pen = true; } });
    ctx.stroke();
    ts.forEach((q, i) => { if (ys[i] != null) ctx.fillRect(X(q) - 2, Y(ys[i]) - 2, 4, 4); });
  }
  function niceStep(r) { const e = 10 ** Math.floor(Math.log10(r)), m = r / e; return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * e; }

  // browser: run analyses in workers; per channel only the newest answer is delivered
  const workers = {};
  function inWorker(channel, msg, done, onPart) {
    let wk = workers[channel];
    if (!wk) {
      wk = workers[channel] = new Worker("/static/nonlin_worker.js");
      wk.seq = 0;
      wk.onmessage = (e) => {
        if (e.data.id !== wk.seq) return;
        if (e.data.part) { if (wk.onPart) wk.onPart(e.data.res, e.data.frac); } else wk.done(e.data.res);
      };
    }
    wk.done = done; wk.onPart = onPart;
    wk.postMessage({ ...msg, id: ++wk.seq });
  }

  const Chaos = { analyze, rolling, aboveNoise, renderPlane, renderSeries, inWorker, NOISE_K, titrate, modelSearch, entropyPlane, planeBounds, zscore, fSurvival, N_MIN, BP_D, KAPPA, DEG };
  if (typeof module !== "undefined" && module.exports) module.exports = Chaos;
  else root.Chaos = Chaos;
})(typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : this);
