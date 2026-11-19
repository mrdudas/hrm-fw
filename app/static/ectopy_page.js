/* /ectopy#s=<session>[&a=&b=]: the raw-ECG ectopy analysis (ectopy.js, in a Web Worker) of a saved
 * recording: summary, R-R tachogram with the episodes, burden against the strap firmware's labels,
 * episode / bout / hourly tables, per-beat CSV. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const C = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const COL = { text: C("--muted"), grid: C("--grid"), fg: C("--text"), ecg: C("--ecg"), hr: C("--hr"), y: C("--y"), x: C("--x"), z: C("--z") };
  const LAB = {                                     // label -> colour, legend name
    N: ["#4bd1a0", "normal"], BIGEMINY_PAC: ["#ffb454", "bigeminy PAC"], TRIGEMINY_PAC: ["#ffd479", "trigeminy PAC"],
    PAC: ["#f2cc60", "PAC"], PVC: ["#ff5470", "PVC"], BIGEMINY_PVC: ["#ff7b93", "bigeminy PVC"], TRIGEMINY_PVC: ["#ff9fb0", "trigeminy PVC"],
    BIGEMINY_BLOCK: ["#c792ea", "grouped (block?)"], TRIGEMINY_BLOCK: ["#c792ea", "grouped (block?)"],
    PAUSE: ["#5aa2ff", "pause"], ARTIFACT: ["#6b7480", "artifact"], GAP: ["#6b7480", "gap"],
  };
  const FONT = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  const pad = (n) => String(n).padStart(2, "0");
  const clock = (t) => { const d = new Date(t * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  const dur = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${pad(Math.round(s % 60))} min` : `${Math.round(s)} s`);
  const r0 = (v) => (v == null || v !== v ? "–" : Math.round(v));
  const item = (k, v, tip) => `<div class="rv-stat" title="${tip || ""}"><span>${k}</span><b>${v}</b></div>`;
  let sesId = null, ses = null, res = null, tach = null, burd = null, worker = null;

  const axis = (o = {}) => ({ stroke: COL.text, font: FONT, ticks: { show: false }, grid: { stroke: COL.grid, width: 1 }, ...o });
  const reviewUrl = (a, b) => `/review#s=${sesId}&a=${Math.floor(a)}&b=${Math.ceil(b)}`;

  async function sessions() {
    const list = await (await fetch("/api/sessions")).json();
    $("e-ses").innerHTML = list.map((s) => `<option value="${s.id}">${s.id.replace(/^(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d).*/, "$1-$2-$3 $4:$5")}${s.beats ? ` · ${s.beats} beats` : ""}</option>`).join("");
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("s")) $("e-ses").value = h.get("s");
  }

  async function run() {
    const h = new URLSearchParams(location.hash.slice(1));
    sesId = $("e-ses").value;
    if (h.get("s") !== sesId) { history.replaceState(null, "", `#s=${sesId}`); }
    const hh = new URLSearchParams(location.hash.slice(1));
    let a = +hh.get("a"), b = +hh.get("b");
    $("e-info").textContent = "loading the recording…";
    ses = await (await fetch(`/api/sessions/${sesId}`)).json();
    const t = ses.beats.t;
    if (!t.length) { $("e-info").textContent = "no beats in this recording"; return; }
    if (!(b > a)) { a = t[0]; b = t[t.length - 1]; }
    $("e-review").href = reviewUrl(a, b);
    let ecg;
    try {
      ecg = await Alternans.fetchEcg(sesId, a, b, (f) => { $("e-info").textContent = `loading the raw ECG… ${Math.round(100 * f)} %`; });
    } catch (e) { $("e-info").textContent = "no raw ECG: " + e.message; return; }
    if (!ecg.segs.length) { $("e-info").textContent = "no raw ECG in this range"; return; }
    $("e-info").textContent = "analysing…";
    if (worker) worker.terminate();
    worker = new Worker("/static/ectopy_worker.js");
    const t0 = performance.now();
    res = await new Promise((ok, fail) => {
      worker.onmessage = (ev) => {
        const m = ev.data;
        if (m.progress != null) $("e-info").textContent = `analysing… ${m.what} ${Math.round(100 * m.progress)} %`;
        else if (m.result) ok(m.result);
        else if (m.error) fail(new Error(m.error));
      };
      worker.postMessage({ ecg: { fs: ecg.fs, segs: ecg.segs, notched: ecg.notched }, acc: ecg.acc });
    });
    res.range = [a, b];
    $("e-info").textContent = `${clock(a)}–${clock(b)} · ${dur(b - a)} · ${ecg.fs} Hz · analysed in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    draw();
  }

  // the strap firmware's labels in [a, b]
  function firmware(a, b) {
    const e = (ses.ectopy || []).filter((x) => x[0] >= a && x[0] <= b);
    const n = (k) => e.filter((x) => x[1] === k).length;
    let beats = 0; for (const x of ses.beats.t) if (x >= a && x <= b) beats++;
    return { pac: n("PAC"), pvc: n("PVC"), art: n("ARTIFACT"), beats, ev: e };
  }

  function draw() {
    const [a, b] = res.range, bu = res.burden, fw = firmware(a, b);
    const bs = res.beats, cnt = {};
    for (const x of bs) cnt[x.label] = (cnt[x.label] || 0) + 1;
    const big = Object.keys(cnt).filter((k) => /GEMINY/.test(k)).reduce((s, k) => s + cnt[k], 0);
    const sinus = Alternans.median(bs.filter((x) => x.label === "N").map((x) => x.sinus));
    const fwPct = fw.beats ? 100 * (fw.pac + fw.pvc) / fw.beats : 0;
    $("e-stats").innerHTML = [
      item("beats", bu.beats, "valid beats found in the ECG (artifacts and the first beat after lost samples not counted)"),
      item("early beats", `${bu.early} <small>${bu.pct.toFixed(1)} %</small>`, "PAC + PVC, isolated and in bigeminy / trigeminy, over all beats"),
      item("PAC / PVC", `${bu.pac} / ${bu.pvc}`, "narrow QRS like the template (r ≥ 0.9, < 120 ms): PAC; wide or unlike it: PVC"),
      item("in bigeminy / trigeminy", big, "early beats inside an episode"),
      item("episodes", `${res.episodes.length} <small>${res.bouts.length} bouts</small>`, "bout: episodes less than 30 s apart"),
      item("sinus R-R", `${r0(sinus)} ms`, "median of the reference the early beats are measured against (clean, non-alternating beats, last 5 min)"),
      item("artifacts", bu.artifacts, "beats in a bad signal: noise between the QRS complexes, EMG, movement"),
      item("pauses", cnt.PAUSE || 0, "R-R > 1.5 × sinus in a clean signal"),
      item("HRV: R-Rs corrected", `${res.hrv.pct.toFixed(1)} %`, "early beats, the R-R after them, artifacts: left out of HRV"),
      item("strap firmware", `${fw.pac + fw.pvc} <small>${fwPct.toFixed(2)} % · ${fw.art} ARTIFACT</small>`, "the strap's own PAC + PVC labels in this range (ectopy stream), for comparison"),
    ].join("");
    $("e-note").textContent = `QRS template width ≈ ${r0(Alternans.median(bs.filter((x) => x.label === "N").map((x) => x.width)))} ms · ` +
      `${res.missedBeatsFound} beat${res.missedBeatsFound === 1 ? "" : "s"} recovered by the template search in long intervals · ` +
      `R-Rs across lost ECG samples are not used (${cnt.GAP || 0}) · single-lead chest strap, not a diagnostic device.`;
    drawTach();
    drawBurden(fw);
    tables();
  }

  function shade(u) {
    const ctx = u.ctx, x0 = u.scales.x.min, x1 = u.scales.x.max, { top, height } = u.bbox;
    ctx.save();
    const box = (e, c) => {
      if (e.t1 < x0 || e.t0 > x1) return;
      const p = u.valToPos(Math.max(x0, e.t0), "x", true), q = u.valToPos(Math.min(x1, e.t1), "x", true);
      ctx.fillStyle = c; ctx.fillRect(p, top, Math.max(1, q - p), height);
    };
    for (const e of res.bouts) box(e, "rgba(255,180,84,0.05)");
    for (const e of res.episodes) box(e, e.type === "GROUPED_BLOCK_SUSPECT" ? "rgba(199,146,234,0.12)" : e.type === "PVC" ? "rgba(255,84,112,0.10)" : "rgba(255,180,84,0.09)");
    ctx.restore();
  }

  function drawTach() {
    const bs = res.beats, t = bs.map((x) => x.t);
    const groups = Object.keys(LAB).filter((k) => bs.some((x) => x.label === k));
    const ser = groups.map((k) => bs.map((x) => (x.label === k ? x.rr : null)));
    const sin = bs.map((x) => x.sinus || null);
    $("e-key").innerHTML = groups.map((k) => `<span class="rv-key"><i style="background:${LAB[k][0]}"></i>${LAB[k][1]}</span>`).join("") +
      `<span class="rv-key"><i style="background:#e6edf3"></i>sinus R-R</span>`;
    if (tach) tach.destroy();
    const rr = bs.map((x) => x.rr).filter((v) => v != null).sort((p, q) => p - q);
    const lo = rr[Math.floor(0.005 * rr.length)] || 400, hi = rr[Math.ceil(0.995 * (rr.length - 1))] || 1400;
    tach = new uPlot({
      width: $("e-tach").clientWidth, height: 300, legend: { show: false }, pxAlign: 0,
      padding: [8, 8, 0, 0],
      cursor: { y: false, points: { show: false }, drag: { x: true, y: false } },
      scales: { x: { time: true }, y: { auto: false, range: () => [Math.max(200, lo - 60), Math.min(2600, hi + 60)] } },
      axes: [axis({ space: 90 }), axis({ label: "R-R ms", size: 50 })],
      series: [{}, { stroke: "rgba(230,237,243,0.55)", width: 1.2, points: { show: false }, spanGaps: true },
               ...groups.map((k) => ({ stroke: LAB[k][0], fill: LAB[k][0], paths: () => null,
                                         points: { show: true, size: k === "N" ? 3 : 4.5, stroke: LAB[k][0], fill: LAB[k][0], width: 0 } }))],
      hooks: { drawClear: [shade] },
    }, [t, sin, ...ser], $("e-tach"));
    tach.over.addEventListener("dblclick", () => tach.setScale("x", { min: t[0], max: t[t.length - 1] }));
    tach.over.addEventListener("click", () => {
      if (tach.select.width > 3) return;
      const v = tach.posToVal(tach.cursor.left, "x");
      if (v === v) window.open(reviewUrl(v - 60, v + 60), "_blank");
    });
  }

  // early beats per bin: ECG analysis (bars) against the strap's PAC + PVC (line)
  function drawBurden(fw) {
    const [a, b] = res.range, span = b - a, bin = span > 4 * 3600 ? 900 : span > 3600 ? 300 : 120;
    const n = Math.max(1, Math.ceil(span / bin)), x = [], app = [], strap = [], art = [];
    const beatsIn = new Float64Array(n), early = new Float64Array(n), fwE = new Float64Array(n), fwB = new Float64Array(n), artN = new Float64Array(n);
    const k = (t) => Math.min(n - 1, Math.max(0, Math.floor((t - a) / bin)));
    for (const e of res.beats) {
      if (e.label === "GAP") continue;
      if (e.label === "ARTIFACT") { artN[k(e.t)]++; continue; }
      beatsIn[k(e.t)]++;
      if (/PAC|PVC/.test(e.label)) early[k(e.t)]++;
    }
    for (const t of ses.beats.t) if (t >= a && t <= b) fwB[k(t)]++;
    for (const e of fw.ev) if (e[1] === "PAC" || e[1] === "PVC") fwE[k(e[0])]++;
    for (let i = 0; i < n; i++) {
      x.push(a + (i + 0.5) * bin);
      app.push(beatsIn[i] ? 100 * early[i] / beatsIn[i] : null);
      strap.push(fwB[i] ? 100 * fwE[i] / fwB[i] : null);
      art.push(beatsIn[i] + artN[i] ? 100 * artN[i] / (beatsIn[i] + artN[i]) : null);
    }
    const fwPct = fw.beats ? 100 * (fw.pac + fw.pvc) / fw.beats : 0;
    $("e-burden-info").innerHTML = `<span class="rv-key"><i style="background:#ffb454"></i>ECG analysis ${res.burden.pct.toFixed(1)} %</span>` +
      `<span class="rv-key"><i style="background:#5aa2ff"></i>strap firmware ${fwPct.toFixed(2)} %</span>` +
      `<span class="rv-key"><i style="background:#6b7480"></i>artifacts (ECG analysis)</span> · ${bin / 60}-min bins`;
    if (burd) burd.destroy();
    const bw = (u) => Math.max(2, (u.valToPos(a + bin, "x") - u.valToPos(a, "x")) * 0.8);
    burd = new uPlot({
      width: $("e-burden").clientWidth, height: 220, legend: { show: false }, pxAlign: 0,
      padding: [8, 8, 0, 0], cursor: { y: false, points: { show: false } },
      scales: { x: { time: true, range: () => [a, b] }, y: { range: (u, lo, hi) => [0, Math.max(10, Math.ceil((hi || 10) / 5) * 5)] } },
      axes: [axis({ space: 90 }), axis({ label: "early beats %", size: 50 })],
      series: [{},
        { stroke: "#6b7480", fill: "rgba(107,116,128,0.35)", paths: uPlot.paths.bars({ size: [0.8, 40], align: 0 }), points: { show: false } },
        { stroke: "#ffb454", fill: "rgba(255,180,84,0.55)", paths: uPlot.paths.bars({ size: [0.5, 30], align: 0 }), points: { show: false } },
        { stroke: "#5aa2ff", width: 2, points: { show: true, size: 5, fill: "#5aa2ff" } }],
    }, [x, art, app, strap], $("e-burden"));
    void bw;
  }

  function tables() {
    const open = (e) => window.open(reviewUrl(e.t0 - 30, e.t1 + 30), "_blank");
    const tr = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
    const typeName = (t) => ({ PAC: "PAC", PVC: "PVC", GROUPED_BLOCK_SUSPECT: "grouped – block?" }[t] || t);
    $("e-bouts").innerHTML = `<thead><tr><th>start</th><th>end</th><th>duration</th><th>in episodes</th><th>episodes</th><th>pairs</th><th>short</th><th>long</th><th>ratio</th><th>sinus R-R</th><th>type</th></tr></thead><tbody>` +
      res.bouts.map((e) => tr([clock(e.t0), clock(e.t1), dur(e.dur), dur(e.inEpisodes), e.n, e.pairs, r0(e.shortMean), r0(e.longMean), e.ratio.toFixed(2), r0(e.sinusRR),
                               `${e.kind} ${e.types.map(typeName).join(" / ")}`])).join("") + "</tbody>";
    $("e-eps").innerHTML = `<thead><tr><th>start</th><th>end</th><th>duration</th><th>pairs</th><th>short ms</th><th>long ms</th><th>ratio (CV)</th><th>sinus R-R</th><th>(S+L) / sinus</th><th>type</th><th>mean HR</th><th>movement g</th><th>posture</th></tr></thead><tbody>` +
      res.episodes.map((e) => tr([clock(e.t0), clock(e.t1), dur(e.dur), e.pairs, r0(e.shortMean), r0(e.longMean), `${e.ratio.toFixed(2)} (${e.ratioCV.toFixed(2)})`,
                                  r0(e.sinusRR), e.sumRatio.toFixed(2), `${e.kind} ${typeName(e.type)}${e.pauses ? ` · ${e.pauses} pause${e.pauses > 1 ? "s" : ""}` : ""}`, r0(e.hr),
                                  e.movement == null ? "–" : e.movement.toFixed(3), e.posture || "–"])).join("") + "</tbody>";
    for (const [id, list] of [["e-bouts", res.bouts], ["e-eps", res.episodes]]) {
      $(id).querySelectorAll("tbody tr").forEach((row, i) => { row.style.cursor = "pointer"; row.addEventListener("click", () => open(list[i])); });
    }
    $("e-hours").innerHTML = `<thead><tr><th>hour</th><th>beats</th><th>early</th><th>%</th><th>PAC</th><th>PVC</th></tr></thead><tbody>` +
      res.burden.hours.map((h) => tr([`${new Date(h.t * 1000).toLocaleDateString()} ${pad(new Date(h.t * 1000).getHours())}:00`, h.beats, h.early,
                                      (100 * h.early / Math.max(1, h.beats)).toFixed(1), h.pac, h.pvc])).join("") + "</tbody>";
    // downloads: per beat and per episode, CSV
    const csv = (rows) => new Blob([rows.map((r) => r.join(",")).join("\n") + "\n"], { type: "text/csv" });
    const beatRows = [["unix_time", "label", "rr_ms", "coupling_ms", "pause_ms", "sqi", "qrs_corr", "qrs_width_ms", "sinus_rr_ms"],
      ...res.beats.map((x) => [x.t.toFixed(4), x.label, x.rr ?? "", x.coupling ?? "", x.pause ?? "", x.sqi, x.corr, x.width, x.sinus])];
    const epRows = [["start", "end", "duration_s", "kind", "type", "pairs", "short_ms", "long_ms", "ratio", "ratio_cv", "sinus_rr_ms", "sum_over_sinus", "mean_hr", "movement_g", "posture"],
      ...res.episodes.map((e) => [e.t0.toFixed(3), e.t1.toFixed(3), e.dur.toFixed(1), e.kind, e.type, e.pairs, r0(e.shortMean), r0(e.longMean), e.ratio.toFixed(3),
                                  e.ratioCV.toFixed(3), r0(e.sinusRR), e.sumRatio.toFixed(3), e.hr.toFixed(1), e.movement == null ? "" : e.movement.toFixed(3), e.posture || ""])];
    const link = (blob, name, text) => `<a class="tool-btn" download="${name}" href="${URL.createObjectURL(blob)}">${text}</a>`;
    $("e-dl").innerHTML = link(csv(beatRows), `ectopy_beats_${sesId}.csv`, "beats CSV") + " " + link(csv(epRows), `ectopy_episodes_${sesId}.csv`, "episodes CSV");
  }

  $("e-run").addEventListener("click", () => run().catch((e) => { $("e-info").textContent = "error: " + e.message; }));
  $("e-ses").addEventListener("change", () => { history.replaceState(null, "", `#s=${$("e-ses").value}`); run().catch((e) => { $("e-info").textContent = "error: " + e.message; }); });
  let rt = 0;
  addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (res) { drawTach(); drawBurden(firmware(...res.range)); } }, 200); });
  sessions().then(() => { if (new URLSearchParams(location.hash.slice(1)).get("s")) run().catch((e) => { $("e-info").textContent = "error: " + e.message; }); });
})();
