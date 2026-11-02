/* Raw ECG of a saved session (review page): a strip like the live one, browsed
 * instead of following the stream. ECG + accelerometer (X/Y/Z, |a|) on one
 * time axis, ECG-paper grid, display-only mains notch, the session's beats as
 * dots on their QRS peaks (corrected beats hollow), measure tool. The beat-
 * to-beat HR (60000 / RR, corrected beats and lost-beat gaps left out) is drawn
 * over the ECG on its own right-hand axis, as on the overview chart.
 *
 * Data: /api/sessions/<id>/ecg?a=&b= serves a window (up to 200 s) of the raw
 * CSV on the strap's sample clock (recordings.raw_window); a bit more than the
 * view is fetched so short pans and zooms draw without waiting.
 *
 * Plain script: window.EcgView ({ init, setSession, goTo, view, resize }).
 */
(function (root) {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const COL = { ecg: "#4bd1a0", hr: "#ff5470", beat: "#ff2d2d", bad: "#ffb454", x: "#5aa2ff", y: "#ffb454", z: "#c792ea",
                mag: "#7fdbca", grid: "#232936", gridMinor: "#1b2029", text: "#8b96a5", label: "#e6edf3",
                meas: "#f2f5f8", measFill: "rgba(242,245,248,0.07)", measBox: "rgba(14,17,22,0.85)" };
  const FONT = "11px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
  const WIN_DEFAULT = 6, WIN_MIN = 2;                // visible window (s); at most the whole session
  const FETCH_MAX = 200;                              // server limit (recordings.RAW_MAX_S): wider shows HR only
  const PAPER_MAX = 60;                               // ECG-paper fine grid up to this window
  const HR_MARK_MAX = 120;                            // a mark on each HR beat up to this window
  const SNAP_BACK = 0.35, SNAP_FWD = 0.12;            // beat -> R peak search (s), as live
  const LABEL_WIN = 20;                               // RR labels on the dots up to this window
  const HR_MIN_SPAN = 10;                             // bpm: the HR axis spans at least this
  const ACC_GAP = 0.5;                                // accel samples further apart: a break
  const LW = 1 / (window.devicePixelRatio || 1);

  let ses = null, cl = null;          // session ({id, beats, meta}) and HRV.clean of its beats
  let tc = null, win = WIN_DEFAULT;   // view centre (unix s) and length (s)
  let data = null;                    // fetched window: {ses, a, b, fs, segs, acc, dots}
  let reqId = 0, fetchTimer = 0;
  let notchPref = 50, strapNotch = 0;
  let meas = { a: null, b: null }, measureMode = false, hoverT = null;
  let lanes = null, ranges = null;
  let onView = () => {};
  try { win = clamp(parseFloat(localStorage.getItem("hrm.rvwin")) || WIN_DEFAULT); } catch (e) {}
  try { const f = localStorage.getItem("hrm.notch"); if (f != null) notchPref = +f; } catch (e) {}

  function winMax() {
    if (!ses || !ses.beats.t.length) return 86400;
    const [t0, t1] = bounds();
    return Math.max(WIN_MIN, t1 - t0);
  }
  function clamp(w) { return Math.min(winMax(), Math.max(WIN_MIN, w)); }
  const rawOk = () => win <= FETCH_MAX;               // the raw ECG / accelerometer can be shown
  function fmtWin(w) {
    if (w < 10) return w.toFixed(1) + " s";
    if (w < 120) return Math.round(w) + " s";
    if (w < 7200) return Math.round(w / 60) + " min";
    return (w / 3600).toFixed(1) + " h";
  }
  const pad = (v) => String(v).padStart(2, "0");
  function fmtClock(t, dec) {
    const d = new Date(t * 1000);
    let s = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    if (dec) s += "." + String(Math.floor((t % 1 + 1) % 1 * 10 ** dec)).padStart(dec, "0");
    return s;
  }

  // ---------- display-only mains notch (biquad, RBJ cookbook, Q = 30), as live ----------
  function notchFilter(v, fs, f0) {
    if (!f0 || f0 >= fs / 2) return v;
    const w0 = 2 * Math.PI * f0 / fs, al = Math.sin(w0) / (2 * 30), c = Math.cos(w0), a0 = 1 + al;
    const b0 = 1 / a0, b1 = -2 * c / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0;
    const out = new Float32Array(v.length);
    // start from the first sample's steady state, so the trace does not ring in
    let z1 = v[0] * (1 - b0), z2 = v[0] * (b0 - a2);
    for (let i = 0; i < v.length; i++) {
      const x = v[i], y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b0 * x - a2 * y;
      out[i] = y;
    }
    return out;
  }
  const notchF = () => (strapNotch ? 0 : notchPref);

  // ---------- data ----------
  function covered() {
    return data && data.ses === ses.id && tc - win / 2 >= data.a && tc + win / 2 <= data.b;
  }
  function ensure() {
    draw();
    if (!ses || covered()) return;
    if (!rawOk()) {
      clearTimeout(fetchTimer); reqId++;
      setText("ecg-status", `raw ECG and motion: zoom in to ${Math.floor(FETCH_MAX / 60)} min ${FETCH_MAX % 60} s or less`);
      return;
    }
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(load, 60);
  }
  async function load() {
    const span = Math.min(FETCH_MAX, Math.max(3 * win, 30));
    const a = tc - span / 2, b = tc + span / 2, id = ++reqId, sid = ses.id;
    setText("ecg-status", "loading…");
    let d;
    try {
      const r = await fetch(`/api/sessions/${sid}/ecg?a=${a.toFixed(3)}&b=${b.toFixed(3)}`);
      if (!r.ok) throw new Error(r.status === 404 ? "no ECG in this session" : "HTTP " + r.status);
      d = await r.json();
    } catch (e) {
      if (id === reqId) setText("ecg-status", String(e.message || e));
      return;
    }
    if (id !== reqId || !ses || ses.id !== sid) return;   // a newer request is on its way
    data = { ses: sid, a, b, fs: d.fs, segs: d.ecg, acc: d.acc };
    if (d.notched_hz !== strapNotch) { strapNotch = d.notched_hz || 0; syncNotch(); }
    setText("ecg-fs", `${d.fs} Hz`);
    prepare();
    setText("ecg-status", d.ecg.length ? "" : "no ECG here (link lost or raw ECG not recorded)");
    draw();
    if (!covered()) ensure();
  }

  // filtered trace per segment, and the beats snapped to their R peaks
  function prepare() {
    if (!data) return;
    const fs = data.fs, f0 = notchF();
    for (const s of data.segs) s.f = notchFilter(s.v, fs, f0);
    const dots = [], bt = ses.beats.t;
    let i = lowerBound(bt, data.a);
    for (; i < bt.length && bt[i] <= data.b; i++) {
      const s = segAt(bt[i]);
      if (!s) continue;
      const n = s.f.length, c = Math.round((bt[i] - s.t) * fs);
      const j0 = Math.max(0, c - Math.round(SNAP_BACK * fs)), j1 = Math.min(n - 1, c + Math.round(SNAP_FWD * fs));
      if (j1 <= j0) continue;
      let base = 0, cnt = 0;
      for (let j = Math.max(0, c - 2 * fs); j <= Math.min(n - 1, c); j++) { base += s.f[j]; cnt++; }
      base = cnt ? base / cnt : 0;
      // largest deviation either way: the lead can be reversed (negative QRS)
      let best = -1, bv = -Infinity;
      for (let j = j0; j <= j1; j++) if (Math.abs(s.f[j] - base) > bv) { bv = Math.abs(s.f[j] - base); best = j; }
      if (best >= 0) dots.push({ t: s.t + best / fs, v: s.f[best], rr: ses.beats.rr[i], bad: !!cl.bad[i] });
    }
    data.dots = dots;
  }
  function segAt(t) {
    for (const s of data.segs) if (t >= s.t && t <= s.t + (s.v.length - 1) / data.fs) return s;
    return null;
  }
  function lowerBound(xs, v) {
    let lo = 0, hi = xs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < v) lo = m + 1; else hi = m; }
    return lo;
  }

  // ---------- drawing ----------
  function autoRange(minSpan, padF = 0.12) {
    return (lo, hi) => {
      if (!(hi >= lo)) return { min: 0, max: 1 };
      const mid = (lo + hi) / 2, half = Math.max(hi - lo, minSpan) * (0.5 + padF);
      return { min: mid - half, max: mid + half };
    };
  }
  const LANES = [
    { key: "ecg", label: "ECG", h: 240, color: [COL.ecg], minSpan: 200, paper: true },
    { key: "acc", label: "XYZ g", h: 96, color: [COL.x, COL.y, COL.z], minSpan: 0.1, legend: ["X", "Y", "Z"] },
    { key: "mag", label: "|a| g", h: 92, color: [COL.mag], minSpan: 0.1, bottom: true },
  ];
  function clockValues(u, splits, ax, space, incr) {
    return splits.map((v) => fmtClock(v, incr < 1 ? 1 : 0));
  }
  function laneOpts(L, width) {
    const axisBase = { stroke: COL.text, font: FONT, ticks: { show: false } };
    const axes = [
      { ...axisBase, scale: "x", side: 2, space: L.bottom ? 80 : 60, incrs: [0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800],
        grid: { stroke: COL.grid, width: 1 }, values: L.bottom ? clockValues : (u, s) => s.map(() => ""),
        size: L.bottom ? 26 : 0 },
      { ...axisBase, scale: "y", label: L.label, labelSize: 14, labelFont: FONT, size: 50, space: L.h < 100 ? 22 : 35,
        grid: { stroke: COL.grid, width: 1 } },
      // right: HR bpm on the ECG lane; the same gutter, empty, on the others so the time axes line up
      L.key === "ecg"
        ? { ...axisBase, scale: "hr", side: 1, label: "HR bpm", labelSize: 14, labelFont: FONT, size: 44, space: 35,
            stroke: COL.hr, grid: { show: false } }
        : { scale: "y", side: 1, size: 44, grid: { show: false }, ticks: { show: false }, values: (u, s) => s.map(() => "") },
    ];
    if (L.paper) {   // ECG-paper fine grid: 40 ms / 200 ms as zoom allows
      axes.unshift({ scale: "x", side: 2, size: 0, incrs: [0.04, 0.2, 1, 5], space: 8,
                     splits: (u, ai, min, max, incr) => {   // none when zoomed far out
                       if (win > PAPER_MAX) return [];
                       const out = [];
                       for (let v = Math.ceil(min / incr) * incr; v <= max; v += incr) out.push(v);
                       return out;
                     },
                     grid: { stroke: COL.gridMinor, width: 1 }, ticks: { show: false }, values: () => [] });
    }
    const draw = [drawMeasure];
    if (L.key === "ecg") draw.unshift(drawHr, drawDots);
    if (L.legend) draw.unshift((u) => drawLegend(u, L));
    return {
      width, height: L.h, legend: { show: false }, pxAlign: 0, padding: [4, 0, L.bottom ? 0 : 4, 0],
      cursor: { sync: { key: "rvecg" }, y: false, points: { show: false }, drag: { x: false, y: false, setScale: false } },
      scales: { x: { time: false, auto: false }, y: { auto: false }, hr: { auto: false } },
      axes, series: [{}, ...L.color.map((c) => ({ stroke: c, width: LW, spanGaps: false, points: { show: false } }))],
      hooks: { draw, setCursor: [(u) => hover(u)] },
    };
  }
  function make() {
    const host = $("ecg-chart");
    host.innerHTML = "";
    lanes = {}; ranges = {};
    for (const L of LANES) {
      const div = document.createElement("div");
      div.className = "lane";
      host.appendChild(div);
      lanes[L.key] = new uPlot(laneOpts(L, host.clientWidth), [[], ...L.color.map(() => [])], div);
      ranges[L.key] = autoRange(L.minSpan);
    }
  }

  function draw() {
    if (!lanes || tc == null) return;
    const a = tc - win / 2, b = tc + win / 2, xr = { min: a, max: b };
    // ECG: min/max per bucket when zoomed out (~1 bucket per pixel keeps every R peak)
    const ex = [], ey = [];
    let lo = Infinity, hi = -Infinity;
    if (rawOk() && data && data.ses === ses.id) {
      const dt = 1 / data.fs, px = lanes.ecg.bbox.width || 1000;
      for (const s of data.segs) {
        const n = s.f.length;
        if (s.t + (n - 1) * dt < a - dt || s.t > b + dt) continue;
        const i0 = Math.max(0, Math.floor((a - s.t) / dt) - 1), i1 = Math.min(n - 1, Math.ceil((b - s.t) / dt) + 1);
        if (ex.length) { ex.push((ex[ex.length - 1] + s.t + i0 * dt) / 2); ey.push(null); }   // break
        const bucket = Math.max(1, Math.floor((i1 - i0 + 1) / px));
        for (let i = i0; i <= i1; i += bucket) {
          const e = Math.min(i1, i + bucket - 1);
          let mn = i, mx = i;
          for (let j = i; j <= e; j++) { if (s.f[j] < s.f[mn]) mn = j; if (s.f[j] > s.f[mx]) mx = j; }
          for (const j of mn === mx ? [mn] : mn < mx ? [mn, mx] : [mx, mn]) {
            ex.push(s.t + j * dt); ey.push(s.f[j]);
            if (s.t + j * dt >= a && s.t + j * dt <= b) { if (s.f[j] < lo) lo = s.f[j]; if (s.f[j] > hi) hi = s.f[j]; }
          }
        }
      }
    }
    set("ecg", [ex, ey], xr, lo, hi);
    lanes.ecg.setScale("hr", hrRange(a, b));
    // accelerometer: X/Y/Z and |a|, a break where samples are missing
    const ax = [], X = [], Y = [], Z = [], M = [];
    let alo = Infinity, ahi = -Infinity, mlo = Infinity, mhi = -Infinity;
    if (rawOk() && data && data.ses === ses.id) {
      const A = data.acc;
      for (let i = Math.max(0, lowerBound(A.t, a) - 1); i < A.t.length && (i === 0 || A.t[i - 1] <= b); i++) {
        if (ax.length && A.t[i] - ax[ax.length - 1] > ACC_GAP) {
          ax.push((A.t[i] + ax[ax.length - 1]) / 2); X.push(null); Y.push(null); Z.push(null); M.push(null);
        }
        const m = Math.hypot(A.x[i], A.y[i], A.z[i]);
        ax.push(A.t[i]); X.push(A.x[i]); Y.push(A.y[i]); Z.push(A.z[i]); M.push(m);
        if (A.t[i] >= a && A.t[i] <= b) {
          alo = Math.min(alo, A.x[i], A.y[i], A.z[i]); ahi = Math.max(ahi, A.x[i], A.y[i], A.z[i]);
          mlo = Math.min(mlo, m); mhi = Math.max(mhi, m);
        }
      }
    }
    set("acc", [ax, X, Y, Z], xr, alo, ahi);
    set("mag", [ax, M], xr, mlo, mhi);
    setText("ecg-pos", `${fmtClock(a, 1)} – ${fmtClock(b, 1)}`);
    setText("ecg-win", fmtWin(win));
    onView(a, b);
  }
  function set(key, d, xr, lo, hi) {
    const u = lanes[key];
    u.batch(() => {
      u.setData(d, false);
      u.setScale("x", xr);
      u.setScale("y", ranges[key](lo, hi));
    });
  }

  // beat-to-beat HR of the beats in [a, b] (one beyond each end, so the line reaches the edges);
  // null = a break (corrected beat, or beats lost before this one)
  function hrPoints(a, b) {
    const bt = ses.beats.t, rr = ses.beats.rr, gap = ses.beats.gap, pts = [];
    for (let i = Math.max(0, lowerBound(bt, a) - 1); i < bt.length; i++) {
      if (gap[i] && pts.length) pts.push(null);
      pts.push(cl.bad[i] ? null : { t: bt[i], v: 60000 / rr[i] });
      if (bt[i] > b) break;
    }
    return pts;
  }
  function hrRange(a, b) {
    let lo = Infinity, hi = -Infinity;
    if (ses && cl) for (const p of hrPoints(a, b)) if (p && p.t >= a && p.t <= b) { lo = Math.min(lo, p.v); hi = Math.max(hi, p.v); }
    if (!(hi >= lo)) return { min: 40, max: 120 };
    const mid = (lo + hi) / 2, half = Math.max(hi - lo, HR_MIN_SPAN) * 0.6;
    return { min: mid - half, max: mid + half };
  }
  function drawHr(u) {
    if (!ses || !cl || tc == null) return;
    const ctx = u.ctx, { left, top, width, height } = u.bbox, dpr = devicePixelRatio;
    const pts = hrPoints(tc - win / 2, tc + win / 2);
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    ctx.strokeStyle = COL.hr; ctx.lineWidth = 1.5 * dpr; ctx.globalAlpha = 0.85;
    ctx.beginPath();
    let pen = false;
    for (const p of pts) {
      if (!p) { pen = false; continue; }
      const x = u.valToPos(p.t, "x", true), y = u.valToPos(p.v, "hr", true);
      if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
    ctx.fillStyle = COL.hr;            // a small mark on each beat
    if (win <= HR_MARK_MAX) for (const p of pts) if (p) ctx.fillRect(u.valToPos(p.t, "x", true) - 1.5 * dpr, u.valToPos(p.v, "hr", true) - 1.5 * dpr, 3 * dpr, 3 * dpr);
    ctx.restore();
  }
  function drawDots(u) {
    if (!rawOk() || !data || data.ses !== ses.id || !data.dots) return;
    const ctx = u.ctx, { left, top, width, height } = u.bbox, dpr = devicePixelRatio;
    const a = tc - win / 2, b = tc + win / 2, labels = win <= LABEL_WIN;
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    ctx.font = `600 ${11 * dpr}px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    const r = 3.5 * dpr;
    for (const d of data.dots) {
      if (d.t < a || d.t > b) continue;
      const px = u.valToPos(d.t, "x", true), py = u.valToPos(d.v, "y", true);
      const up = d.v >= u.posToVal(u.bbox.top + u.bbox.height / 2, "y", true) ? 1 : -1;   // label away from the trace
      ctx.beginPath(); ctx.arc(px, py, r, 0, 2 * Math.PI);
      if (d.bad) { ctx.strokeStyle = COL.bad; ctx.lineWidth = 1.5 * dpr; ctx.stroke(); }
      else { ctx.fillStyle = COL.beat; ctx.fill(); }
      if (labels) {
        ctx.fillStyle = d.bad ? COL.bad : COL.text;
        ctx.textBaseline = up > 0 ? "bottom" : "top";
        ctx.fillText(`${Math.round(d.rr)}${d.bad ? " corr." : ""}`, px, py - up * (r + 3 * dpr));
      }
    }
    ctx.restore();
  }
  function drawLegend(u, L) {
    const ctx = u.ctx, dpr = devicePixelRatio;
    ctx.save();
    ctx.font = `600 ${11 * dpr}px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif`;
    ctx.textBaseline = "top"; ctx.textAlign = "left";
    let x = u.bbox.left + 6 * dpr;
    const tw = L.legend.reduce((w, name) => w + ctx.measureText(name).width + 8 * dpr, 0);
    ctx.fillStyle = COL.measBox; ctx.fillRect(x - 4 * dpr, u.bbox.top + dpr, tw, 15 * dpr);
    L.legend.forEach((name, i) => {
      ctx.fillStyle = L.color[i];
      ctx.fillText(name, x, u.bbox.top + 3 * dpr);
      x += ctx.measureText(name).width + 8 * dpr;
    });
    ctx.restore();
  }

  // ---------- measure (as live: click start, click end; Esc clears) ----------
  function measText(a, b) {
    const ms = Math.abs(b - a) * 1000;
    return `Δt ${ms < 10000 ? ms.toFixed(0) + " ms" : (ms / 1000).toFixed(2) + " s"}` +
           (ms > 0 ? ` · ${(60000 / ms).toFixed(1)} bpm` : "");
  }
  function drawMeasure(u) {
    const a = meas.a, b = meas.b != null ? meas.b : (measureMode && hoverT != null ? hoverT : null);
    if (a == null) return;
    const ctx = u.ctx, { left, top, width, height } = u.bbox, dpr = devicePixelRatio;
    const xa = u.valToPos(a, "x", true), xb = b != null ? u.valToPos(b, "x", true) : null;
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    if (xb != null) { ctx.fillStyle = COL.measFill; ctx.fillRect(Math.min(xa, xb), top, Math.abs(xb - xa), height); }
    ctx.strokeStyle = COL.meas; ctx.lineWidth = dpr;
    ctx.setLineDash(meas.b == null ? [4 * dpr, 3 * dpr] : []);
    for (const x of xb != null ? [xa, xb] : [xa]) { ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke(); }
    ctx.restore();
  }
  function setMeasureMode(on) {
    measureMode = on;
    $("ecg-measure").classList.toggle("active", on);
    if (on) meas = { a: null, b: null };
    measReadout();
    redraw();
  }
  function measReadout() {
    setText("ecg-meas", meas.a != null && meas.b != null ? measText(meas.a, meas.b) : measureMode ? "click start…" : "");
  }
  function redraw() { if (lanes) for (const k in lanes) lanes[k].redraw(false, false); }

  function hover(u) {
    const l = u.cursor.left;
    hoverT = l == null || l < 0 ? null : u.posToVal(l, "x");
    if (measureMode && meas.a != null && meas.b == null) {
      for (const k in lanes) if (lanes[k] !== u) lanes[k].redraw(false, false);
      setText("ecg-meas", hoverT != null ? measText(meas.a, hoverT) : "");
    }
    if (hoverT == null) { setText("ecg-hover", ""); return; }
    let txt = fmtClock(hoverT, 2);
    if (ses && ses.beats.t.length) {                // the beat ending at / after the cursor
      const bt = ses.beats.t, i = Math.min(lowerBound(bt, hoverT), bt.length - 1);
      const rr = ses.beats.rr[i], bad = cl.bad[i];
      if (Math.abs(bt[i] - hoverT) < 2) txt += ` · RR ${Math.round(rr)} ms${bad ? " (corrected)" : ""} · ${(60000 / rr).toFixed(0)} bpm`;
    }
    setText("ecg-hover", txt);
  }

  // ---------- navigation ----------
  function bounds() {
    const t = ses.beats.t;
    return [t[0], t[t.length - 1]];
  }
  function goTo(t) {
    if (!ses || !ses.beats.t.length) return;
    const [t0, t1] = bounds();
    win = clamp(win);
    // keep the window inside the session (centred when it is the whole session)
    tc = t1 - t0 <= win ? (t0 + t1) / 2 : Math.min(t1 - win / 2, Math.max(t0 + win / 2, t));
    ensure();
  }
  function setWin(w, anchor) {
    const old = win;
    win = clamp(w);
    try { localStorage.setItem("hrm.rvwin", String(win)); } catch (e) {}
    if (anchor != null && tc != null) tc = anchor + (tc - anchor) * (win / old);
    goTo(tc);
  }
  function step(dir) { if (tc != null) goTo(tc + dir * 0.9 * win); }

  function syncNotch() {
    const ns = $("ecg-notch");
    if (strapNotch) {
      ns.value = "strap"; ns.querySelector('option[value="strap"]').textContent = `Notch in strap ${strapNotch} Hz`;
      ns.disabled = true; ns.title = "The strap already removed mains hum in this recording";
    } else {
      ns.value = String(notchPref || 0); ns.disabled = false;
      ns.title = "Mains-hum notch on the displayed ECG only (the recording stays raw)";
    }
  }

  function bindInput() {
    const host = $("ecg-chart");
    host.addEventListener("wheel", (e) => {
      if (tc == null) return;
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
      setWin(win * Math.exp(dy * 0.002), hoverT);
    }, { passive: false });
    let drag = null;
    host.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || tc == null) return;
      drag = { x: e.clientX, tc, moved: false };
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      if (drag.moved) {
        const w = lanes.ecg.bbox.width / devicePixelRatio || 1;
        goTo(drag.tc - dx * win / w);
      }
    });
    window.addEventListener("mouseup", () => {
      if (drag && !drag.moved && measureMode) {
        const u = lanes.ecg, t = u.posToVal(drag.x - u.over.getBoundingClientRect().left, "x");
        if (meas.a == null || meas.b != null) meas = { a: t, b: null };
        else meas.b = t;
        measReadout(); redraw();
      }
      drag = null;
    });
    host.addEventListener("dblclick", () => { if (!measureMode) setWin(WIN_DEFAULT); });
    document.addEventListener("keydown", (e) => {
      if (tc == null || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.key === "ArrowLeft") { step(-1); e.preventDefault(); }
      else if (e.key === "ArrowRight") { step(1); e.preventDefault(); }
      else if (e.key === "m" || e.key === "M") setMeasureMode(!measureMode);
      else if (e.key === "Escape") { meas = { a: null, b: null }; measReadout(); redraw(); }
    });
    $("ecg-prev").addEventListener("click", () => step(-1));
    $("ecg-next").addEventListener("click", () => step(1));
    $("ecg-zoom-out").addEventListener("click", () => setWin(win * 1.5));
    $("ecg-zoom-in").addEventListener("click", () => setWin(win / 1.5));
    $("ecg-zoom-all").addEventListener("click", () => setWin(winMax()));
    $("ecg-measure").addEventListener("click", () => setMeasureMode(!measureMode));
    $("ecg-notch").addEventListener("change", (e) => {
      notchPref = +e.target.value || 0;
      try { localStorage.setItem("hrm.notch", String(notchPref)); } catch (err) {}
      prepare(); draw();
    });
  }

  function setText(id, s) { const e = $(id); if (e) e.textContent = s; }

  const EcgView = {
    // o.onView(a, b): the visible window changed (the page marks it on its charts)
    init(o) {
      onView = (o && o.onView) || onView;
      make(); bindInput(); syncNotch();
    },
    setSession(s, c) {
      ses = s; cl = c; data = null; tc = null; reqId++;
      strapNotch = (s.meta && s.meta.ecg_info && s.meta.ecg_info.notched_hz) || 0;
      syncNotch();
      setText("ecg-fs", s.meta && s.meta.ecg_fs ? `${s.meta.ecg_fs} Hz` : "");
      meas = { a: null, b: null }; measReadout();
    },
    goTo,
    view() { return tc == null ? null : [tc - win / 2, tc + win / 2]; },
    resize() {
      if (!lanes) return;
      const w = $("ecg-chart").clientWidth;
      for (const L of LANES) lanes[L.key].setSize({ width: w, height: L.h });
      draw();
    },
  };
  root.EcgView = EcgView;
})(window);
