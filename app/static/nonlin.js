/* How deterministic is the heartbeat? Nonlinear analysis of an RR series.
 *
 * Lyapunov divergence curve (Rosenstein et al. 1993): the series is embedded
 * in m dimensions (each point = m successive RRs); every point gets its
 * nearest neighbour that is not close in time, and the curve is the mean
 * ln(distance) of these pairs k beats later. Its shape tells:
 *   - periodic: neighbours stay together, the curve stays low and flat
 *   - chaotic (deterministic): it starts low and rises linearly, then levels
 *     off; the initial slope is the largest Lyapunov exponent (per beat)
 *   - random: it is at the level-off value from the very first beat.
 * Correlated noise also rises gradually, so the curve alone cannot tell chaos
 * from it. Hence two surrogate series, analysed the same way:
 *   - shuffled: the same RR values in random order (no memory at all),
 *   - phase-randomised: the same values and the same power spectrum, i.e. the
 *     same linear correlations, but nothing nonlinear (AAFT-like).
 * The data below the phase-randomised curve = structure beyond linear
 * correlations (nonlinear determinism); on it = correlated noise; on the
 * shuffled one = memoryless randomness.
 *
 * Recurrence quantification: DET = share of the recurrent points (5 %
 * closest pairs of embedded points) that lie on diagonal lines, i.e.
 * stretches where the series repeats itself -- high for deterministic,
 * low for random dynamics. Again compared with the surrogates.
 *
 * Plain script: window.NonLin in the browser, module.exports in node.
 */
(function (root) {
  "use strict";

  const M = 4, TAU = 1, THEILER = 10, K = 20, N_MAX = 1000, N_MIN = 150, N_SUR = 4;

  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

  function zscore(x) {
    const n = x.length; let m = 0; for (const v of x) m += v; m /= n;
    let s = 0; for (const v of x) s += (v - m) ** 2; s = Math.sqrt(s / (n - 1)) || 1;
    return Float64Array.from(x, (v) => (v - m) / s);
  }

  // embedded vectors: point i = x[i], x[i+tau], ..., x[i+(m-1)tau]
  function dist2(x, i, j) {
    let s = 0;
    for (let k = 0; k < M; k++) { const d = x[i + k * TAU] - x[j + k * TAU]; s += d * d; }
    return s;
  }

  function lyapCurve(x) {
    const P = x.length - (M - 1) * TAU;
    const nn = new Int32Array(P).fill(-1);
    for (let i = 0; i < P - K; i++) {
      let best = Infinity, bj = -1;
      for (let j = 0; j < P - K; j++) {
        if (Math.abs(i - j) <= THEILER) continue;
        const d = dist2(x, i, j);
        if (d < best && d > 0) { best = d; bj = j; }
      }
      nn[i] = bj;
    }
    const y = [];
    for (let k = 0; k <= K; k++) {
      let s = 0, c = 0;
      for (let i = 0; i < P - K; i++) {
        const j = nn[i];
        if (j < 0) continue;
        const d = dist2(x, i + k, j + k);
        if (d > 0) { s += 0.5 * Math.log(d); c++; }
      }
      y.push(c ? s / c : null);
    }
    return y;
  }

  // largest Lyapunov exponent: slope of the curve over its first beats
  function lambda(y) {
    const k1 = 4;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let k = 0; k <= k1; k++) { sx += k; sy += y[k]; sxx += k * k; sxy += k * y[k]; }
    const n = k1 + 1;
    return (n * sxy - sx * sy) / (n * sxx - sx * sx);
  }

  // DET: recurrence = the 5 % closest pairs; share of them on diagonal lines (length >= 2)
  function rqaDet(x) {
    const P = x.length - (M - 1) * TAU;
    const d = new Float64Array(P * P);
    const sample = [];
    for (let i = 0; i < P; i++) for (let j = i + 1; j < P; j++) {
      const v = dist2(x, i, j); d[i * P + j] = v;
      if (((i * 31 + j * 17) & 15) === 0) sample.push(v);
    }
    sample.sort((a, b) => a - b);
    const eps = sample[Math.floor(0.05 * sample.length)];
    let rec = 0, onLine = 0;
    for (let off = 1; off < P; off++) {               // each diagonal above the main one
      let run = 0;
      for (let i = 0; i + off < P; i++) {
        if (d[i * P + i + off] <= eps) { run++; rec++; }
        else { if (run >= 2) onLine += run; run = 0; }
      }
      if (run >= 2) onLine += run;
    }
    return rec ? 100 * onLine / rec : null;
  }

  function shuffled(x, r) {
    const y = Float64Array.from(x);
    for (let i = y.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [y[i], y[j]] = [y[j], y[i]]; }
    return y;
  }

  // phase-randomised surrogate with the original values (rank-remapped)
  function phaseRand(x, r) {
    const n = x.length, cs = new Float64Array(n), sn = new Float64Array(n);
    for (let k = 0; k < n; k++) { cs[k] = Math.cos(2 * Math.PI * k / n); sn[k] = Math.sin(2 * Math.PI * k / n); }
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let k = 0; k <= n >> 1; k++) {
      let a = 0, b = 0;
      for (let t = 0; t < n; t++) { const q = (k * t) % n; a += x[t] * cs[q]; b -= x[t] * sn[q]; }
      const amp = Math.hypot(a, b), ph = k === 0 || 2 * k === n ? Math.atan2(b, a) : 2 * Math.PI * r();
      re[k] = amp * Math.cos(ph); im[k] = amp * Math.sin(ph);
      if (k > 0 && 2 * k !== n) { re[n - k] = re[k]; im[n - k] = -im[k]; }
    }
    const y = new Float64Array(n);
    for (let t = 0; t < n; t++) {
      let s = 0;
      for (let k = 0; k < n; k++) { const q = (k * t) % n; s += re[k] * cs[q] - im[k] * sn[q]; }
      y[t] = s / n;
    }
    // the original values in the surrogate's rank order
    const sortedX = Array.from(x).sort((a, b) => a - b);
    const order = Array.from(y.keys()).sort((a, b) => y[a] - y[b]);
    const out = new Float64Array(n);
    order.forEach((idx, rank) => { out[idx] = sortedX[rank]; });
    return out;
  }

  function meanSd(curves) {
    const mean = [], sd = [];
    for (let k = 0; k < curves[0].length; k++) {
      const v = curves.map((c) => c[k]).filter((q) => q != null);
      const m = v.reduce((s, q) => s + q, 0) / v.length;
      mean.push(m); sd.push(Math.sqrt(v.reduce((s, q) => s + (q - m) ** 2, 0) / Math.max(1, v.length - 1)));
    }
    return { mean, sd };
  }

  // rr: RR intervals (ms, already artifact-corrected), the last N_MAX are used
  function analyze(rr, seed, maxN) {
    maxN = maxN || N_MAX;
    if (rr.length < N_MIN) return null;
    const x = zscore(rr.length > maxN ? rr.slice(rr.length - maxN) : rr);
    const r = rng(seed || 12345);
    const real = lyapCurve(x);
    const sh = [], ph = [], detSh = [], detPh = [];
    for (let s = 0; s < N_SUR; s++) {
      const a = shuffled(x, r), b = phaseRand(x, r);
      sh.push(lyapCurve(a)); ph.push(lyapCurve(b));
      if (s < 2) { detSh.push(rqaDet(a)); detPh.push(rqaDet(b)); }
    }
    const shuf = meanSd(sh), phase = meanSd(ph);
    const det = rqaDet(x), avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const res = {
      n: x.length, k: real.map((_, i) => i), real, shuf: shuf.mean, phase: phase.mean, phaseSd: phase.sd,
      lambda: lambda(real), det, detShuf: avg(detSh), detPhase: avg(detPh),
    };
    res.verdict = verdict(res);
    return res;
  }

  // a plain-words reading of the curves (k = 1..3 beats ahead)
  function verdict(r) {
    let gSh = 0, gPh = 0, z = 0;
    for (let k = 1; k <= 3; k++) {
      gSh += r.shuf[k] - r.real[k]; gPh += r.phase[k] - r.real[k];
      z += (r.phase[k] - r.real[k]) / Math.max(0.02, r.phaseSd[k]);
    }
    gSh /= 3; gPh /= 3; z /= 3;
    if (gSh < 0.15) return { kind: "random", text: "random: as unpredictable as the same beats in random order" };
    // still far from the random level K beats later: the pattern keeps repeating
    if (r.shuf[K] - r.real[K] > 1) return { kind: "periodic", text: "periodic: similar stretches stay similar for 20+ beats" };
    if (z > 2 && gPh > 0.1) return { kind: "nonlinear", text: "deterministic component: more predictable than correlated noise with the same spectrum" };
    return { kind: "linear", text: "correlated noise: predictable only as far as its linear correlations (spectrum) go" };
  }

  // ---------- drawing ----------
  const COL = { real: "#4bd1a0", phase: "#5aa2ff", shuf: "#8b96a5", text: "#8b96a5", grid: "#232936", fg: "#e6edf3" };
  const FONT = "11px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

  function render(cv, statsEl, r, msg) {
    const W = cv.clientWidth, H = cv.clientHeight, k = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * k) || cv.height !== Math.round(H * k)) { cv.width = Math.round(W * k); cv.height = Math.round(H * k); }
    const ctx = cv.getContext("2d");
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = FONT;
    if (!r) {
      ctx.fillStyle = COL.text; ctx.fillText(msg || `needs at least ${N_MIN} beats`, 50, H / 2);
      if (statsEl) statsEl.textContent = "";
      return;
    }
    const all = [...r.real, ...r.shuf, ...r.phase].filter((v) => v != null);
    let y0 = Math.min(...all), y1 = Math.max(...all);
    const pad = (y1 - y0) * 0.08 || 0.1; y0 -= pad; y1 += pad;
    const L = 46, R = 12, T = 10, B = 26, w = W - L - R, h = H - T - B;
    const X = (v) => L + v / K * w, Y = (v) => T + h - (v - y0) / (y1 - y0) * h;
    ctx.strokeStyle = COL.grid; ctx.fillStyle = COL.text; ctx.lineWidth = 1; ctx.textAlign = "center";
    for (let v = 0; v <= K; v += 2) { ctx.beginPath(); ctx.moveTo(X(v), T); ctx.lineTo(X(v), T + h); ctx.stroke(); ctx.fillText(v, X(v), T + h + 14); }
    ctx.fillText("beats ahead", L + w / 2, H - 1);
    ctx.textAlign = "right";
    const st = niceStep((y1 - y0) / 4);
    for (let v = Math.ceil(y0 / st) * st; v <= y1; v += st) { ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(L + w, Y(v)); ctx.stroke(); ctx.fillText(v.toFixed(st < 0.1 ? 2 : 1), L - 5, Y(v) + 4); }
    ctx.save(); ctx.translate(11, T + h / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.fillText("⟨ln divergence⟩", 0, 0); ctx.restore();
    // phase-surrogate band (mean ± 2 SD)
    ctx.fillStyle = "rgba(90,162,255,0.14)"; ctx.beginPath();
    r.k.forEach((v) => ctx.lineTo(X(v), Y(r.phase[v] + 2 * r.phaseSd[v])));
    for (let i = r.k.length - 1; i >= 0; i--) ctx.lineTo(X(i), Y(r.phase[i] - 2 * r.phaseSd[i]));
    ctx.fill();
    const line = (ys, col, wd, dash) => {
      ctx.strokeStyle = col; ctx.lineWidth = wd; ctx.setLineDash(dash || []); ctx.beginPath();
      ys.forEach((v, i) => (i ? ctx.lineTo(X(i), Y(v)) : ctx.moveTo(X(i), Y(v)))); ctx.stroke(); ctx.setLineDash([]);
    };
    line(r.shuf, COL.shuf, 1.5, [5, 4]);
    line(r.phase, COL.phase, 1.5);
    line(r.real, COL.real, 2.2);
    ctx.fillStyle = COL.real;
    r.real.forEach((v, i) => ctx.fillRect(X(i) - 2, Y(v) - 2, 4, 4));
    // key
    ctx.textAlign = "left"; ctx.font = FONT;
    [[COL.real, "RR series"], [COL.phase, "phase-randomised (same spectrum: correlated noise)"], [COL.shuf, "shuffled (same values, no memory)"]]
      .forEach(([c, s], i) => { const yk = T + h - 52 + 15 * i; ctx.fillStyle = c; ctx.fillRect(L + w - 300, yk - 4, 10, 3); ctx.fillStyle = COL.text; ctx.fillText(s, L + w - 284, yk); });
    if (statsEl) {
      statsEl.innerHTML = `<b class="nl-${r.verdict.kind}">${r.verdict.text}</b> · λ₁ ${r.lambda.toFixed(3)}/beat · ` +
        `DET ${r.det.toFixed(0)} % (phase-rand. ${r.detPhase.toFixed(0)} %, shuffled ${r.detShuf.toFixed(0)} %) · ${r.n} beats` + (msg ? " · " + msg : "");
    }
  }
  function niceStep(r) {
    const e = 10 ** Math.floor(Math.log10(r)), m = r / e;
    return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * e;
  }

  // browser: analyse in a worker; only the newest request's answer is delivered
  let worker = null, reqId = 0;
  function analyzeAsync(rr, maxN, done) {
    if (!worker) {
      worker = new Worker("/static/nonlin_worker.js");
      worker.onmessage = (e) => { if (e.data.id === worker.want) worker.done(e.data.res); };
    }
    worker.want = ++reqId; worker.done = done;
    worker.postMessage({ id: reqId, rr: Float64Array.from(rr), maxN });
  }

  const NonLin = { analyze, analyzeAsync, render, lyapCurve, rqaDet, shuffled, phaseRand, zscore, N_MIN, N_MAX };
  if (typeof module !== "undefined" && module.exports) module.exports = NonLin;
  else root.NonLin = NonLin;
})(typeof window !== "undefined" ? window : this);
