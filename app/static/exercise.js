/* Fatigue during exercise, from the RR series and the strap's step counter.
 *
 *  1. DFA α1 durability (Rogers, Gronwald et al.): α1 falls with intensity;
 *     a regression α1 ~ HR gives the HR where α1 = 0.75 (HRVT1, ~ aerobic /
 *     first ventilatory threshold) and 0.5 (HRVT2). With fatigue the same HR
 *     gives a lower α1, so the threshold HR drifts down: compared between
 *     the first and the last third of the period, and α1 at matched HR.
 *  2. Cardiac drift / decoupling: at the same cadence the HR creeps up.
 *     Efficiency = cadence / HR, second half against the first, in % (cf.
 *     the Pa:HR decoupling of endurance training; < 5 % is good durability).
 *  3. Heart rate recovery: HR drop 60 s after a peak (end of a bout), HRR60.
 *  4. Training load: Banister TRIMP (minutes x HR reserve fraction x
 *     0.64 e^1.92x, women 0.86 e^1.67x) and Edwards TRIMP (minutes in the
 *     5 zones of % HRmax x 1..5).
 *
 * Plain script: window.Exercise in the browser, module.exports in node.
 * Needs HRV (hrv.js) for rolling α1.
 */
(function (root) {
  "use strict";
  const HRV = root.HRV || (typeof require !== "undefined" ? require("./hrv.js") : null);

  const A1_WIN = 120, A1_STEP = 10;      // α1 windows (s), as in the HRV logger apps
  const A1_LO = 0.3, A1_HI = 1.25;       // the part of α1 that falls linearly with HR
  const MOVING_SPM = 50;                 // cadence above which a 10 s bin is "moving"
  const STILL_SPM = 20;                  // and below which it is standing / sitting
  const MAX_TREND = 15;                  // bpm change across an α1 window: a transient, left out
  const EX_RESERVE = 0.3;                // exercise: HR above rest + 30 % of the HR reserve

  const athleteDefaults = { hrMax: 190, hrRest: 60, sex: "m" };
  function athlete() {
    try { return { ...athleteDefaults, ...JSON.parse(localStorage.getItem("hrm.athlete") || "{}") }; }
    catch (e) { return { ...athleteDefaults }; }
  }
  function saveAthlete(a) { try { localStorage.setItem("hrm.athlete", JSON.stringify(a)); } catch (e) {} }

  const lower = (t, x) => { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; } return lo; };

  // ---------- 1. α1 against HR ----------
  // α1 points {t, hr, a1} in [ta, tb]: 2-min windows every 10 s
  function a1Points(t, cl, ta, tb, maxBad) {
    const a = lower(t, ta), b = lower(t, tb);
    if (b - a < 100) return [];
    const sub = { rrc: cl.rrc.subarray(a, b), bad: cl.bad.subarray(a, b), gap: cl.gap.subarray(a, b) };
    const r = HRV.rolling(Array.prototype.slice.call(t, a, b), sub, { winS: A1_WIN, stepS: A1_STEP, win2S: A1_WIN, maxBad });
    // HR change across the window: the first against the last quarter. Fast
    // changes (starting, stopping, intervals) make α1 read high -- the trend,
    // not correlations -- so those windows are left out.
    const mhr = (x0, x1) => { let s = 0, n = 0; for (let i = lower(t, x0); i < b && t[i] < x1; i++) if (!cl.bad[i]) { s += cl.rrc[i]; n++; } return n ? 60000 * n / s : null; };
    const out = [];
    for (let i = 0; i < r.t.length; i++) {
      if (r.a1[i] == null || r.hr[i] == null) continue;
      const q = A1_WIN / 4, h0 = mhr(r.t[i] - 2 * q, r.t[i] - q), h1 = mhr(r.t[i] + q, r.t[i] + 2 * q);
      if (h0 == null || h1 == null || Math.abs(h1 - h0) > MAX_TREND) continue;
      out.push({ t: r.t[i], hr: r.hr[i], a1: r.a1[i] });
    }
    return out;
  }

  function fit(pts) {
    const p = pts.filter((q) => q.a1 >= A1_LO && q.a1 <= A1_HI);
    if (p.length < 12) return null;
    let sx = 0, sy = 0;
    for (const q of p) { sx += q.hr; sy += q.a1; }
    const mx = sx / p.length, my = sy / p.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const q of p) { sxx += (q.hr - mx) ** 2; sxy += (q.hr - mx) * (q.a1 - my); syy += (q.a1 - my) ** 2; }
    const hrs = p.map((q) => q.hr).sort((x, y) => x - y);
    const lo = hrs[Math.floor(0.05 * hrs.length)], hi = hrs[Math.floor(0.95 * hrs.length)];
    if (!sxx || hi - lo < 15) return { n: p.length, lo, hi, flat: true };
    const slope = sxy / sxx, icpt = my - slope * mx, r2 = syy ? sxy * sxy / (sxx * syy) : 0;
    const at = (a1) => (slope < 0 ? (a1 - icpt) / slope : null);
    const vt1 = at(0.75), vt2 = at(0.5);
    // a threshold more than 10 bpm outside the measured HRs is extrapolated
    const inR = (v) => v != null && v >= lo - 10 && v <= hi + 10;
    return { n: p.length, lo, hi, slope, icpt, r2, vt1, vt2, ok: slope < 0 && r2 >= 0.3,
             vt1In: inR(vt1), vt2In: inR(vt2) };
  }

  // whole period, first third, last third; α1 at matched HR between the two
  function durability(pts, ath) {
    if (ath) pts = pts.filter((p) => p.hr >= ath.hrRest + EX_RESERVE * (ath.hrMax - ath.hrRest));
    if (pts.length < 12) return { all: null, first: null, last: null, matched: null };
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t, d = (t1 - t0) / 3;
    const first = pts.filter((p) => p.t <= t0 + d), last = pts.filter((p) => p.t >= t1 - d);
    const res = { all: fit(pts), first: fit(first), last: fit(last), firstPts: first.length, lastPts: last.length };
    // the threshold drift only when both thirds actually cross α1 = 0.75
    const spans = (r) => r && r.ok && r.n >= 20 && r.hi - r.lo >= 20 && r.vt1 >= r.lo && r.vt1 <= r.hi;
    if (spans(res.first) && spans(res.last)) res.vt1Drift = res.last.vt1 - res.first.vt1;
    // matched HR: the HR range both thirds cover (10th..90th percentile)
    const pr = (arr) => { const h = arr.map((p) => p.hr).sort((x, y) => x - y); return [h[Math.floor(0.1 * h.length)], h[Math.floor(0.9 * h.length)]]; };
    if (first.length >= 6 && last.length >= 6) {
      const [a0, a1] = pr(first), [b0, b1] = pr(last), lo = Math.max(a0, b0), hi = Math.min(a1, b1);
      if (hi - lo >= 2 || Math.abs((a0 + a1) / 2 - (b0 + b1) / 2) < 3) {
        const l = Math.min(lo, hi) - 1.5, h = Math.max(lo, hi) + 1.5;
        const m = (arr) => { const v = arr.filter((p) => p.hr >= l && p.hr <= h).map((p) => p.a1); return v.length >= 4 ? v.reduce((s, x) => s + x, 0) / v.length : null; };
        const fa = m(first), la = m(last);
        if (fa != null && la != null) res.matched = { lo: l, hi: h, first: fa, last: la, delta: la - fa };
      }
    }
    // matched load: at the same cadence (steady running / walking) a tired
    // body shows a higher HR and a lower α1, so the HR-matched comparison can
    // miss it -- compare α1 at the period's typical cadence too
    const mov = pts.filter((p) => p.spm != null && p.spm >= MOVING_SPM);
    if (mov.length >= 20) {
      const sp = mov.map((p) => p.spm).sort((x, y) => x - y), med = sp[sp.length >> 1];
      const st = mov.filter((p) => Math.abs(p.spm - med) <= 0.08 * med);
      if (st.length >= 20 && st[st.length - 1].t - st[0].t >= 900) {
        const u0 = st[0].t, u3 = (st[st.length - 1].t - u0) / 3;
        const m = (arr) => (arr.length >= 6 ? arr.reduce((s, p) => s + p.a1, 0) / arr.length : null);
        const mh = (arr) => arr.reduce((s, p) => s + p.hr, 0) / arr.length;
        const A = st.filter((p) => p.t <= u0 + u3), Bq = st.filter((p) => p.t >= u0 + 2 * u3);
        const fa = m(A), la = m(Bq);
        if (fa != null && la != null) res.matchedLoad = { spm: med, first: fa, last: la, delta: la - fa, hr1: mh(A), hr2: mh(Bq) };
      }
    }
    return res;
  }

  // ---------- 2. drift / decoupling ----------
  // 10 s bins of HR (mean of the good beats) and cadence; act = {t, spm}
  function bins(t, cl, act, ta, tb) {
    const out = [];
    const a = lower(t, ta), b = lower(t, tb);
    const B = 10;
    let cur = null, s = 0, n = 0;
    const flush = () => { if (n >= 3) out.push({ t: cur * B + B / 2, hr: 60000 / (s / n), spm: null }); };
    for (let i = a; i < b; i++) {
      const k = Math.floor(t[i] / B);
      if (k !== cur) { flush(); cur = k; s = 0; n = 0; }
      if (!cl.bad[i]) { s += cl.rrc[i]; n++; }
    }
    flush();
    if (act && act.spm && act.spm.length) {
      for (const q of out) {
        const j = lower(act.t, q.t - 1);
        if (j < act.t.length && Math.abs(act.t[j] - q.t) < 6) q.spm = act.spm[j];
      }
      // the step counter updates in bursts: smooth over 30 s
      const raw = out.map((q) => q.spm);
      for (let i = 0; i < out.length; i++) {
        let s2 = 0, c = 0;
        for (let k = Math.max(0, i - 1); k <= Math.min(out.length - 1, i + 1); k++) if (raw[k] != null && Math.abs(out[k].t - out[i].t) <= 15) { s2 += raw[k]; c++; }
        out[i].spm = c ? s2 / c : null;
      }
    }
    return out;
  }

  // Only the bins at the period's typical moving cadence (within ±8 % of its
  // median), so warm-up, intervals and walking breaks do not count: the halves
  // compare like with like.
  function decoupling(bs, ath) {
    let mov = bs.filter((q) => q.spm != null && q.spm >= MOVING_SPM);
    if (mov.length) {
      const sp = mov.map((q) => q.spm).sort((x, y) => x - y), med = sp[sp.length >> 1];
      mov = mov.filter((q) => Math.abs(q.spm - med) <= 0.08 * med);
    }
    const hasSteps = bs.some((q) => q.spm != null);
    // no step counter: HR drift over the exercise part only
    const ex = ath ? bs.filter((q) => q.hr >= ath.hrRest + EX_RESERVE * (ath.hrMax - ath.hrRest)) : bs;
    const use = mov.length >= 30 ? mov : hasSteps ? null : ex;      // >= 5 min
    if (!use || use.length < 30) return { hasSteps, moving: mov.length * 10 };
    const h = use.length >> 1, A = use.slice(0, h), Bq = use.slice(h);
    const mean = (arr, k) => arr.reduce((s, q) => s + q[k], 0) / arr.length;
    const r = { hasSteps, moving: mov.length * 10, hr1: mean(A, "hr"), hr2: mean(Bq, "hr") };
    r.hrDrift = r.hr2 - r.hr1;
    if (use === mov) {
      r.spm1 = mean(A, "spm"); r.spm2 = mean(Bq, "spm");
      const ef1 = r.spm1 / r.hr1, ef2 = r.spm2 / r.hr2;
      r.decoupling = 100 * (ef1 - ef2) / ef1;
    }
    return r;
  }

  // ---------- 3. heart rate recovery ----------
  // HRR60 = HR at the end of a bout minus HR 60 s later. With step data a
  // bout ends where moving (>= 2 min) turns into standing (cadence below
  // STILL_SPM for the next minute); without it, at peaks of the smoothed HR
  // that are the highest within -120..+60 s, elevated for the minute before
  // and followed by a drop of at least 10 bpm.
  function recoveries(t, cl, bs, ath, ta, tb) {
    const a = lower(t, ta), b = lower(t, tb);
    // 1 s HR from a 5-beat median, null across lost beats
    const sec = [], hr = [];
    const buf = [];
    let k = a;
    for (let s = Math.ceil(t[a] || ta); s <= (t[b - 1] || tb); s++) {
      while (k < b && t[k] <= s) k++;
      buf.length = 0;
      let gap = false;
      for (let i = Math.max(a, k - 5); i < k; i++) { if (cl.gap[i] && i > k - 5) gap = true; if (!cl.bad[i]) buf.push(cl.rrc[i]); }
      sec.push(s);
      if (gap || buf.length < 3 || k < a + 1 || s - t[k - 1] > 3) { hr.push(null); continue; }
      buf.sort((x, y) => x - y);
      hr.push(60000 / buf[buf.length >> 1]);
    }
    const at = (s) => { const i = Math.round(s - sec[0]); return i >= 0 && i < hr.length ? hr[i] : null; };
    const peakNear = (s, before, after) => { let p = null, ps = s; for (let x = s - before; x <= s + after; x++) { const v = at(x); if (v != null && (p == null || v > p)) { p = v; ps = x; } } return [p, ps]; };
    const thr = ath.hrRest + 0.5 * (ath.hrMax - ath.hrRest);
    const out = [];
    const steps = bs.some((q) => q.spm != null);
    if (steps) {
      for (let i = 12; i + 6 < bs.length; i++) {
        const q = bs[i];
        if (!(q.spm != null && q.spm < STILL_SPM)) continue;
        const prev = bs.slice(i - 12, i), next = bs.slice(i, i + 6);
        if (prev.filter((x) => x.spm != null && x.spm >= MOVING_SPM).length < 10) continue;
        if (bs[i - 1].spm == null || bs[i - 1].spm < MOVING_SPM * 0.6) continue;
        if (next.some((x) => x.spm == null || x.spm >= STILL_SPM) || next[5].t - q.t > 55) continue;
        const stop = q.t - 5;
        const [p, ps] = peakNear(stop, 20, 10), h60 = at(ps + 60);
        if (p == null || h60 == null || p < thr) continue;
        out.push({ t: ps, peak: p, hr60: h60, hrr60: p - h60, confirmed: true });
      }
    } else {
      for (let i = 120; i + 60 < sec.length; i++) {
        const p = hr[i];
        if (p == null || p < thr) continue;
        let isMax = true, nn = 0, sumBefore = 0;
        for (let j = i - 120; j <= i + 60 && isMax; j++) if (hr[j] != null && hr[j] > p) isMax = false;
        if (!isMax) continue;
        for (let j = i - 60; j < i; j++) if (hr[j] != null) { sumBefore += hr[j]; nn++; }
        if (nn < 40 || sumBefore / nn < p - 15) continue;              // a real bout, not a spike
        const h60 = hr[i + 60];
        if (h60 == null || h60 > p - 10) continue;
        if (out.length && sec[i] - out[out.length - 1].t < 120) continue;
        out.push({ t: sec[i], peak: p, hr60: h60, hrr60: p - h60, confirmed: false });
      }
    }
    return { pts: out };
  }

  // ---------- 4. training load ----------
  const ZONES = [0.5, 0.6, 0.7, 0.8, 0.9];          // Edwards: % HRmax lower bounds, x1..x5
  function trimp(t, cl, ath, ta, tb) {
    const a = lower(t, ta), b = lower(t, tb);
    const k = ath.sex === "f" ? [0.86, 1.67] : [0.64, 1.92];
    let ban = 0, edw = 0, min = 0;
    const zone = [0, 0, 0, 0, 0];
    for (let i = a; i < b; i++) {
      if (cl.bad[i] || cl.gap[i]) continue;
      const m = cl.rrc[i] / 60000, h = 60000 / cl.rrc[i];
      min += m;
      const x = Math.min(1, Math.max(0, (h - ath.hrRest) / (ath.hrMax - ath.hrRest)));
      ban += m * x * k[0] * Math.exp(k[1] * x);
      const f = h / ath.hrMax;
      for (let z = 4; z >= 0; z--) if (f >= ZONES[z]) { zone[z] += m; edw += m * (z + 1); break; }
    }
    return { banister: ban, edwards: edw, minutes: min, zone };
  }

  function analyze(t, cl, act, ta, tb, o) {
    const ath = o.athlete || athlete();
    const pts = a1Points(t, cl, ta, tb, o.maxBad ?? 5);
    const bs = bins(t, cl, act, ta, tb);
    // cadence of each α1 window: mean of its 10 s bins
    if (bs.some((q) => q.spm != null)) {
      const bt = bs.map((q) => q.t);
      for (const p of pts) {
        let s = 0, n = 0;
        for (let i = lower(bt, p.t - A1_WIN / 2); i < bs.length && bs[i].t < p.t + A1_WIN / 2; i++) if (bs[i].spm != null) { s += bs[i].spm; n++; }
        p.spm = n >= 6 ? s / n : null;
      }
    }
    return { pts, dur: durability(pts, ath), bins: bs, dec: decoupling(bs, ath), hrr: recoveries(t, cl, bs, ath, ta, tb),
             load: trimp(t, cl, ath, ta, tb), ath };
  }

  // ---------- text ----------
  const f = (v, d = 0) => (v == null || !isFinite(v) ? "–" : v.toFixed(d));
  const sg = (v, d = 0) => (v == null || !isFinite(v) ? "–" : (v > 0 ? "+" : "") + v.toFixed(d));
  function thrText(r) {
    if (!r) return "–";
    if (r.flat) return "steady HR";
    if (!r.ok) return "no fit";
    return `${r.vt1In ? f(r.vt1) : "(" + f(r.vt1) + ")"} / ${r.vt2In ? f(r.vt2) : "(" + f(r.vt2) + ")"}`;
  }
  // overall reading of the fatigue signs
  function verdict(R) {
    const s = [];
    const d = R.dur;
    if (d.vt1Drift != null) s.push(d.vt1Drift <= -5 ? `threshold HR fell ${f(-d.vt1Drift)} bpm` : `threshold HR stable (${sg(d.vt1Drift)} bpm)`);
    if (d.matched) s.push(d.matched.delta <= -0.1 ? `α1 at the same HR dropped ${f(-d.matched.delta, 2)}` : `α1 at the same HR ${sg(d.matched.delta, 2)}`);
    const ml = d.matchedLoad;
    if (ml) s.push(ml.delta <= -0.1 ? `α1 at ${f(ml.spm)} spm dropped ${f(-ml.delta, 2)} (HR ${sg(ml.hr2 - ml.hr1)})` : `α1 at ${f(ml.spm)} spm ${sg(ml.delta, 2)}`);
    if (R.dec.decoupling != null) s.push(R.dec.decoupling > 5 ? `HR decoupled from cadence ${f(R.dec.decoupling, 1)} %` : `decoupling ${f(R.dec.decoupling, 1)} % (good)`);
    else if (R.dec.hrDrift != null) s.push(`HR drift ${sg(R.dec.hrDrift)} bpm`);
    const hp = R.hrr.pts;
    if (hp.length >= 2) {
      const first = hp[0].hrr60, last = hp[hp.length - 1].hrr60;
      s.push(`HRR60 ${f(first)} → ${f(last)} bpm${last < first - 6 ? " (slower recovery)" : ""}`);
    } else if (hp.length) s.push(`HRR60 ${f(hp[0].hrr60)} bpm`);
    const tired = [d.vt1Drift != null && d.vt1Drift <= -5,
                   (d.matched && d.matched.delta <= -0.1) || (ml && ml.delta <= -0.1),
                   R.dec.decoupling != null && R.dec.decoupling > 5,
                   hp.length >= 2 && hp[hp.length - 1].hrr60 < hp[0].hrr60 - 6].filter(Boolean).length;
    const n = [d.vt1Drift != null, d.matched || ml, R.dec.decoupling != null, hp.length >= 2].filter(Boolean).length;
    const head = !n ? "not enough exercise in the period to judge fatigue"
      : tired >= 2 ? "signs of fatigue" : tired === 1 ? "some sign of fatigue" : "no sign of fatigue";
    return { cls: !n ? "" : tired >= 2 ? "ex-tired" : tired ? "ex-some" : "ex-fresh", head, text: s.join(" · ") };
  }

  // ---------- drawing ----------
  const FONT = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  function cvSetup(cv) {
    const d = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    cv.width = Math.round(w * d); cv.height = Math.round(h * d);
    const ctx = cv.getContext("2d");
    ctx.setTransform(d, 0, 0, d, 0, 0); ctx.clearRect(0, 0, w, h); ctx.font = FONT;
    return { ctx, w, h };
  }
  function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  const lerpCol = (u) => `hsl(${210 - 180 * u}, 80%, 62%)`;      // early blue -> late orange

  // α1 against HR, coloured by time; fits of the first / last third
  function renderA1(cv, R) {
    const { ctx, w, h } = cvSetup(cv), L = 40, Rm = 10, T = 10, B = h - 24;
    const muted = cssVar("--muted"), grid = cssVar("--grid");
    const pts = R.pts;
    ctx.fillStyle = muted;
    if (pts.length < 3) { ctx.fillText("not enough clean 2-min windows", L + 8, T + 16); return; }
    let x0 = Math.min(...pts.map((p) => p.hr)), x1 = Math.max(...pts.map((p) => p.hr));
    x0 = Math.floor(x0 / 10) * 10 - 5; x1 = Math.ceil(x1 / 10) * 10 + 5;
    const y0 = 0, y1 = Math.max(1.6, ...pts.map((p) => p.a1));
    const X = (v) => L + (v - x0) / (x1 - x0) * (w - L - Rm), Y = (v) => B - (v - y0) / (y1 - y0) * (B - T);
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.textAlign = "center";
    for (let v = Math.ceil(x0 / 10) * 10; v <= x1; v += 10) { ctx.beginPath(); ctx.moveTo(X(v), T); ctx.lineTo(X(v), B); ctx.stroke(); ctx.fillText(v, X(v), B + 13); }
    ctx.textAlign = "right";
    for (let v = 0; v <= y1 + 1e-9; v += 0.25) { ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(w - Rm, Y(v)); ctx.stroke(); if (!(v * 4 % 2)) ctx.fillText(v.toFixed(1), L - 5, Y(v) + 4); }
    ctx.textAlign = "center"; ctx.fillText("HR bpm", (L + w) / 2, h - 1);
    ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = "rgba(139,150,165,0.6)"; ctx.textAlign = "left";
    for (const [v, lab] of [[0.75, "0.75 HRVT1"], [0.5, "0.5 HRVT2"]]) { ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(w - Rm, Y(v)); ctx.stroke(); ctx.fillText(lab, L + 4, Y(v) - 3); }
    ctx.restore();
    const tA = pts[0].t, tB = pts[pts.length - 1].t || tA + 1;
    for (const p of pts) {
      ctx.fillStyle = lerpCol((p.t - tA) / Math.max(1, tB - tA)); ctx.globalAlpha = 0.75;
      ctx.beginPath(); ctx.arc(X(p.hr), Y(p.a1), 2.5, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.globalAlpha = 1;
    const line = (r, col) => {
      if (!r || !r.ok) return;
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath();
      ctx.moveTo(X(r.lo), Y(r.icpt + r.slope * r.lo)); ctx.lineTo(X(r.hi), Y(r.icpt + r.slope * r.hi)); ctx.stroke();
      if (r.vt1In) { ctx.beginPath(); ctx.arc(X(r.vt1), Y(0.75), 4, 0, 2 * Math.PI); ctx.stroke(); }
    };
    line(R.dur.first, lerpCol(0)); line(R.dur.last, lerpCol(1));
    if (R.dur.matched) {
      const m = R.dur.matched; ctx.fillStyle = "rgba(139,150,165,0.12)";
      ctx.fillRect(X(m.lo), T, X(m.hi) - X(m.lo), B - T);
    }
    ctx.textAlign = "right"; ctx.font = FONT;
    ctx.fillStyle = lerpCol(0); ctx.fillText("first third", w - Rm - 4, T + 12);
    ctx.fillStyle = lerpCol(1); ctx.fillText("last third", w - Rm - 4, T + 26);
  }

  // HR and cadence over time, the recoveries marked
  function renderTime(cv, R) {
    const { ctx, w, h } = cvSetup(cv), L = 40, Rm = 40, T = 10, B = h - 20;
    const muted = cssVar("--muted"), grid = cssVar("--grid"), hrC = cssVar("--hr"), spmC = cssVar("--ecg");
    const bs = R.bins;
    ctx.fillStyle = muted;
    if (bs.length < 3) { ctx.fillText("no beats", L + 8, T + 16); return; }
    const t0 = bs[0].t, t1 = bs[bs.length - 1].t;
    const hrs = bs.map((q) => q.hr), hy0 = Math.floor(Math.min(...hrs) / 10) * 10, hy1 = Math.ceil(Math.max(...hrs) / 10) * 10 + 5;
    const sp = bs.map((q) => q.spm).filter((v) => v != null), sy1 = Math.max(60, ...sp) * 1.1;
    const X = (v) => L + (v - t0) / Math.max(1, t1 - t0) * (w - L - Rm);
    const Y = (v) => B - (v - hy0) / (hy1 - hy0) * (B - T), S = (v) => B - v / sy1 * (B - T);
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.textAlign = "right";
    const step = (hy1 - hy0) > 80 ? 20 : 10;
    for (let v = hy0; v <= hy1; v += step) { ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(w - Rm, Y(v)); ctx.stroke(); ctx.fillText(v, L - 5, Y(v) + 4); }
    const pad = (v) => String(v).padStart(2, "0"), hm = (s) => { const d = new Date(s * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
    ctx.textAlign = "center";
    const nT = Math.max(2, Math.floor((w - L - Rm) / 90));
    for (let i = 0; i <= nT; i++) { const v = t0 + (t1 - t0) * i / nT; ctx.fillText(hm(v), X(v), B + 13); }
    if (sp.length) {
      ctx.textAlign = "left"; ctx.fillStyle = spmC;
      for (let v = 0; v <= sy1; v += 50) ctx.fillText(v, w - Rm + 5, S(v) + 4);
      ctx.globalAlpha = 0.35; ctx.fillStyle = spmC;
      const bw = Math.max(1, (w - L - Rm) * 10 / Math.max(10, t1 - t0));
      for (const q of bs) if (q.spm) ctx.fillRect(X(q.t) - bw / 2, S(q.spm), bw, B - S(q.spm));
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = hrC; ctx.lineWidth = 1.5; ctx.beginPath();
    let prev = null;
    for (const q of bs) { if (prev && q.t - prev > 25) ctx.moveTo(X(q.t), Y(q.hr)); else if (!prev) ctx.moveTo(X(q.t), Y(q.hr)); else ctx.lineTo(X(q.t), Y(q.hr)); prev = q.t; }
    ctx.stroke();
    ctx.textAlign = "center"; ctx.font = FONT;
    for (const p of R.hrr.pts) {
      const x = X(p.t);
      ctx.strokeStyle = muted; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, Y(p.peak)); ctx.lineTo(X(p.t + 60), Y(p.hr60)); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = cssVar("--text"); ctx.fillText(`−${p.hrr60.toFixed(0)}`, x, Math.max(T + 10, Y(p.peak) - 6));
    }
  }

  const Exercise = { analyze, a1Points, durability, fit, bins, decoupling, recoveries, trimp, verdict, thrText,
                     renderA1, renderTime, athlete, saveAthlete, MOVING_SPM, STILL_SPM };
  if (typeof module !== "undefined" && module.exports) module.exports = Exercise;
  else root.Exercise = Exercise;
})(typeof window !== "undefined" ? window : this);
