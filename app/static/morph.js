/* Beat timing page: every beat of a chosen period warped (DTW) onto the
 * period's averaged beat; shows where in the cycle the timing differs, how
 * that changes beat by beat, and how it follows the RR interval.
 * Analysis in dtw.js; data from /api/sessions/<id> and its /ecg windows. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const css = getComputedStyle(document.documentElement);
  const C = (name) => css.getPropertyValue(name).trim();
  const COL = {
    text: C("--muted"), grid: C("--grid"), fg: C("--text"), hr: C("--hr"), ecg: C("--ecg"),
    ref: "#9aa5b4", warp: "#ffb454", link: "rgba(139,150,165,0.35)", sel: "rgba(90,162,255,0.16)",
    late: [255, 84, 112], early: [90, 162, 255], mid: [23, 27, 34], dist: "#c792ea",
  };
  const FONT = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  const MAX_LEN = 600, CHUNK = 196, OVERLAP = 2;     // s; the server serves at most 200 s at once

  let ses = null, cl = null;            // session and HRV.clean of its beats
  let sel = null;                       // analysed period [a, b] (unix s)
  let ecg = null;                       // fetched raw ECG {ses, a, b, fs, segs, notched}
  let res = null;                       // BeatDTW.analyse result
  let kb = 0, ip = null;                // current beat (index in res.beats), chosen phase (sample)
  let want = null;                      // beat time / phase (ms) to restore from the URL
  let ov = null, bU = null, dU = null, hU = null, lU = null, sU = null;
  let runId = 0, timer = 0;

  // ---------- formatting ----------
  const pad = (v) => String(v).padStart(2, "0");
  function clock(t, dec) {
    const d = new Date(t * 1000);
    let s = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    if (dec) s += "." + String(Math.floor((t % 1 + 1) % 1 * 10 ** dec)).padStart(dec, "0");
    return s;
  }
  const fmtDate = (t) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  function fmtDur(s) {
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
    return h ? `${h} h ${pad(m)} min` : m ? `${m} min ${pad(r)} s` : `${r} s`;
  }
  const sg = (v, d = 1) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(d);
  function setText(id, s) { const e = $(id); if (e) e.textContent = s; }
  function axis(o) {
    return { stroke: COL.text, font: FONT, ticks: { show: false }, grid: { stroke: COL.grid, width: 1 },
             labelFont: FONT, labelSize: 14, ...o };
  }

  // ---------- parameters ----------
  const PARAM_IDS = ["p-method", "p-kn", "p-causal", "p-pre", "p-post", "p-band", "p-feat", "p-pen", "p-smooth", "p-ref", "h-scale", "sel-len"];
  try {
    const saved = JSON.parse(localStorage.getItem("hrm.morph") || "{}");
    for (const id of PARAM_IDS) if (saved[id] != null) $(id).value = saved[id];
    const n = localStorage.getItem("hrm.notch");
    if (n != null) $("p-notch").value = n;
    $("b-offset").checked = saved["b-offset"] !== false;
  } catch (e) {}
  function saveParams() {
    try {
      const o = Object.fromEntries(PARAM_IDS.map((id) => [id, $(id).value]));
      o["b-offset"] = $("b-offset").checked;
      localStorage.setItem("hrm.morph", JSON.stringify(o));
    } catch (e) {}
  }
  function params() {
    const num = (id, d) => { const v = parseFloat($(id).value); return isFinite(v) ? v : d; };
    const notchSel = $("p-notch").value;
    return {
      fs: ecg.fs,
      notch: ecg.notched ? 0 : +notchSel || 0,
      pre: num("p-pre", null),                 // null: from the median RR (dtw.js)
      post: num("p-post", null),
      band: Math.max(2, num("p-band", 50)),
      feat: $("p-feat").value,
      pen: Math.max(0, num("p-pen", 0.5)),
      smoothMs: Math.max(0, num("p-smooth", 10)),
      median: $("p-ref").value === "median",
      method: $("p-method").value,
      kn: Math.max(2, Math.round(num("p-kn", 30))),
      causal: $("p-causal").value === "before",
    };
  }

  // ---------- sessions ----------
  async function loadList() {
    const list = await (await fetch("/api/sessions")).json();
    const s = $("ses-select");
    s.innerHTML = "";
    for (const x of list) {
      const o = document.createElement("option");
      o.value = x.id;
      o.textContent = `${fmtDate(x.start)} ${clock(x.start).slice(0, 5)} – ${clock(x.end).slice(0, 5)} · ${fmtDur(x.end - x.start)}`;
      s.appendChild(o);
    }
    if (!list.length) { setText("ses-info", "no recordings yet"); return; }
    const h = hashParams();
    s.value = list.some((x) => x.id === h.s) ? h.s : list[0].id;
    if (h.s === s.value) want = { k: h.k, p: h.p };
    await loadSession(s.value, h.s === s.value && h.b > h.a ? [h.a, h.b] : null);
  }
  async function loadSession(id, range) {
    setText("ses-info", "loading…");
    const r = await fetch("/api/sessions/" + id);
    if (!r.ok) { setText("ses-info", "could not load: " + r.status); return; }
    ses = await r.json();
    const b = ses.beats;
    cl = HRV.clean(b.rr, Uint8Array.from(b.gap, (g) => (g ? 1 : 0)));
    setText("ses-info", b.t.length ? `${b.t.length} beats · ECG ${ses.meta && ses.meta.ecg_fs ? ses.meta.ecg_fs + " Hz" : ""}` : "no beats");
    ecg = null; res = null;
    if (!b.t.length) return;
    const t0 = b.t[0], t1 = b.t[b.t.length - 1];
    if (range && range[0] >= t0 - 1 && range[1] <= t1 + 1) {
      sel = [range[0], Math.min(range[1], range[0] + MAX_LEN)];
      $("sel-len").value = String([60, 120, 300, 600].find((v) => v >= sel[1] - sel[0] - 1) || 600);
    } else {
      const len = +$("sel-len").value;
      sel = [t0, Math.min(t1, t0 + len)];
    }
    drawOverview();
    await run();
  }
  function setPeriod(a) {
    const t = ses.beats.t, len = +$("sel-len").value;
    a = Math.max(t[0], Math.min(t[t.length - 1] - len, a));
    sel = [a, Math.min(t[t.length - 1], a + len)];
    want = null;
    if (ov) ov.redraw(false, false);
    schedule(true);
  }

  // ---------- raw ECG (in chunks the server allows) ----------
  async function fetchEcg(id) {
    if (ecg && ecg.ses === ses.id && ecg.a <= sel[0] && ecg.b >= sel[1]) return ecg;
    const segs = [];
    let fs = null, notched = 0;
    for (let a = sel[0] - OVERLAP; a < sel[1] + OVERLAP; a += CHUNK) {
      if (id !== runId) return null;
      setText("status", `loading the raw ECG… ${Math.round(100 * (a - sel[0] + OVERLAP) / (sel[1] - sel[0] + 2 * OVERLAP))} %`);
      const b = Math.min(a + CHUNK + 2 * OVERLAP, sel[1] + OVERLAP);
      const r = await fetch(`/api/sessions/${ses.id}/ecg?a=${a.toFixed(3)}&b=${b.toFixed(3)}`);
      if (!r.ok) throw new Error(r.status === 404 ? "no raw ECG in this session" : "HTTP " + r.status);
      const d = await r.json();
      fs = d.fs; notched = d.notched_hz || 0;
      for (const g of d.ecg) {                 // chunks overlap: join a segment onto the one it continues
        const p = segs[segs.length - 1], pEnd = p ? p.t + (p.v.length - 1) / fs : -Infinity;
        if (p && g.t <= pEnd + 1.5 / fs && g.t + (g.v.length - 1) / fs > pEnd) {
          const from = Math.round((pEnd - g.t) * fs) + 1;
          p.v = p.v.concat(g.v.slice(Math.max(0, from)));
        } else if (!p || g.t > pEnd) segs.push({ t: g.t, v: g.v });
      }
    }
    return { ses: ses.id, a: sel[0], b: sel[1], fs, segs, notched };
  }

  function schedule(refetch) {
    clearTimeout(timer);
    if (refetch) ecg = null;
    timer = setTimeout(run, 150);
  }
  async function run() {
    if (!ses || !sel) return;
    const id = ++runId;
    writeHash();
    setText("sel-text", `${clock(sel[0])} – ${clock(sel[1])} · ${fmtDur(sel[1] - sel[0])}`);
    try {
      const e = await fetchEcg(id);
      if (!e || id !== runId) return;
      ecg = e;
    } catch (err) {
      if (id === runId) { setText("status", String(err.message || err)); res = null; drawAll(); }
      return;
    }
    syncNotch();
    setText("status", "computing…");
    await new Promise((r) => setTimeout(r, 10));
    if (id !== runId) return;
    const P = params();
    const T = performance.now();
    // R peaks from the ECG itself; the app's artifact / ectopy rules on their RR
    const clean = (rr, gap) => HRV.clean(rr, Uint8Array.from(gap)).bad;
    res = P.method === "kernel"
      ? BeatDTW.kernelAnalyse(ecg.segs, { ...P, from: sel[0], to: sel[1], clean })
      : BeatDTW.analyse(ecg.segs, { ...P, from: sel[0], to: sel[1], clean });
    const fw = lowerBound(ses.beats.t, sel[1]) - lowerBound(ses.beats.t, sel[0]);
    const nUse = res ? res.beats.filter((x) => x.fits).length : 0, ms = Math.round(performance.now() - T);
    setText("status", !res ? "no beats with raw ECG here"
      : res.method === "kernel"
        ? `${res.beats.length} beats found in the ECG (strap: ${fw}) · ${res.nClean} clean R–R cycles · kernel: ${res.kn} cycles ${P.causal ? "before" : "around"} each · ${ms} ms`
        : `${res.beats.length} beats found in the ECG (strap: ${fw}) · ${nUse} in the reference · window ${res.win[0]}+${res.win[1]} ms · ${ms} ms`);
    if (res) {
      // restore the beat / phase from the URL, else the first clean beat and the T-wave peak
      kb = Math.max(0, res.beats.findIndex((x) => x.fits));
      if (want && want.k != null) kb = nearestBeat(want.k);
      ip = want && want.p != null ? Math.round(want.p * res.fs / 1000) + res.pre : tPeak();
      ip = Math.max(0, Math.min(res.n - 1, ip));
      want = null;
    }
    drawAll();
    writeHash();
  }
  function tPeak() {
    let best = res.pre + Math.round(0.12 * res.fs), bv = -Infinity;
    for (let i = best; i < res.n - Math.round(0.02 * res.fs); i++) if (res.ref[i] * res.pol > bv) { bv = res.ref[i] * res.pol; best = i; }
    return best;
  }
  function nearestBeat(t) {
    let k = 0;
    res.beats.forEach((b, i) => { if (Math.abs(b.r - t) < Math.abs(res.beats[k].r - t)) k = i; });
    return k;
  }
  function lowerBound(xs, v) {
    let lo = 0, hi = xs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < v) lo = m + 1; else hi = m; }
    return lo;
  }
  function syncNotch() {
    const ns = $("p-notch");
    if (ecg && ecg.notched) {
      const o = ns.querySelector('option[value="strap"]');
      o.textContent = `Notch in strap ${ecg.notched} Hz`; o.hidden = false;
      ns.value = "strap"; ns.disabled = true;
    } else if (ns.disabled) {
      ns.disabled = false; ns.querySelector('option[value="strap"]').hidden = true;
      try { ns.value = localStorage.getItem("hrm.notch") || "50"; } catch (e) { ns.value = "50"; }
    }
  }

  // ---------- overview: HR over the session, the analysed period ----------
  function drawOverview() {
    const b = ses.beats;
    const hr = b.rr.map((v, i) => (cl.bad[i] || (i + 1 < b.gap.length && b.gap[i + 1]) ? null : 60000 / v));
    if (ov) ov.destroy();
    ov = new uPlot({
      width: $("ov-chart").clientWidth, height: 120, legend: { show: false }, pxAlign: 0, padding: [8, 8, 0, 0],
      cursor: { y: false, points: { show: false }, drag: { x: true, y: false, setScale: false } },
      select: { show: true },
      scales: { x: { time: true }, y: { auto: true } },
      axes: [axis({ space: 90 }), axis({ label: "HR bpm", size: 50 })],
      series: [{}, { stroke: COL.hr, width: 1, spanGaps: false, points: { show: false } }],
      hooks: {
        setSelect: [(u) => {
          if (u.select.width < 4) return;
          let a = u.posToVal(u.select.left, "x"), c = u.posToVal(u.select.left + u.select.width, "x");
          u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
          c = Math.min(c, a + MAX_LEN);
          $("sel-len").value = String([60, 120, 300, 600].find((v) => v >= c - a - 1) || 600);
          sel = [a, c]; want = null; u.redraw(false, false); schedule(true);
        }],
        drawClear: [(u) => {
          if (!sel) return;
          const ctx = u.ctx, x0 = u.valToPos(sel[0], "x", true), x1 = u.valToPos(sel[1], "x", true);
          ctx.save(); ctx.fillStyle = COL.sel;
          ctx.fillRect(x0, u.bbox.top, Math.max(2, x1 - x0), u.bbox.height); ctx.restore();
        }],
      },
    }, [b.t, hr], $("ov-chart"));
    clickOn(ov, (t) => setPeriod(t - (sel[1] - sel[0]) / 2));
  }
  // a click without dragging: f(x value)
  function clickOn(u, fn) {
    let down = null;
    u.over.addEventListener("mousedown", (e) => { down = e.clientX; });
    u.over.addEventListener("mouseup", (e) => {
      if (down != null && Math.abs(e.clientX - down) < 4) fn(u.posToVal(e.clientX - u.over.getBoundingClientRect().left, "x"),
        e.clientY - u.over.getBoundingClientRect().top, u);
      down = null;
    });
  }

  // ---------- charts ----------
  function drawAll() {
    for (const u of [bU, dU, hU, lU, sU, kU, kL]) if (u) u.destroy();
    bU = dU = hU = lU = sU = kU = kL = null;
    for (const id of ["b-chart", "d-chart", "h-chart", "h-lane", "s-chart", "k-chart", "k-lane"]) $(id).innerHTML = "";
    const kern = !!(res && res.method === "kernel");
    $("k-card").hidden = !kern;
    if (!res) { setText("b-text", "–"); setText("d-readout", ""); setText("s-readout", ""); return; }
    makeBeat(); makeDelta(); makeHeat(); makeScatter();
    if (kern) makeTrain();
    showBeat();
  }
  const W = (id) => $(id).clientWidth;
  const sync = { key: "dtwcyc" };

  // beat chart data: [x, reference / kernel, beat, warped] and the matching lines [x0, y0, x1, y1]
  let bLinks = [];
  function beatData() {
    if (res.method === "kernel") return beatDataK();
    const b = res.beats[kb], off = $("b-offset").checked ? offset() : 0, fs = res.fs;
    const step = Math.max(1, Math.round(res.n / 70));
    bLinks = [];
    for (let i = 0; i < res.n; i += step) {
      const j = i + b.delta[i] * fs / 1000;
      bLinks.push([res.tms[i], res.ref[i], (j - res.pre) * 1000 / fs, interp(b.y, j) - off]);
    }
    return [Array.from(res.tms), Array.from(res.ref), b.y.map((v) => v - off), Array.from(b.warped)];
  }
  // kernel method: the tail of the cycle before R and the head of the cycle after,
  // each with its own kernel, x in ms from this beat's R
  function beatDataK() {
    const b = res.beats[kb], cp = b.cp, cn = b.cn, dt = 1000 / res.fs, off = $("b-offset").checked ? offset() : 0;
    const kt = [], kv = [], kw = [], rt = [], rv = [], mp = cp.y.length - 1;
    for (let s = Math.floor(cp.spK); s <= cp.Lk; s++) { kt.push((s - cp.Lk) * dt); kv.push(cp.kernel[s]); kw.push(cp.warped[s]); }
    for (let s = 1; s <= Math.ceil(cn.spK); s++) { kt.push(s * dt); kv.push(cn.kernel[s]); kw.push(cn.warped[s]); }
    for (let j = Math.floor(interp(cp.map, cp.spK)); j <= mp; j++) { rt.push((j - mp) * cp.step * dt); rv.push(cp.y[j]); }
    for (let j = 1; j <= Math.ceil(interp(cn.map, cn.spK)); j++) { rt.push(j * cn.step * dt); rv.push(cn.y[j]); }
    const t0 = Math.min(kt[0], rt[0]), t1 = Math.max(kt[kt.length - 1], rt[rt.length - 1]), xs = [];
    for (let t = t0; t <= t1 + 1e-9; t += dt) xs.push(t);
    const grid = (ts, vs, o) => xs.map((x) => (x < ts[0] - 1e-9 || x > ts[ts.length - 1] + 1e-9 ? null : lin(ts, vs, x) - o));
    const step = Math.max(1, Math.round(kt.length / 70));
    bLinks = [];
    for (let s = Math.ceil(cp.spK); s <= cp.Lk; s += step) bLinks.push([(s - cp.Lk) * dt, cp.kernel[s], (cp.map[s] - mp) * cp.step * dt, interp(cp.y, cp.map[s]) - off]);
    for (let s = 0; s <= cn.spK; s += step) bLinks.push([s * dt, cn.kernel[s], cn.map[s] * cn.step * dt, interp(cn.y, cn.map[s]) - off]);
    return [xs, grid(kt, kv, 0), grid(rt, rv, off), grid(kt, kw, 0)];
  }
  // linear interpolation in sorted ts
  function lin(ts, vs, x) {
    let lo = 0, hi = ts.length - 1;
    if (x <= ts[0]) return vs[0];
    if (x >= ts[hi]) return vs[hi];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= x) lo = m; else hi = m; }
    const d = ts[hi] - ts[lo];
    return d > 0 ? vs[lo] + (vs[hi] - vs[lo]) * (x - ts[lo]) / d : vs[lo];
  }
  function offset() {
    let lo = Infinity, hi = -Infinity;
    for (const v of res.ref) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return 1.15 * (hi - lo);
  }
  function makeBeat() {
    bU = new uPlot({
      width: W("b-chart"), height: 260, legend: { show: false }, pxAlign: 0, padding: [8, 8, 0, 0],
      cursor: { sync, y: false, points: { show: false }, drag: { x: false, y: false } },
      scales: { x: { time: false }, y: { auto: true } },
      axes: [axis({ size: 4, values: () => [] }), axis({ label: "ECG", size: 50 })],
      series: [{}, { stroke: COL.ref, width: 2, points: { show: false } },
               { stroke: COL.ecg, width: 1.2, points: { show: false } },
               { stroke: COL.warp, width: 1, dash: [5, 4], points: { show: false } }],
      hooks: { drawSeries: [drawLinks], draw: [phaseLine] },
    }, beatData(), $("b-chart"));
  }
  // matching lines: reference / kernel point -> the beat's point it was warped to
  function drawLinks(u, si) {
    if (si !== 2) return;
    strokeLinks(u, bLinks);
  }
  function strokeLinks(u, links) {
    const ctx = u.ctx;
    ctx.save();
    ctx.beginPath(); ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height); ctx.clip();
    ctx.strokeStyle = COL.link; ctx.lineWidth = devicePixelRatio;
    ctx.beginPath();
    for (const [x0, y0, x1, y1] of links) {
      ctx.moveTo(u.valToPos(x0, "x", true), u.valToPos(y0, "y", true));
      ctx.lineTo(u.valToPos(x1, "x", true), u.valToPos(y1, "y", true));
    }
    ctx.stroke();
    ctx.restore();
  }

  // ---------- kernel method: the real ECG against the train of kernels ----------
  let kU = null, kL = null, kLinks = [];
  // view of the train: centre and width (s); wheel zooms, drag scrolls, double-click: 8 s
  const KWIN_DEFAULT = 8, KWIN_MIN = 1, KMAX_PTS = 4000, KLINKS_MAX_S = 20;
  let kc = null, kw = KWIN_DEFAULT;
  try { kw = Math.max(KWIN_MIN, parseFloat(localStorage.getItem("hrm.morph.kwin")) || KWIN_DEFAULT); } catch (e) {}
  function kClamp() {
    const lo = sel[0] - 2, hi = sel[1] + 2;
    kw = Math.max(KWIN_MIN, Math.min(hi - lo, kw));
    kc = Math.max(lo + kw / 2, Math.min(hi - kw / 2, kc));
  }
  function trainData() {
    kClamp();
    const fs = res.fs, a = kc - kw / 2, e = kc + kw / 2;
    const off = $("b-offset").checked ? offset() : 0, n = Math.round(kw * fs) + 1;
    const real = new Float64Array(n).fill(NaN), ker = new Float64Array(n).fill(NaN), del = new Float64Array(n).fill(NaN);
    const put = (arr, t, v) => { const q = Math.round((t - a) * fs); if (q >= 0 && q < n) arr[q] = v; };
    const links = kw <= KLINKS_MAX_S;
    kLinks = [];
    for (const c of res.cycles) {
      if (c.r1 < a || c.r0 > e) continue;
      const m = c.y.length - 1;
      for (let j = 0; j <= m; j++) put(real, c.r0 + j * c.step / fs, c.y[j] - off);
      if (!c.kernel || !c.map) continue;
      for (let s = 0; s <= c.Lk; s++) { const t = c.r0 + s / fs; if (t > c.r1 + 0.5 / fs) break; put(ker, t, c.kernel[s]); }
      // delta on real time: head (timed from the R at the start) and tail (from the R at the end) apart
      for (const [s0, s1, d] of [[0, Math.floor(c.spK), c.dh], [Math.ceil(c.spK), c.Lk, c.dt]]) {
        let pt = null, pv = null;
        for (let s = s0; s <= s1; s++) {
          const t = c.r0 + c.map[s] * c.step / fs, v = d[s];
          if (pt != null) {                                     // fill the grid between two path points
            for (let q = Math.max(0, Math.ceil((pt - a) * fs)); q <= Math.min(n - 1, Math.floor((t - a) * fs)); q++) {
              const tq = a + q / fs;
              del[q] = t > pt ? pv + (v - pv) * (tq - pt) / (t - pt) : v;
            }
          }
          pt = t; pv = v;
        }
      }
      if (!links) continue;
      const step = Math.max(4, Math.round(kw * fs / 160));    // ~160 lines across the view
      for (let s = 0; s <= c.Lk; s += step) {
        const tk = c.r0 + s / fs;
        if (tk > c.r1) break;
        kLinks.push([tk, c.kernel[s], c.r0 + c.map[s] * c.step / fs, interp(c.y, c.map[s]) - off]);
      }
    }
    // zoomed out: min and max per bucket (every QRS stays visible)
    const B = n > KMAX_PTS ? Math.ceil(n / (KMAX_PTS / 2)) : 1;
    const xs = [], cols = [real, ker, del], out = [[], [], []];
    const val = (v) => (isNaN(v) ? null : v);
    if (B === 1) {
      for (let q = 0; q < n; q++) { xs.push(a + q / fs); for (let k = 0; k < 3; k++) out[k].push(val(cols[k][q])); }
    } else {
      for (let q0 = 0; q0 < n; q0 += B) {
        const q1 = Math.min(n, q0 + B);
        xs.push(a + q0 / fs, a + (q0 + q1 - 1) / 2 / fs);
        for (let k = 0; k < 3; k++) {
          let lo = Infinity, hi = -Infinity;
          for (let q = q0; q < q1; q++) { const v = cols[k][q]; if (!isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
          out[k].push(lo === Infinity ? null : lo, hi === -Infinity ? null : hi);
        }
      }
    }
    return { a, e, xs, real: out[0], ker: out[1], del: out[2] };
  }
  function makeTrain() {
    const ts = { key: "dtwtrain" };
    kc = res.beats[kb].r;
    const d = trainData();
    trainRange = [d.a, d.e];
    kU = new uPlot({
      width: W("k-chart"), height: 260, legend: { show: false }, pxAlign: 0, padding: [8, 8, 0, 0],
      cursor: { sync: ts, y: false, points: { show: false }, drag: { x: false, y: false } },
      scales: { x: { time: true, auto: false, range: () => [trainRange[0], trainRange[1]] }, y: { auto: true } },
      axes: [axis({ size: 4, values: () => [] }), axis({ label: "ECG", size: 50 })],
      series: [{}, { stroke: COL.ref, width: 2, spanGaps: false, points: { show: false } },
               { stroke: COL.ecg, width: 1.2, spanGaps: false, points: { show: false } }],
      hooks: { drawSeries: [(u, si) => { if (si === 2) strokeLinks(u, kLinks); }], draw: [beatLine] },
    }, [d.xs, d.ker, d.real], $("k-chart"));
    kL = new uPlot({
      width: W("k-lane"), height: 150, legend: { show: false }, pxAlign: 0, padding: [6, 8, 0, 0],
      cursor: { sync: ts, y: false, points: { show: false }, drag: { x: false, y: false } },
      scales: { x: { time: true, auto: false, range: () => [trainRange[0], trainRange[1]] },
                y: { auto: true, range: (u, lo, hi) => { const m = Math.max(5, Math.abs(lo), Math.abs(hi)) * 1.1; return [-m, m]; } } },
      axes: [axis({ space: 90, values: (u, v) => v.map((x) => clock(x, kw < 60 ? 1 : 0)) }), axis({ label: "Δ ms", size: 50 })],
      series: [{}, { stroke: COL.hr, width: 1.5, spanGaps: false, points: { show: false } }],
      hooks: { draw: [beatLine, (u) => {
        const ctx = u.ctx, y = u.valToPos(0, "y", true);
        ctx.save(); ctx.strokeStyle = COL.text; ctx.globalAlpha = 0.5; ctx.lineWidth = devicePixelRatio;
        ctx.beginPath(); ctx.moveTo(u.bbox.left, y); ctx.lineTo(u.bbox.left + u.bbox.width, y); ctx.stroke(); ctx.restore();
      }] },
    }, [d.xs, d.del], $("k-lane"));
    setText("k-winl", fmtWin(kw));
  }
  let trainRange = [0, 1], kRaf = 0;
  // recentre: on the shown beat (when a beat is picked elsewhere)
  function showTrain(recentre = true) {
    if (!kU) return;
    if (recentre) kc = res.beats[kb].r;
    cancelAnimationFrame(kRaf);
    kRaf = requestAnimationFrame(() => {
      const d = trainData();
      trainRange = [d.a, d.e];
      kU.setData([d.xs, d.ker, d.real]);
      kL.setData([d.xs, d.del]);
      setText("k-winl", fmtWin(kw));
    });
  }
  function fmtWin(w) { return w < 10 ? w.toFixed(1) + " s" : w < 120 ? Math.round(w) + " s" : (w / 60).toFixed(w < 600 ? 1 : 0) + " min"; }
  function kZoom(f, anchor) {
    const old = kw;
    kw *= f; kClamp();
    if (anchor != null) kc = anchor + (kc - anchor) * (kw / old);
    try { localStorage.setItem("hrm.morph.kwin", String(kw)); } catch (e) {}
    showTrain(false);
  }
  // wheel: zoom at the cursor; drag: scroll; click: pick the beat; double-click: 8 s
  function bindTrain() {
    const host = $("k-card");
    host.addEventListener("wheel", (e) => {
      if (!kU || !e.target.closest(".u-over")) return;
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
      const u = e.target.closest("#k-lane") ? kL : kU;
      kZoom(Math.exp(dy * 0.002), u.posToVal(e.clientX - u.over.getBoundingClientRect().left, "x"));
    }, { passive: false });
    let drag = null;
    host.addEventListener("mousedown", (e) => {
      if (!kU || e.button !== 0 || !e.target.closest(".u-over")) return;
      const u = e.target.closest("#k-lane") ? kL : kU;
      drag = { x: e.clientX, c: kc, u, moved: false };
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) > 3) drag.moved = true;
      if (drag.moved) { kc = drag.c - dx * kw / (drag.u.over.clientWidth || 1); showTrain(false); }
    });
    window.addEventListener("mouseup", (e) => {
      if (drag && !drag.moved && res) {
        const k = nearestBeat(drag.u.posToVal(e.clientX - drag.u.over.getBoundingClientRect().left, "x"));
        kb = Math.max(0, Math.min(res.beats.length - 1, k));
        showBeat(false); writeHash();
      }
      drag = null;
    });
    host.addEventListener("dblclick", (e) => { if (kU && e.target.closest(".u-over")) { kw = KWIN_DEFAULT; kZoom(1, null); } });
    $("k-out").addEventListener("click", () => kU && kZoom(1.5, null));
    $("k-in").addEventListener("click", () => kU && kZoom(1 / 1.5, null));
  }
  bindTrain();
  function beatLine(u) {                     // this beat's R
    const ctx = u.ctx, x = u.valToPos(res.beats[kb].r, "x", true);
    ctx.save(); ctx.strokeStyle = COL.fg; ctx.globalAlpha = 0.5; ctx.lineWidth = devicePixelRatio;
    ctx.setLineDash([4 * devicePixelRatio, 3 * devicePixelRatio]);
    ctx.beginPath(); ctx.moveTo(x, u.bbox.top); ctx.lineTo(x, u.bbox.top + u.bbox.height); ctx.stroke(); ctx.restore();
  }
  function interp(y, p) {
    const i = Math.max(0, Math.min(y.length - 2, Math.floor(p))), f = Math.max(0, Math.min(1, p - i));
    return y[i] + f * (y[i + 1] - y[i]);
  }
  function phaseLine(u) {
    if (ip == null) return;
    const ctx = u.ctx, x = u.valToPos(res.tms[ip], "x", true);
    ctx.save(); ctx.strokeStyle = COL.fg; ctx.globalAlpha = 0.6; ctx.lineWidth = devicePixelRatio;
    ctx.setLineDash([4 * devicePixelRatio, 3 * devicePixelRatio]);
    ctx.beginPath(); ctx.moveTo(x, u.bbox.top); ctx.lineTo(x, u.bbox.top + u.bbox.height); ctx.stroke(); ctx.restore();
  }

  function makeDelta() {
    const s = res.stats;
    dU = new uPlot({
      width: W("d-chart"), height: 200, legend: { show: false }, pxAlign: 0, padding: [8, 8, 0, 0],
      cursor: { sync, y: false, points: { show: false }, drag: { x: false, y: false } },
      scales: { x: { time: false }, y: { auto: true, range: (u, lo, hi) => { const m = Math.max(5, Math.abs(lo), Math.abs(hi)) * 1.1; return [-m, m]; } } },
      axes: [axis({ label: "ms from R", values: (u, v) => v.map((x) => x + " ms") }), axis({ label: "Δ ms", size: 50 })],
      bands: [{ series: [2, 1], fill: "rgba(230,237,243,0.10)" }],
      series: [{}, { stroke: "transparent", points: { show: false } }, { stroke: "transparent", points: { show: false } },
               { stroke: COL.fg, width: 1.2, points: { show: false } },
               { stroke: COL.hr, width: 1.6, points: { show: false } }],
      hooks: {
        draw: [phaseLine, (u) => {
          const ctx = u.ctx, y = u.valToPos(0, "y", true);
          ctx.save(); ctx.strokeStyle = COL.text; ctx.globalAlpha = 0.5; ctx.lineWidth = devicePixelRatio;
          ctx.beginPath(); ctx.moveTo(u.bbox.left, y); ctx.lineTo(u.bbox.left + u.bbox.width, y); ctx.stroke(); ctx.restore();
        }],
        setCursor: [(u) => deltaReadout(u.cursor.idx)],
      },
    }, [Array.from(res.tms), Array.from(s.q1), Array.from(s.q3), Array.from(s.med), Array.from(res.beats[kb].delta)], $("d-chart"));
    clickOn(dU, (x) => setPhase(Math.round(x * res.fs / 1000) + res.pre));
    clickOn(bU, (x) => setPhase(Math.round(x * res.fs / 1000) + res.pre));
  }
  function deltaReadout(i) {
    if (i == null) i = ip;
    if (i == null || !res) return;
    const s = res.stats, b = res.beats[kb];
    setText("d-readout", `${sg(res.tms[i], 0)} ms from R: this beat ${sg(b.delta[i])} ms · median ${sg(s.med[i])} (middle half ${sg(s.q1[i])} … ${sg(s.q3[i])})`);
  }
  function setPhase(i) {
    ip = Math.max(0, Math.min(res.n - 1, i));
    for (const u of [bU, dU, hU]) if (u) u.redraw(false, false);
    deltaReadout(); scatterData(); writeHash();
  }

  // heat map: beats (x, time) x cycle phase (y), colour = delta
  function heatColor(v, m) {
    const f = Math.max(-1, Math.min(1, v / m)), c = f >= 0 ? COL.late : COL.early, a = Math.abs(f);
    return [0, 1, 2].map((j) => Math.round(COL.mid[j] + (c[j] - COL.mid[j]) * a));
  }
  let heatImg = null;
  function buildHeat() {
    const n = res.n, B = res.beats.length, m = +$("h-scale").value;
    const cv = document.createElement("canvas");
    cv.width = B; cv.height = n;
    const ctx = cv.getContext("2d"), img = ctx.createImageData(B, n);
    res.beats.forEach((b, k) => {
      for (let i = 0; i < n; i++) {
        const [r, g, bl] = heatColor(b.delta[i], m), p = ((n - 1 - i) * B + k) * 4;
        const dim = !b.fits && ((i >> 2) & 1) ? 0.45 : 1;     // left out of the reference: striped
        img.data[p] = r * dim; img.data[p + 1] = g * dim; img.data[p + 2] = bl * dim; img.data[p + 3] = 255;
      }
    });
    ctx.putImageData(img, 0, 0);
    heatImg = cv;
    // legend
    $("h-legend").innerHTML = `<span style="color:rgb(${COL.early})">earlier −${m}</span> · 0 · <span style="color:rgb(${COL.late})">later +${m} ms</span>`;
  }
  function makeHeat() {
    buildHeat();
    const xs = res.beats.map((b) => b.r);
    const hsync = { key: "dtwtime" };
    hU = new uPlot({
      width: W("h-chart"), height: 260, legend: { show: false }, pxAlign: 0, padding: [8, 0, 0, 0],
      cursor: { sync: hsync, y: false, points: { show: false }, drag: { x: false, y: false } },
      scales: { x: { time: true, auto: false, range: () => [sel[0], sel[1]] }, y: { auto: false, range: () => [res.tms[0], res.tms[res.n - 1]] } },
      axes: [axis({ size: 4, values: () => [] }), axis({ label: "ms from R", size: 50 }),
             axis({ side: 1, label: "", size: 50, values: (u, v) => v.map(() => ""), grid: { show: false } })],   // = the lane's right axis
      series: [{}, { stroke: "transparent", points: { show: false } }],
      hooks: {
        drawClear: [(u) => {
          const ctx = u.ctx, { top, height } = u.bbox, B = res.beats.length;
          ctx.save(); ctx.imageSmoothingEnabled = false;
          const y0 = u.valToPos(res.tms[res.n - 1], "y", true), y1 = u.valToPos(res.tms[0], "y", true);
          for (let k = 0; k < B; k++) {
            const t = res.beats[k].r;
            const a = k ? (t + res.beats[k - 1].r) / 2 : t - res.beats[k].rr / 2000;
            const c = k + 1 < B ? (t + res.beats[k + 1].r) / 2 : t + res.beats[k].rr / 2000;
            const x0 = u.valToPos(Math.max(a, t - 1), "x", true), x1 = u.valToPos(Math.min(c, t + 1), "x", true);
            ctx.drawImage(heatImg, k, 0, 1, res.n, x0, y0, Math.max(1, x1 - x0 + 0.5), y1 - y0);
          }
          ctx.restore();
          void top; void height;
        }],
        draw: [(u) => {
          const ctx = u.ctx, dpr = devicePixelRatio;
          ctx.save(); ctx.lineWidth = dpr;
          if (ip != null) {                          // the chosen phase
            const y = u.valToPos(res.tms[ip], "y", true);
            ctx.strokeStyle = COL.fg; ctx.globalAlpha = 0.7; ctx.setLineDash([4 * dpr, 3 * dpr]);
            ctx.beginPath(); ctx.moveTo(u.bbox.left, y); ctx.lineTo(u.bbox.left + u.bbox.width, y); ctx.stroke();
          }
          const y0 = u.valToPos(0, "y", true);          // R
          ctx.globalAlpha = 0.35; ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(u.bbox.left, y0); ctx.lineTo(u.bbox.left + u.bbox.width, y0); ctx.stroke();
          const x = u.valToPos(res.beats[kb].r, "x", true);   // the shown beat
          ctx.globalAlpha = 1; ctx.strokeStyle = COL.fg; ctx.lineWidth = 2 * dpr;
          ctx.strokeRect(x - 3 * dpr, u.bbox.top, 6 * dpr, u.bbox.height);
          ctx.restore();
        }],
      },
    }, [xs, xs.map(() => null)], $("h-chart"));
    // RR and the DTW distance under it, same time axis
    const rr = res.beats.map((b) => (b.bad ? null : b.rr)), dist = res.beats.map((b) => b.dist);
    lU = new uPlot({
      width: W("h-lane"), height: 130, legend: { show: false }, pxAlign: 0, padding: [6, 0, 0, 0],
      cursor: { sync: hsync, y: false, points: { show: false }, drag: { x: false, y: false } },
      scales: { x: { time: true, auto: false, range: () => [sel[0], sel[1]] }, y: { auto: true }, d: { auto: true } },
      axes: [axis({ space: 90 }), axis({ label: "RR ms", size: 50 }),
             axis({ scale: "d", side: 1, label: "DTW dist", size: 50, grid: { show: false }, stroke: COL.dist })],
      series: [{}, { stroke: COL.ecg, width: 1.2, spanGaps: false, points: { show: false } },
               { stroke: COL.dist, width: 1, scale: "d", points: { show: false } }],
      hooks: { setCursor: [(u) => hoverBeat(u)] },
    }, [xs, rr, dist], $("h-lane"));
    const pick = (t, y, u) => {
      selectBeat(nearestBeat(t));
      if (u === hU) setPhase(Math.round(u.posToVal(y, "y") * res.fs / 1000) + res.pre);
    };
    clickOn(hU, pick); clickOn(lU, pick);
    hU.over.addEventListener("mousemove", () => hoverBeat(hU));
  }
  function hoverBeat(u) {
    const l = u.cursor.left;
    if (l == null || l < 0) { setText("d-readout", ""); deltaReadout(); return; }
    const k = nearestBeat(u.posToVal(l, "x")), b = res.beats[k];
    let txt = `${clock(b.r, 2)} · RR ${Math.round(b.rr)} ms · DTW dist ${b.dist.toFixed(3)}`;
    if (u === hU && u.cursor.top != null && u.cursor.top >= 0) {
      const ms = u.posToVal(u.cursor.top, "y"), i = Math.max(0, Math.min(res.n - 1, Math.round(ms * res.fs / 1000) + res.pre));
      txt += ` · ${sg(res.tms[i], 0)} ms from R: Δ ${sg(b.delta[i])} ms`;
    }
    setText("d-readout", txt);
  }
  function selectBeat(k) {
    kb = Math.max(0, Math.min(res.beats.length - 1, k));
    showBeat(); writeHash();
  }
  // recentre: move the kernel-train view to the beat (not when the beat was picked on it)
  function showBeat(recentre = true) {
    const b = res.beats[kb];
    bU.setData(beatData());
    dU.setData([Array.from(res.tms), Array.from(res.stats.q1), Array.from(res.stats.q3), Array.from(res.stats.med), Array.from(b.delta)]);
    hU.redraw(false, false);
    if (recentre) showTrain(true); else if (kU) { kU.redraw(false, false); kL.redraw(false, false); }
    const why = res.method === "kernel"
      ? (b.fits ? ` · kernels of ${b.cp.nN} + ${b.cn.nN} cycles` : " · a cycle next to it is not clean (corrected beat or a break): not in the kernels")
      : b.bad ? " · corrected beat (not in the reference)" : !b.fits ? " · neighbouring QRS in the window (not in the reference)" : "";
    setText("b-text", `${kb + 1} / ${res.beats.length} · ${clock(b.r, 2)} · RR ${Math.round(b.rr)} ms · DTW dist ${b.dist.toFixed(3)}${why}`);
    deltaReadout(); scatterData();
  }

  // delta at the chosen phase against the RR before the beat
  function makeScatter() {
    sU = new uPlot({
      width: W("s-chart"), height: 260, legend: { show: false }, pxAlign: 0, padding: [8, 8, 0, 0],
      cursor: { y: false, points: { show: false }, drag: { x: false, y: false } },
      scales: { x: { time: false }, y: { auto: true } },
      axes: [axis({ label: "RR before the beat, ms" }), axis({ label: "Δ ms", size: 50 })],
      series: [{}, { stroke: COL.ecg, width: 0, paths: () => null, points: { show: true, size: 4, fill: COL.ecg, stroke: COL.ecg } }],
      hooks: { draw: [drawFit] },
    }, [[], []], $("s-chart"));
    scatterData();
  }
  let sFit = null;
  function scatterData() {
    if (!sU || ip == null) return;
    const use = res.beats.filter((b) => b.fits).sort((a, b) => a.rr - b.rr);
    const x = use.map((b) => b.rr), y = use.map((b) => b.delta[ip]);
    sFit = BeatDTW.fit(x, y);
    sU.setData([x, y]);
    setText("s-readout", `${sg(res.tms[ip], 0)} ms from R · ${use.length} beats` + (sFit
      ? ` · r ${sFit.r.toFixed(2)} · slope ${sg(100 * sFit.slope)} ms per 100 ms RR` : ""));
  }
  function drawFit(u) {
    const ctx = u.ctx, dpr = devicePixelRatio, b = res.beats[kb];
    ctx.save();
    if (sFit && isFinite(sFit.slope)) {
      const x0 = u.scales.x.min, x1 = u.scales.x.max;
      ctx.strokeStyle = COL.fg; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([6 * dpr, 4 * dpr]);
      ctx.beginPath();
      ctx.moveTo(u.valToPos(x0, "x", true), u.valToPos(sFit.icept + sFit.slope * x0, "y", true));
      ctx.lineTo(u.valToPos(x1, "x", true), u.valToPos(sFit.icept + sFit.slope * x1, "y", true));
      ctx.stroke();
    }
    if (b.fits) {                                   // the shown beat
      ctx.setLineDash([]); ctx.strokeStyle = COL.hr; ctx.lineWidth = 2 * dpr;
      ctx.beginPath(); ctx.arc(u.valToPos(b.rr, "x", true), u.valToPos(b.delta[ip], "y", true), 6 * dpr, 0, 2 * Math.PI); ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- URL ----------
  function hashParams() {
    const h = new URLSearchParams(location.hash.slice(1));
    const n = (k) => (h.has(k) ? +h.get(k) : null);
    return { s: h.get("s"), a: n("a"), b: n("b"), k: n("k"), p: n("p") };
  }
  function writeHash() {
    if (!ses || !sel) return;
    let h = `#s=${ses.id}&a=${sel[0].toFixed(1)}&b=${sel[1].toFixed(1)}`;
    if (res && res.beats[kb]) h += `&k=${res.beats[kb].r.toFixed(2)}`;
    if (res && ip != null) h += `&p=${Math.round(res.tms[ip])}`;
    history.replaceState(null, "", h);
    $("nav-review").href = `/review#s=${ses.id}&a=${sel[0].toFixed(1)}&b=${sel[1].toFixed(1)}` +
      (res && res.beats[kb] ? `&e=${res.beats[kb].r.toFixed(1)}` : "");
  }

  // ---------- inputs ----------
  function methodUi() {
    const k = $("p-method").value === "kernel";
    for (const el of document.querySelectorAll(".only-kernel")) el.hidden = !k;
    for (const el of document.querySelectorAll(".only-ref")) el.hidden = k;
  }
  methodUi();
  $("p-method").addEventListener("change", methodUi);
  for (const id of ["p-method", "p-kn", "p-causal", "p-pre", "p-post", "p-band", "p-feat", "p-pen", "p-smooth", "p-ref"]) {
    $(id).addEventListener("change", () => { saveParams(); if (res) want = { k: res.beats[kb].r, p: res.tms[ip] }; schedule(false); });
  }
  $("p-notch").addEventListener("change", (e) => {
    try { localStorage.setItem("hrm.notch", e.target.value); } catch (err) {}
    if (res) want = { k: res.beats[kb].r, p: res.tms[ip] };
    schedule(false);
  });
  $("h-scale").addEventListener("change", () => { saveParams(); if (res) { buildHeat(); hU.redraw(false, false); } });
  $("b-offset").addEventListener("change", () => { saveParams(); if (res) showBeat(); });
  $("sel-len").addEventListener("change", () => { saveParams(); if (ses && sel) setPeriod(sel[0]); });
  $("sel-prev").addEventListener("click", () => sel && setPeriod(sel[0] - (sel[1] - sel[0])));
  $("sel-next").addEventListener("click", () => sel && setPeriod(sel[1]));
  $("b-prev").addEventListener("click", () => res && selectBeat(kb - 1));
  $("b-next").addEventListener("click", () => res && selectBeat(kb + 1));
  document.addEventListener("keydown", (e) => {
    if (!res || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowLeft") { selectBeat(kb - 1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { selectBeat(kb + 1); e.preventDefault(); }
  });
  $("ses-select").addEventListener("change", (e) => { want = null; loadSession(e.target.value, null); });
  let rz = 0;
  window.addEventListener("resize", () => {
    clearTimeout(rz);
    rz = setTimeout(() => { if (ov) ov.setSize({ width: W("ov-chart"), height: 120 }); if (res) drawAll(); }, 150);
  });

  loadList();
})();
