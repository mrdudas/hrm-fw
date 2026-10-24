/* Review page: browse a saved session, select a period, and follow how the
 * HRV and its fractal / multifractal measures change over it (analysis in
 * hrv.js; data from /api/sessions/<id>, see recordings.py). */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const css = getComputedStyle(document.documentElement);
  const C = (name) => css.getPropertyValue(name).trim();
  const COL = {
    text: C("--muted"), grid: C("--grid"), fg: C("--text"), hr: C("--hr"), ecg: C("--ecg"),
    x: C("--x"), y: C("--y"), z: C("--z"), pvc: C("--pvc"), pac: C("--pac"), art: C("--art"),
    warn: C("--warn"), panel: C("--panel"),
  };
  const FONT = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  const dpr = () => window.devicePixelRatio || 1;

  let ses = null;           // loaded session: {id, beats:{t, rr, gap}, ectopy, activity}
  let cl = null;            // HRV.clean() of it
  let roll = null, mf = null;
  let sel = null;           // [a, b] unix seconds
  const P = {};             // analysis parameters (from the inputs)

  // ---------- parameters ----------
  function readParams() {
    P.win = Math.max(30, +$("p-win").value || 120);
    P.mfwin = Math.max(120, +$("p-mfwin").value || 300);
    P.q = Math.min(10, Math.max(1, Math.round(+$("p-q").value || 5)));
    P.cj = $("p-cj").value;
    P.bad = Math.max(0, +$("p-bad").value);
  }
  const PARAM_IDS = ["p-win", "p-mfwin", "p-q", "p-cj", "p-bad"];
  try {
    const saved = JSON.parse(localStorage.getItem("hrm.review") || "{}");
    for (const id of PARAM_IDS) if (saved[id] != null) $(id).value = saved[id];
  } catch (e) {}
  function saveParams() {
    try { localStorage.setItem("hrm.review", JSON.stringify(Object.fromEntries(PARAM_IDS.map((id) => [id, $(id).value])))); } catch (e) {}
  }

  // ---------- formatting ----------
  const pad = (v) => String(v).padStart(2, "0");
  const fmtTime = (t, sec) => { const d = new Date(t * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}${sec ? ":" + pad(d.getSeconds()) : ""}`; };
  const fmtDate = (t) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  function fmtDur(s) {
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
    return h ? `${h} h ${pad(m)} min` : m ? `${m} min ${pad(r)} s` : `${r} s`;
  }
  const f = (v, d = 0, u = "") => v == null || !isFinite(v) ? "–" : v.toFixed(d) + u;
  function sesLabel(s) {
    return `${fmtDate(s.start)} ${fmtTime(s.start)} – ${fmtTime(s.end)} · ${fmtDur(s.end - s.start)} · ${s.beats} beats`;
  }

  // ---------- sessions ----------
  async function loadList() {
    const list = await (await fetch("/api/sessions")).json();
    const sel = $("ses-select");
    sel.innerHTML = "";
    for (const s of list) {
      const o = document.createElement("option");
      o.value = s.id; o.textContent = sesLabel(s);
      sel.appendChild(o);
    }
    if (!list.length) { setText("ses-info", "no recordings yet"); return; }
    const h = hashParams();
    sel.value = list.some((s) => s.id === h.s) ? h.s : list[0].id;
    await loadSession(sel.value, h.s === sel.value ? [h.a, h.b] : null);
  }

  async function loadSession(id, range) {
    setText("ses-info", "loading…");
    const r = await fetch("/api/sessions/" + id);
    if (!r.ok) { setText("ses-info", "could not load: " + r.status); return; }
    ses = await r.json();
    const b = ses.beats;
    cl = HRV.clean(b.rr, Uint8Array.from(b.gap, (g) => (g ? 1 : 0)));
    const nBad = cl.bad.reduce((s, v) => s + v, 0), nGap = b.gap.filter((g) => g).length;
    setText("ses-info", b.t.length
      ? `${b.t.length} beats · ${(100 * nBad / b.t.length).toFixed(1)} % corrected · ${nGap} break${nGap === 1 ? "" : "s"} (lost beats) · ${ses.ectopy.filter((e) => e[1] !== "ARTIFACT").length} PAC/PVC`
      : "no beats");
    if (!b.t.length) return;
    const t0 = b.t[0], t1 = b.t[b.t.length - 1];
    sel = range && range[0] >= t0 - 1 && range[1] <= t1 + 1 && range[1] > range[0] ? range : [t0, t1];
    drawOverview();
    await recompute();
  }

  // ---------- analysis ----------
  async function recompute() {
    if (!ses || !ses.beats.t.length) return;
    readParams();
    $("rv-busy").hidden = false;
    await new Promise((r) => setTimeout(r, 20));   // let "computing…" paint
    const t = ses.beats.t;
    const T = performance.now();
    roll = HRV.rolling(t, cl, { winS: P.win, stepS: Math.max(5, P.win / 24), win2S: P.mfwin, maxBad: P.bad });
    mf = HRV.rollingMF(t, cl, { winS: P.mfwin, stepS: Math.max(15, P.mfwin / 10), qMax: P.q, measure: P.cj, maxBad: P.bad });
    console.log(`[review] rolling analysis ${(performance.now() - T).toFixed(0)} ms`);
    $("rv-busy").hidden = true;
    ch = null;
    drawLanes();
    setRange(sel[0], sel[1]);
    rollChaos();
  }

  // noise titration + entropy plane in MF windows: slow, so in a worker,
  // the lanes fill in as it goes
  let ch = null;
  function rollChaos() {
    const b = ses.beats;
    setText("ch-progress", "chaos analysis… 0 %");
    Chaos.inWorker("roll", {
      kind: "rollChaos", t: Float64Array.from(b.t), rrc: cl.rrc, bad: cl.bad, gap: cl.gap,
      o: { winS: P.mfwin, stepS: Math.max(60, P.mfwin / 5), maxBad: P.bad },
    }, (r) => { ch = r; updateChaosLanes(); setText("ch-progress", ""); summaryChaosPts(); },
    (part, frac) => { ch = part; updateChaosLanes(); setText("ch-progress", `chaos analysis… ${Math.round(100 * frac)} %`); });
  }
  function updateChaosLanes() {
    if (!ch || !laneNL) return;
    laneNL.setData([ch.t, ch.nl], false); laneHC.setData([ch.t, ch.dC], false);
    if (sel) for (const u of [laneNL, laneHC]) u.setScale("x", { min: sel[0], max: sel[1] });
  }

  // ---------- overview ----------
  let ov = null;
  function drawOverview() {
    const b = ses.beats;
    const hr = b.rr.map((v, i) => (cl.bad[i] ? null : 60000 / v));
    // NaN-free x with a break at each gap: insert nulls
    if (ov) ov.destroy();
    ov = new uPlot({
      width: $("ov-chart").clientWidth, height: 150, legend: { show: false }, pxAlign: 0,
      padding: [8, 8, 0, 0],
      cursor: { y: false, points: { show: false }, drag: { x: true, y: false, setScale: false } },
      select: { show: true },
      scales: { x: { time: true }, y: { auto: true } },
      axes: [axis({ space: 90 }), axis({ label: "HR bpm", size: 50 })],
      series: [{}, { stroke: COL.hr, width: 1, spanGaps: false, points: { show: false } }],
      hooks: {
        setSelect: [(u) => {
          if (u.select.width < 4) return;
          const a = u.posToVal(u.select.left, "x"), c = u.posToVal(u.select.left + u.select.width, "x");
          u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
          setRange(a, c);
        }],
        drawClear: [(u) => {                       // the selected period
          if (!sel) return;
          const ctx = u.ctx, x0 = u.valToPos(sel[0], "x", true), x1 = u.valToPos(sel[1], "x", true);
          ctx.save(); ctx.fillStyle = "rgba(90,162,255,0.13)";
          ctx.fillRect(x0, u.bbox.top, Math.max(1, x1 - x0), u.bbox.height); ctx.restore();
        }],
      },
    }, [b.t, withBreaks(hr, b.gap)], $("ov-chart"));
    ov.over.addEventListener("dblclick", () => setRange(b.t[0], b.t[b.t.length - 1]));
  }
  // a null at every break so lines are not drawn across lost beats
  function withBreaks(y, gap) {
    return y.map((v, i) => (i + 1 < gap.length && gap[i + 1] ? null : v));
  }

  function axis(o) {
    return {
      stroke: COL.text, font: FONT, ticks: { show: false }, grid: { stroke: COL.grid, width: 1 },
      labelFont: FONT, labelSize: 14, ...o,
    };
  }

  // ---------- lanes over time ----------
  let lanes = [], laneNL = null, laneHC = null;
  const SYNC = uPlot.sync("rv");
  function lane(id, h, label, xs, series, opts = {}) {
    const bottom = !!opts.bottom;
    const u = new uPlot({
      width: $(id).clientWidth, height: h, legend: { show: false }, pxAlign: 0,
      padding: [6, 8, bottom ? 0 : 2, 0],
      cursor: { sync: { key: SYNC.key }, y: false, points: { show: false },
                drag: { x: true, y: false, setScale: false } },
      select: { show: true },
      scales: { x: { time: true, auto: false }, y: { auto: true, range: opts.range } },
      axes: [axis({ space: 90, size: bottom ? 30 : 4, values: bottom ? undefined : () => [] }),
             axis({ label, size: 50, space: 26 })],
      series: [{}, ...series],
      hooks: {
        setSelect: [(u) => {
          if (u.select.width < 4) return;
          const a = u.posToVal(u.select.left, "x"), c = u.posToVal(u.select.left + u.select.width, "x");
          u.setSelect({ left: 0, width: 0, top: 0, height: 0 }, false);
          setRange(a, c);
        }],
        setCursor: [(u) => readout(u)],
        draw: opts.draw ? [opts.draw] : [],
      },
    }, [xs, ...opts.data], $(id));
    lanes.push(u);
    return u;
  }

  function refLines(vals) {
    return (u) => {
      const ctx = u.ctx;
      ctx.save(); ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.font = FONT; ctx.fillStyle = COL.text;
      for (const [v, label] of vals) {
        const y = u.valToPos(v, "y", true);
        if (y < u.bbox.top || y > u.bbox.top + u.bbox.height) continue;
        ctx.strokeStyle = "rgba(139,150,165,0.55)";
        ctx.beginPath(); ctx.moveTo(u.bbox.left, y); ctx.lineTo(u.bbox.left + u.bbox.width, y); ctx.stroke();
        ctx.textAlign = "right";
        ctx.fillText(label, u.bbox.left + u.bbox.width - 4 * dpr(), y - 3 * dpr());
      }
      ctx.restore();
    };
  }

  function drawLanes() {
    for (const u of lanes) u.destroy();
    lanes = [];
    const b = ses.beats;
    const good = b.rr.map((v, i) => (cl.bad[i] ? null : v));
    const badv = b.rr.map((v, i) => (cl.bad[i] ? Math.min(2000, Math.max(250, v)) : null));
    const ecto = ses.ectopy.filter((e) => e[1] === "PVC" || e[1] === "PAC");
    const dot = (c, s) => ({ stroke: c, fill: c, paths: () => null, points: { show: true, size: s, stroke: c, fill: c, width: 0 } });
    lane("ln-rr", 150, "RR ms", b.t, [dot(COL.ecg, 2.5), dot(COL.pvc, 3)], {
      data: [good, badv],
      draw: (u) => {                                      // PAC / PVC marks along the top
        const ctx = u.ctx, x0 = u.scales.x.min, x1 = u.scales.x.max;
        ctx.save();
        for (const e of ecto) {
          if (e[0] < x0 || e[0] > x1) continue;
          const x = u.valToPos(e[0], "x", true), y = u.bbox.top + 2 * dpr();
          ctx.fillStyle = e[1] === "PVC" ? COL.pvc : COL.pac;
          ctx.beginPath(); ctx.moveTo(x, y + 7 * dpr()); ctx.lineTo(x - 4 * dpr(), y); ctx.lineTo(x + 4 * dpr(), y); ctx.fill();
        }
        ctx.restore();
      },
    });
    lane("ln-a", 150, "DFA α", roll.t, [
      { stroke: COL.ecg, width: 1.5, points: { show: false } },
      { stroke: COL.z, width: 1.5, points: { show: false } },
    ], { data: [roll.a1, roll.a2], range: (u, lo, hi) => [Math.min(0.2, lo ?? 0.2), Math.max(1.6, hi ?? 1.6)],
         draw: refLines([[1.5, "1.5 Brownian"], [1, "1.0 fractal (1/f)"], [0.75, "0.75 aerobic threshold"], [0.5, "0.5 random"]]) });
    lane("ln-mfw", 130, "Δα width", mf.t, [
      { stroke: COL.y, width: 1.5, points: { show: false } },
      { stroke: COL.x, width: 1.5, points: { show: false } },
    ], { data: [mf.mfW, mf.cjW], range: (u, lo, hi) => [0, Math.max(0.5, (hi ?? 0.5) * 1.1)] });
    lane("ln-mfa", 120, "α0 peak", mf.t, [
      { stroke: COL.y, width: 1.5, points: { show: false } },
      { stroke: COL.x, width: 1.5, points: { show: false } },
    ], { data: [mf.mfA0, mf.cjA0] });
    const cx = ch ? ch.t : [b.t[0], b.t[b.t.length - 1]], cn = (k) => (ch ? ch[k] : [null, null]);
    laneNL = lane("ln-nl", 120, "noise limit %", cx, [
      { stroke: COL.y, width: 1.5, points: { show: true, size: 3, fill: COL.y, stroke: COL.y } },
    ], { data: [cn("nl")], range: (u, lo, hi) => [0, Math.max(20, (hi ?? 20) * 1.1)],
         draw: (u) => { if (ch) return; u.ctx.save(); u.ctx.font = FONT; u.ctx.fillStyle = COL.text; u.ctx.textAlign = "left";
                        u.ctx.fillText("noise titration running…", u.bbox.left + 8 * dpr(), u.bbox.top + 16 * dpr()); u.ctx.restore(); } });
    laneHC = lane("ln-hc", 120, "C − noise", cx, [
      { stroke: COL.x, width: 1.5, points: { show: true, size: 3, fill: COL.x, stroke: COL.x } },
    ], { data: [cn("dC")], range: (u, lo, hi) => { const m = Math.max(0.02, Math.abs(lo ?? 0), Math.abs(hi ?? 0)) * 1.15; return [-m, m]; },
         draw: refLines([[0, "1/f^k noise curve"]]) });
    lane("ln-hrv", 130, "ms", roll.t, [
      { stroke: COL.ecg, width: 1.5, points: { show: false } },
      { stroke: COL.hr, width: 1.2, points: { show: false } },
    ], { data: [roll.rmssd, roll.sdnn], range: (u, lo, hi) => [0, Math.max(20, (hi ?? 20) * 1.05)] });
    const act = ses.activity;
    lane("ln-act", 110, "move g", act.t.length ? act.t : [b.t[0], b.t[b.t.length - 1]], [
      { stroke: COL.text, width: 1, fill: "rgba(139,150,165,0.18)", points: { show: false } },
    ], { data: [act.t.length ? act.v : [null, null]], bottom: true, range: (u, lo, hi) => [0, Math.max(0.05, hi ?? 0.05)],
         draw: act.t.length ? null : (u) => {
           u.ctx.save(); u.ctx.font = FONT; u.ctx.fillStyle = COL.text; u.ctx.textAlign = "left";
           u.ctx.fillText("no accelerometer data in this recording", u.bbox.left + 8 * dpr(), u.bbox.top + 16 * dpr());
           u.ctx.restore();
         } });
    legendRow();
  }

  function legendRow() {
    // static key under the readout: which colour is which
    const k = (c, s) => `<span class="rv-key"><i style="background:${c}"></i>${s}</span>`;
    $("rv-readout").dataset.key =
      k(COL.ecg, "RR / α1 / RMSSD") + k(COL.z, "α2") + k(COL.y, "MFDFA") + k(COL.x, "Chhabra–Jensen") +
      k(COL.hr, "SDNN") + k(COL.y, "noise limit") + k(COL.x, "complexity above noise") + k(COL.pvc, "corrected beat · PVC") + k(COL.pac, "PAC");
    $("rv-readout").innerHTML = $("rv-readout").dataset.key;
  }

  function nearest(xs, v) {
    let lo = 0, hi = xs.length - 1;
    if (hi < 0) return -1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < v) lo = m + 1; else hi = m; }
    if (lo > 0 && Math.abs(xs[lo - 1] - v) < Math.abs(xs[lo] - v)) lo--;
    return lo;
  }

  function readout(u) {
    const idx = u.cursor.idx;
    if (idx == null || u.cursor.left < 0) { $("rv-readout").innerHTML = $("rv-readout").dataset.key || "&nbsp;"; drawHist(null); return; }
    const tv = u.posToVal(u.cursor.left, "x");
    const b = ses.beats, i = nearest(b.t, tv), r = nearest(roll.t, tv), m = nearest(mf.t, tv);
    const parts = [
      `<b>${fmtTime(tv, true)}</b>`,
      `RR ${f(b.rr[i])} ms${cl.bad[i] ? " (corrected)" : ""}`,
      `α1 ${f(roll.a1[r], 2)}`, `α2 ${f(roll.a2[r], 2)}`,
      `Δα MFDFA ${f(mf.mfW[m], 2)} · CJ ${f(mf.cjW[m], 2)}`,
      `α0 ${f(mf.mfA0[m], 2)} · ${f(mf.cjA0[m], 2)}`,
      ...(ch && ch.t.length ? (() => { const c = nearest(ch.t, tv); return [`noise limit ${f(ch.nl[c], 0, " %")}`, `H ${f(ch.H[c], 3)} · C ${f(ch.C[c], 3)} (${f(ch.dC[c], 3)} vs noise)`]; })() : []),
      `RMSSD ${f(roll.rmssd[r], 1)} · SDNN ${f(roll.sdnn[r], 1)} ms`,
      `HR ${f(roll.hr[r])}`,
      `corrected ${f(roll.badPct[r], 1)} %`,
    ];
    $("rv-readout").innerHTML = parts.join(" · ");
    drawHist(b.rr[i]);
  }

  // ---------- selection ----------
  let sumTimer = 0;
  function setRange(a, b) {
    if (!ses) return;
    const t = ses.beats.t, t0 = t[0], t1 = t[t.length - 1];
    if (b - a < 30) { const c = (a + b) / 2; a = c - 15; b = c + 15; }
    a = Math.max(t0, a); b = Math.min(t1, b);
    sel = [a, b];
    for (const u of lanes) u.setScale("x", { min: a, max: b });
    if (ov) ov.redraw(false);
    setText("sel-text", `${fmtTime(a, true)} – ${fmtTime(b, true)} · ${fmtDur(b - a)}`);
    history.replaceState(null, "", `#s=${ses.id}&a=${a.toFixed(1)}&b=${b.toFixed(1)}`);
    clearTimeout(sumTimer);
    sumTimer = setTimeout(summary, 120);
  }
  function shift(dir) {
    if (!sel) return;
    const w = sel[1] - sel[0], t = ses.beats.t;
    let a = sel[0] + dir * w;
    a = Math.max(t[0], Math.min(t[t.length - 1] - w, a));
    setRange(a, a + w);
  }
  function hashParams() {
    const h = new URLSearchParams(location.hash.slice(1));
    return { s: h.get("s"), a: +h.get("a"), b: +h.get("b") };
  }

  // ---------- exercise / fatigue of the selected period (exercise.js) ----------
  const ath = Exercise.athlete();
  $("ex-hrmax").value = ath.hrMax; $("ex-hrrest").value = ath.hrRest; $("ex-sex").value = ath.sex;
  for (const id of ["ex-hrmax", "ex-hrrest", "ex-sex"]) $(id).addEventListener("change", () => {
    ath.hrMax = +$("ex-hrmax").value || 190; ath.hrRest = +$("ex-hrrest").value || 60; ath.sex = $("ex-sex").value;
    Exercise.saveAthlete(ath);
    exercise();
  });
  let exR = null;
  function exercise() {
    if (!ses || !sel) return;
    const R = exR = Exercise.analyze(ses.beats.t, cl, ses.activity, sel[0], sel[1], { athlete: ath, maxBad: P.bad });
    const v = Exercise.verdict(R), d = R.dur, L = R.load;
    $("ex-verdict").innerHTML = `<b class="${v.cls}">${v.head}</b>${v.text ? " · " + v.text : ""}`;
    const item = (k, val, tip) => `<div class="rv-stat" title="${tip || ""}"><span>${k}</span><b>${val}</b></div>`;
    const sg = (x, dd = 0) => (x == null || !isFinite(x) ? "–" : (x > 0 ? "+" : "") + x.toFixed(dd));
    const hp = R.hrr.pts;
    $("ex-stats").innerHTML = [
      item("HRVT1 / HRVT2", Exercise.thrText(d.all), "HR where α1 = 0.75 (~ aerobic threshold) and 0.5 (~ anaerobic), from the α1–HR fit of the whole exercise. In brackets: extrapolated beyond the measured HRs"),
      item("first third", Exercise.thrText(d.first), "thresholds from the first third of the exercise"),
      item("last third", Exercise.thrText(d.last), "thresholds from the last third"),
      item("threshold drift", d.vt1Drift == null ? "–" : sg(d.vt1Drift) + " bpm", "HRVT1 last third − first third; only when both thirds cross α1 = 0.75. A fall of 5 bpm or more: fatigue (lost durability)"),
      item("α1 at same HR", d.matched ? `${d.matched.first.toFixed(2)} → ${d.matched.last.toFixed(2)}` : "–", d.matched ? `mean α1 at ${d.matched.lo.toFixed(0)}–${d.matched.hi.toFixed(0)} bpm, first → last third; a drop of 0.1 or more: fatigue` : "the two thirds share no HR range"),
      item("α1 at same cadence", d.matchedLoad ? `${d.matchedLoad.first.toFixed(2)} → ${d.matchedLoad.last.toFixed(2)}` : "–", d.matchedLoad ? `mean α1 at ${d.matchedLoad.spm.toFixed(0)} ± 8 % steps/min, first → last third (HR ${d.matchedLoad.hr1.toFixed(0)} → ${d.matchedLoad.hr2.toFixed(0)})` : "needs ≥ 15 min at a steady cadence (step counter)"),
      item("decoupling", R.dec.decoupling != null ? R.dec.decoupling.toFixed(1) + " %" : "–", R.dec.decoupling != null ? `cadence/HR, second half against the first, at the typical cadence: HR ${R.dec.hr1.toFixed(0)} → ${R.dec.hr2.toFixed(0)}, cadence ${R.dec.spm1.toFixed(0)} → ${R.dec.spm2.toFixed(0)}. Under 5 %: good durability` : R.dec.hasSteps ? "needs ≥ 5 min at a steady cadence" : "no step data"),
      item("HR drift", R.dec.hrDrift != null ? sg(R.dec.hrDrift) + " bpm" : "–", "mean HR, second half − first half (of the steady-cadence part when there is step data)"),
      item("HRR60", hp.length ? hp.map((p) => p.hrr60.toFixed(0)).join(" · ") : "–", "heart rate recovery: HR drop in the 60 s after each bout (" + (hp.length && hp[0].confirmed ? "bouts from the step counter" : "bouts from HR peaks") + "). Getting smaller through a session: fatigue. Under 12 bpm at rest after exercise is low"),
      item("TRIMP", `${L.banister.toFixed(0)} <small>Banister</small> · ${L.edwards.toFixed(0)} <small>Edwards</small>`, "training load. Banister: minutes × HR-reserve fraction, exponentially weighted; Edwards: minutes in the 5 zones of % HRmax × 1…5"),
      item("zones (min)", L.zone.map((z) => z.toFixed(0)).join(" · "), "minutes at 50–60 · 60–70 · 70–80 · 80–90 · 90–100 % of HR max"),
    ].join("");
    drawExercise();
  }
  function drawExercise() {
    if (!exR) return;
    Exercise.renderA1($("ex-a1"), exR);
    Exercise.renderTime($("ex-time"), exR);
  }

  // ---------- summary of the selected period ----------
  function summary() {
    const t = ses.beats.t;
    const a = nearest(t, sel[0]), b = Math.min(t.length, nearest(t, sel[1]) + 1);
    const st = HRV.stats(t, cl, a, b);
    if (!st) { $("sum-stats").innerHTML = ""; return; }
    const qs = HRV.qRange(P.q, 0.5);
    const m = b - a >= 200 ? HRV.mfdfa(cl.rrc, a, b, qs, HRV.scalesFor(b - a).filter((n) => n >= 10), cl.bad) : null;
    const j = b - a >= 200 ? HRV.chhabraJensen(cl.rrc, a, b, qs, P.cj) : null;
    const item = (k, v, tip) => `<div class="rv-stat" title="${tip || ""}"><span>${k}</span><b>${v}</b></div>`;
    $("sum-stats").innerHTML = [
      item("beats", st.beats, "in the selected period"),
      item("duration", fmtDur(st.dur)),
      item("corrected", f(st.badPct, 1, " %"), "artifact / ectopic beats replaced by the local median before the analysis"),
      item("lost beats", st.missing, "beats missing in breaks of the recording (lost notifications, dropped link)"),
      item("HR", f(st.hr, 0, " bpm")),
      item("mean RR", f(st.meanRR, 0, " ms")),
      item("SDNN", f(st.sdnn, 1, " ms"), "standard deviation of RR: overall variability"),
      item("RMSSD", f(st.rmssd, 1, " ms"), "root mean square of successive differences: beat-to-beat (vagal) variability"),
      item("pNN50", f(st.pnn50, 1, " %"), "successive RR differences > 50 ms"),
      item("lnRMSSD", st.rmssd ? f(Math.log(st.rmssd), 2) : "–", "natural log of RMSSD: the usual scale for tracking day to day (see the daily summary)"),
      item("DC", f(st.dc, 1, " ms"), "deceleration capacity (Bauer 2006, phase-rectified signal averaging): how strongly the heart slows beat to beat, vagal. In 24 h post-infarction recordings > 4.5 ms low risk, < 2.5 ms high risk"),
      item("SD1 / SD2", `${f(st.sd1, 1)} / ${f(st.sd2, 1)}`, "Poincaré: short-term / long-term variability"),
      item("DFA α1", f(st.alpha1, 2), "4–16 beats. ~1 rest (fractal), 0.75 aerobic threshold, 0.5 random, < 0.5 anti-correlated"),
      item("DFA α2", f(st.alpha2, 2), "16–64 beats. ~1 healthy, → 1.5 more regular, lower more random"),
      item("MFDFA Δα", m ? f(m.width, 2) : "–", "width of the MFDFA singularity spectrum: degree of multifractality"),
      item("MFDFA α0", m ? f(m.alpha0, 2) : "–", "where the MFDFA spectrum peaks"),
      item("CJ Δα", j ? f(j.width, 2) : "–", "width of the Chhabra–Jensen spectrum (" + (P.cj === "drr" ? "measure |ΔRR|" : "measure RR") + ")"),
      item("CJ α0", j ? f(j.alpha0, 2) : "–", "where the Chhabra–Jensen spectrum peaks"),
      `<div class="rv-stat" id="st-nl" title="Noise titration (Poon & Barahona): white noise (% of the RR SD) needed to hide the nonlinear determinism; 0 = no chaos detected">` +
        `<span>noise limit</span><b>…</b></div>`,
      `<div class="rv-stat" id="st-ce" title="Complexity–entropy plane: H (entropy of the 4-beat order patterns) and C (complexity); Δ = C above the correlated-noise curve">` +
        `<span>H · C (Δ vs noise)</span><b>…</b></div>`,
    ].join("");
    selChaos(a, b);
    exercise();
    let gaps = 0;
    for (let i = a + 1; i < b; i++) if (ses.beats.gap[i]) gaps++;
    setText("sum-note", gaps ? `⚠ the period spans ${gaps} break${gaps > 1 ? "s" : ""}: the parts are analysed joined together` : "");
    histSel = { a, b };
    drawHist(null);
    nonlin(a, b);
    plotDFA(a, b, m);
    plotSpectrum(m, j);
    plotHq(m);
    plotPoincare(a, b);
  }

  // ---------- RR distribution of the selected period (rrhist.js) ----------
  let histSel = null, hist = null;
  function drawHist(markRR) {
    if (!histSel) return;
    const key = `${ses.id}|${histSel.a}|${histSel.b}|${$("rh-normal").checked}`;
    if (!hist || hist.key !== key) {
      const counts = new Int32Array(RRHist.RR_MAX + 1), rr = ses.beats.rr, normal = $("rh-normal").checked;
      let n = 0, s = 0, s2 = 0;
      for (let i = histSel.a; i < histSel.b; i++) {
        const v = Math.round(rr[i]);
        if (v < RRHist.RR_MIN || v > RRHist.RR_MAX || (normal && cl.bad[i])) continue;
        counts[v]++; n++; s += v; s2 += v * v;
      }
      const t = ses.beats.t;
      hist = { key, counts, n, sum: s, sum2: s2, spanS: t[histSel.b - 1] - t[histSel.a] };
    }
    const m = markRR == null ? null : Math.round(markRR);
    RRHist.render($("rh-canvas"), $("rh-stats"), { ...hist, last: m != null && m >= RRHist.RR_MIN && m <= RRHist.RR_MAX ? m : null });
  }

  // ---------- chaos or noise in the selected period (chaos.js, in a worker) ----------
  let chSel = null, chSelRange = null;
  function selChaos(a, b) {
    let i0 = a, i1 = b;
    if (b - a > NL_MAX) { i0 = a + Math.floor((b - a - NL_MAX) / 2); i1 = i0 + NL_MAX; }
    chSel = null; chSelRange = [a, b];
    summaryChaosPts();
    Chaos.inWorker("sel", { kind: "chaos", rr: cl.rrc.slice(i0, i1) }, (r) => {
      chSel = r;
      const set = (id, html, cls) => { const e = $(id); if (e) { const bb = e.querySelector("b"); bb.innerHTML = html; bb.className = cls || ""; } };
      if (!r || !r.ti) { set("st-nl", "–"); set("st-ce", "–"); summaryChaosPts(); return; }
      const ti = r.ti, pl = r.pl;
      set("st-nl", ti.periodic ? "periodic" : `${ti.nl.toFixed(0)} %`, ti.periodic ? "" : "nl-" + (ti.detected ? "chaos" : "noise"));
      set("st-ce", pl ? `${pl.H.toFixed(2)} · ${pl.C.toFixed(3)} <small>(${pl.dC >= 0 ? "+" : ""}${pl.dC.toFixed(3)})</small>` : "–");
      const st = $("st-nl"); if (st) st.title = r.verdict.text + (i1 - i0 < b - a ? ` (the middle ${i1 - i0} of ${b - a} beats)` : "");
      summaryChaosPts();
    });
  }
  // the plane: the rolling windows inside the selection + the whole selection
  function summaryChaosPts() {
    const cv = $("pl-ce");
    if (!cv || !sel) return;
    const pts = [];
    if (ch) {
      const inSel = ch.t.map((tt, i) => i).filter((i) => ch.t[i] >= sel[0] && ch.t[i] <= sel[1] && ch.H[i] != null);
      inSel.forEach((i, k) => pts.push({ H: ch.H[i], C: ch.C[i], w: (k + 1) / inSel.length }));
    }
    Chaos.renderPlane(cv, pts, chSel && chSel.pl);
  }

  // ---------- determinism of the selected period (nonlin.js, in a worker) ----------
  const NL_MAX = 2000;
  let nlRes = null;
  function nonlin(a, b) {
    let i0 = a, i1 = b;
    if (b - a > NL_MAX) { i0 = a + Math.floor((b - a - NL_MAX) / 2); i1 = i0 + NL_MAX; }
    if (i1 - i0 < NonLin.N_MIN) { nlRes = null; NonLin.render($("nl-canvas"), $("nl-stats"), null); return; }
    setText("nl-stats", "computing…");
    const note = i1 - i0 < b - a ? `the middle ${i1 - i0} of ${b - a} beats` : "";
    NonLin.analyzeAsync(cl.rrc.slice(i0, i1), NL_MAX, (r) => { nlRes = r; NonLin.render($("nl-canvas"), $("nl-stats"), r, note); });
  }

  // ---------- small x-y charts on a plain canvas ----------
  function xy(canvas, o) {
    const W = canvas.clientWidth, H = canvas.clientHeight, k = dpr();
    canvas.width = W * k; canvas.height = H * k;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const L = 46, R = 10, T = 8, B = 30, w = W - L - R, h = H - T - B;
    const tx = o.logx ? Math.log10 : (v) => v, ty = o.logy ? Math.log10 : (v) => v;
    let [x0, x1] = o.xr, [y0, y1] = o.yr;
    x0 = tx(x0); x1 = tx(x1); y0 = ty(y0); y1 = ty(y1);
    const X = (v) => L + (tx(v) - x0) / (x1 - x0) * w, Y = (v) => T + h - (ty(v) - y0) / (y1 - y0) * h;
    ctx.font = FONT; ctx.fillStyle = COL.text; ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
    const ticks = (lo, hi, log) => {
      if (log) { const out = []; for (let e = Math.floor(lo); e <= Math.ceil(hi); e++) for (const m of [1, 2, 5]) { const v = Math.log10(m) + e; if (v >= lo - 1e-9 && v <= hi + 1e-9) out.push(v); } return out; }
      const step = niceStep((hi - lo) / 5), out = [];
      for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
      return out;
    };
    const lbl = (v, log) => { const x = log ? 10 ** v : v; return Math.abs(x) >= 100 || Number.isInteger(+x.toFixed(6)) ? String(Math.round(x)) : x.toFixed(Math.abs(x) < 1 ? 2 : 1); };
    for (const v of ticks(x0, x1, o.logx)) {
      const px = L + (v - x0) / (x1 - x0) * w;
      ctx.beginPath(); ctx.moveTo(px, T); ctx.lineTo(px, T + h); ctx.stroke();
      ctx.textAlign = "center"; ctx.fillText(lbl(v, o.logx), px, T + h + 13);
    }
    for (const v of ticks(y0, y1, o.logy)) {
      const py = T + h - (v - y0) / (y1 - y0) * h;
      ctx.beginPath(); ctx.moveTo(L, py); ctx.lineTo(L + w, py); ctx.stroke();
      ctx.textAlign = "right"; ctx.fillText(lbl(v, o.logy), L - 5, py + 4);
    }
    ctx.textAlign = "center"; ctx.fillText(o.xl, L + w / 2, H - 3);
    ctx.save(); ctx.translate(11, T + h / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(o.yl, 0, 0); ctx.restore();
    ctx.save(); ctx.beginPath(); ctx.rect(L, T, w, h); ctx.clip();
    for (const s of o.series) {
      ctx.strokeStyle = ctx.fillStyle = s.color; ctx.lineWidth = s.width || 1.5;
      ctx.globalAlpha = s.alpha || 1;
      if (s.dash) ctx.setLineDash(s.dash); else ctx.setLineDash([]);
      if (s.line !== false) {
        ctx.beginPath(); let pen = false;
        for (let i = 0; i < s.x.length; i++) {
          if (s.x[i] == null || s.y[i] == null || !isFinite(s.y[i])) { pen = false; continue; }
          const px = X(s.x[i]), py = Y(s.y[i]);
          if (pen) ctx.lineTo(px, py); else { ctx.moveTo(px, py); pen = true; }
        }
        ctx.stroke();
      }
      if (s.points) {
        const r = s.points;
        for (let i = 0; i < s.x.length; i++) {
          if (s.x[i] == null || s.y[i] == null) continue;
          ctx.fillRect(X(s.x[i]) - r / 2, Y(s.y[i]) - r / 2, r, r);
        }
      }
    }
    ctx.restore();
    if (o.labels) {
      ctx.textAlign = "left";
      o.labels.forEach((l, i) => { ctx.fillStyle = l.color; ctx.fillText(l.text, L + 8, T + 14 + 14 * i); });
    }
    ctx.globalAlpha = 1;
  }
  function niceStep(r) {
    const e = 10 ** Math.floor(Math.log10(r)), m = r / e;
    return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * e;
  }
  const ext = (arrs) => {
    let lo = Infinity, hi = -Infinity;
    for (const a of arrs) for (const v of a) if (v != null && isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return isFinite(lo) ? [lo, hi] : [0, 1];
  };
  const padR = ([lo, hi], p = 0.06) => { const d = (hi - lo) || Math.abs(hi) || 1; return [lo - p * d, hi + p * d]; };

  function plotDFA(a, b, m) {
    const cv = $("pl-dfa");
    if (!m) { xy(cv, { xr: [4, 64], yr: [1, 10], logx: true, logy: true, xl: "n beats", yl: "F(n)", series: [], labels: [{ text: "too few beats", color: COL.text }] }); return; }
    const sc = m.scales, show = [-P.q, -2, 2, P.q].filter((q, i, arr) => arr.indexOf(q) === i);
    const ser = [], qi = (q) => m.qs.findIndex((v) => Math.abs(v - q) < 1e-9);
    const cols = { neg: COL.x, pos: COL.y };
    for (const q of show) {
      const k = qi(q); if (k < 0) continue;
      ser.push({ x: sc, y: m.Fq[k], color: q === 2 ? COL.ecg : q < 0 ? cols.neg : cols.pos, width: q === 2 ? 2 : 1, alpha: q === 2 ? 1 : 0.75, points: q === 2 ? 3 : 0 });
    }
    // alpha1 / alpha2 fits on q = 2
    const k2 = qi(2), F2 = m.Fq[k2];
    const fit = (lo, hi, col, name) => {
      const xs = [], ys = [];
      sc.forEach((n, i) => { if (n >= lo && n <= hi && F2[i] > 0) { xs.push(Math.log10(n)); ys.push(Math.log10(F2[i])); } });
      if (xs.length < 3) return null;
      const N = xs.length, mx = xs.reduce((s, v) => s + v, 0) / N, my = ys.reduce((s, v) => s + v, 0) / N;
      let sxy = 0, sxx = 0; for (let i = 0; i < N; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
      const sl = sxy / sxx, ic = my - sl * mx;
      ser.push({ x: [lo, hi], y: [10 ** (ic + sl * Math.log10(lo)), 10 ** (ic + sl * Math.log10(hi))], color: col, width: 1.5, dash: [5, 4] });
      return `${name} = ${sl.toFixed(2)}`;
    };
    const l1 = fit(Math.max(4, sc[0]), 16, COL.fg, "α1"), l2 = fit(16, 64, COL.z, "α2");
    const all = ext(m.Fq);
    xy(cv, {
      xr: [sc[0], sc[sc.length - 1]], yr: [all[0] / 1.2, all[1] * 1.2], logx: true, logy: true, xl: "box size n (beats)", yl: "Fq(n)",
      series: ser,
      labels: [{ text: `q = 2 (DFA)${l1 ? " · " + l1 : ""}${l2 ? " · " + l2 : ""}`, color: COL.ecg },
               { text: `q = ${show.filter((q) => q > 0 && q !== 2).join(", ")}`, color: COL.y },
               { text: `q = ${show.filter((q) => q < 0).join(", ")}`, color: COL.x }],
    });
  }

  function plotSpectrum(m, j) {
    const ser = [], labels = [];
    if (m) { ser.push({ x: m.alpha, y: m.f, color: COL.y, points: 3 }); labels.push({ text: `MFDFA Δα ${f(m.width, 2)} · α0 ${f(m.alpha0, 2)}`, color: COL.y }); }
    if (j) { ser.push({ x: j.alpha, y: j.f, color: COL.x, points: 3 }); labels.push({ text: `Chhabra–Jensen Δα ${f(j.width, 2)} · α0 ${f(j.alpha0, 2)}`, color: COL.x }); }
    if (!ser.length) labels.push({ text: "too few beats", color: COL.text });
    const xr = padR(ext(ser.map((s) => s.x)), 0.1), yr = padR(ext(ser.map((s) => s.y)), 0.1);
    xy($("pl-spec"), { xr, yr: [Math.min(yr[0], 0), Math.max(1.1, yr[1])], xl: "α (singularity strength)", yl: "f(α)", series: ser, labels });
  }

  function plotHq(m) {
    if (!m) { xy($("pl-hq"), { xr: [-P.q, P.q], yr: [0, 2], xl: "q", yl: "h(q)", series: [], labels: [{ text: "too few beats", color: COL.text }] }); return; }
    const yr = padR(ext([m.h]), 0.15);
    xy($("pl-hq"), {
      xr: [-P.q, P.q], yr: [Math.min(yr[0], 0.4), Math.max(yr[1], 1.2)], xl: "q (moment order)", yl: "h(q)",
      series: [{ x: m.qs, y: m.h, color: COL.y, points: 3 }],
      labels: [{ text: `Δh = h(${-P.q}) − h(${P.q}) = ${f(m.h[0] - m.h[m.h.length - 1], 2)} · h(2) = ${f(m.h[m.qs.indexOf(2)], 2)}`, color: COL.y }],
    });
  }

  function plotPoincare(a, b) {
    const x = [], y = [], xb = [], yb = [];
    const { rrc, bad, gap } = cl;
    const step = Math.max(1, Math.ceil((b - a) / 20000));       // keep huge selections fast
    for (let i = a; i + 1 < b; i += step) {
      if (gap[i + 1]) continue;
      if (bad[i] || bad[i + 1]) { xb.push(ses.beats.rr[i]); yb.push(ses.beats.rr[i + 1]); }
      else { x.push(rrc[i]); y.push(rrc[i + 1]); }
    }
    const r = padR(ext([x, y]), 0.08);
    xy($("pl-poin"), {
      xr: r, yr: r, xl: "RRn (ms)", yl: "RRn+1 (ms)",
      series: [{ x: r, y: r, color: COL.text, width: 1, dash: [4, 4] },
               { x, y, color: COL.ecg, line: false, points: 2, alpha: 0.5 },
               { x: xb, y: yb, color: COL.pvc, line: false, points: 2, alpha: 0.6 }],
    });
  }

  // ---------- misc ----------
  function setText(id, s) { const e = $(id); if (e) e.textContent = s; }

  let rzTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(rzTimer);
    rzTimer = setTimeout(() => {
      if (ov) ov.setSize({ width: $("ov-chart").clientWidth, height: 150 });
      for (const u of lanes) u.setSize({ width: u.root.parentElement.clientWidth, height: u.height });
      if (sel) summary();
    }, 150);
  });

  $("ses-select").addEventListener("change", (e) => loadSession(e.target.value, null));
  $("ses-reload").addEventListener("click", () => ses && loadSession(ses.id, sel));
  $("sel-prev").addEventListener("click", () => shift(-1));
  $("sel-next").addEventListener("click", () => shift(1));
  $("sel-all").addEventListener("click", () => ses && setRange(ses.beats.t[0], ses.beats.t[ses.beats.t.length - 1]));
  $("rh-normal").addEventListener("change", () => drawHist(null));
  for (const id of PARAM_IDS) $(id).addEventListener("change", () => { saveParams(); recompute(); });
  loadList();
})();
