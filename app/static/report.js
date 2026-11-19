/* One-page episode report (A4 landscape, print or save as PDF): /report#s=<session>&a=&b=.
 * Everything comes from the saved recording (also the one being recorded), through the
 * same alternans.js as the dashboard and the review page. Charts are SVG in millimetres,
 * so the ECG strips print at true scale: 25 mm/s, 10 mm/mV, on an ECG grid. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const NS = "http://www.w3.org/2000/svg";
  const STRIP_S = 10, MM_S = 25, MM_MV = 10, STRIP_H = 22, CAL_W = 10;
  const pad = (n) => String(n).padStart(2, "0");
  const clock = (t, sec = true) => { const d = new Date(t * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}${sec ? ":" + pad(d.getSeconds()) : ""}`; };
  const date = (t) => new Date(t * 1000).toLocaleDateString([], { year: "numeric", month: "2-digit", day: "2-digit" });
  const r0 = (v) => (v == null || v !== v ? "–" : Math.round(v));
  const dur = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${pad(Math.round(s % 60))} min` : `${Math.round(s)} s`);
  const msg = (s) => { $("msg").textContent = s; };
  let cal = +(localStorage.getItem("hrm.report.cal") || 0) || 1500;     // ADC counts per mV (uncalibrated default)
  $("cal").value = cal;

  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function svg(host, w, h) {
    host.innerHTML = "";
    return el("svg", { width: w + "mm", height: h + "mm", viewBox: `0 0 ${w} ${h}` }, host);
  }
  function text(s, x, y, o, parent) {
    const t = el("text", { x, y, "font-size": o.size || 2.2, fill: o.fill || "#111", "text-anchor": o.anchor || "start", ...(o.attrs || {}) }, parent);
    t.textContent = s;
    return t;
  }
  const poly = (pts, o, parent) => el("polyline", { points: pts.map((p) => p[0].toFixed(2) + "," + p[1].toFixed(2)).join(" "),
    fill: "none", stroke: o.stroke || "#111", "stroke-width": o.width || 0.2, "stroke-linejoin": "round", ...(o.attrs || {}) }, parent);

  // ---------------- ECG strip ----------------
  function strip(host, labHost, ecg, a, label, epis) {
    const W = CAL_W + STRIP_S * MM_S, H = STRIP_H;
    const s = svg(host, W, H);
    for (let x = 0; x <= STRIP_S * MM_S + 1e-6; x += 1) {
      const major = Math.round(x) % 5 === 0;
      el("line", { x1: CAL_W + x, y1: 0, x2: CAL_W + x, y2: H, stroke: major ? "var(--grid5)" : "var(--grid1)", "stroke-width": major ? 0.12 : 0.06 }, s);
    }
    for (let y = 0; y <= H + 1e-6; y += 1) {
      const major = Math.round(y) % 5 === 0;
      el("line", { x1: CAL_W, y1: y, x2: W, y2: y, stroke: major ? "var(--grid5)" : "var(--grid1)", "stroke-width": major ? 0.12 : 0.06 }, s);
    }
    const mid = H * 0.62;
    poly([[1, mid], [3, mid], [3, mid - MM_MV], [8, mid - MM_MV], [8, mid], [CAL_W - 0.5, mid]], { width: 0.25 }, s);   // 1 mV pulse
    text("1 mV", 5.5, mid - MM_MV - 0.8, { size: 1.8, anchor: "middle" }, s);
    if (!ecg || !ecg.segs.length) { text("no ECG here", CAL_W + 4, H / 2, { size: 3 }, s); labHost.innerHTML = `<span>${label}</span>`; return; }
    const D = window.BeatDTW, fs = ecg.fs;
    const f = ecg.segs.filter((g) => g.v.length > 3 * fs).map((g) => ({ t: g.t, v: g.v, x: D.prep(g.v, fs, { notch: ecg.notched ? 0 : 50, hp: 0.5, lp: 40 }) }));
    const inWin = [];
    for (const g of f) for (let i = 0; i < g.x.length; i++) { const t = g.t + i / fs; if (t >= a && t <= a + STRIP_S) inWin.push(g.x[i]); }
    const base = Alternans.median(inWin);
    for (const g of f) {
      let pts = [];
      for (let i = 0; i < g.x.length; i++) {
        const t = g.t + i / fs;
        if (t < a || t > a + STRIP_S) { if (pts.length > 1) poly(pts, { width: 0.22 }, s); pts = []; continue; }
        const y = Math.max(0.3, Math.min(H - 0.3, mid - (g.x[i] - base) / cal * MM_MV));
        pts.push([CAL_W + (t - a) * MM_S, y]);
      }
      if (pts.length > 1) poly(pts, { width: 0.22 }, s);
    }
    // R peaks found in the ECG, the R-R in ms above each; in an episode S (short) / L (long)
    const det = D.detect(f, fs), Rs = det.beats.filter((b) => b.r >= a - 2 && b.r <= a + STRIP_S + 2);
    for (let k = 1; k < Rs.length; k++) {
      const b = Rs[k], p = Rs[k - 1];
      if (b.r < a || b.r > a + STRIP_S || b.seg !== p.seg) continue;
      const rr = (b.r - p.r) * 1000, x = CAL_W + (b.r - a) * MM_S;
      let tag = "";
      if (epis.some((e) => b.r >= e.t0 && b.r <= e.t1) && Rs[k + 1] && Rs[k + 1].seg === b.seg) {
        const rn = (Rs[k + 1].r - b.r) * 1000;
        tag = rr < rn ? " S" : " L";
      }
      text(Math.round(rr) + tag, x, 2.3, { size: 1.9, anchor: "middle", fill: tag === " S" ? "var(--a)" : tag === " L" ? "var(--b)" : "#333" }, s);
    }
    labHost.innerHTML = `<span><b>${label}</b> · ${clock(a)}–${clock(a + STRIP_S)}</span><span>25 mm/s · 10 mm/mV · R-R in ms (S/L: short/long cycle in an episode)</span>`;
  }

  // ---------------- small charts ----------------
  function frame(s, x0, y0, w, h, xr, yr, xt, yt) {
    el("rect", { x: x0, y: y0, width: w, height: h, fill: "none", stroke: "#999", "stroke-width": 0.15 }, s);
    const X = (v) => x0 + (v - xr[0]) / (xr[1] - xr[0]) * w, Y = (v) => y0 + h - (v - yr[0]) / (yr[1] - yr[0]) * h;
    for (const [v, lab] of xt) { el("line", { x1: X(v), y1: y0, x2: X(v), y2: y0 + h, stroke: "#e3e3e3", "stroke-width": 0.1 }, s); text(lab, X(v), y0 + h + 2.4, { size: 1.9, anchor: "middle", fill: "#555" }, s); }
    for (const [v, lab] of yt) { el("line", { x1: x0, y1: Y(v), x2: x0 + w, y2: Y(v), stroke: "#e3e3e3", "stroke-width": 0.1 }, s); text(lab, x0 - 0.8, Y(v) + 0.7, { size: 1.9, anchor: "end", fill: "#555" }, s); }
    return { X, Y };
  }
  function ticks(lo, hi, n) {
    const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw)), st = [1, 2, 5, 10].map((m) => m * mag).find((m) => m >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(lo / st) * st; v <= hi + 1e-9; v += st) out.push(+v.toFixed(6));
    return out;
  }

  function tachogram(beats, res, ta, tb) {
    const W = 92, H = 44, s = svg($("tach"), W, H), x0 = 9, y0 = 1, w = W - 11, h = H - 6;
    const idx = [];
    for (let i = 0; i < beats.t.length; i++) if (beats.t[i] >= ta && beats.t[i] <= tb && beats.rr[i] >= 300 && beats.rr[i] <= 2000) idx.push(i);
    const rr = idx.map((i) => beats.rr[i]);
    const lo = Math.min(...rr) - 30, hi = Math.max(...rr) + 30;
    const step = (tb - ta) > 1200 ? 300 : (tb - ta) > 480 ? 120 : 60;
    const xt = []; for (let v = Math.ceil(ta / step) * step; v <= tb; v += step) xt.push([v, clock(v, false)]);
    const { X, Y } = frame(s, x0, y0, w, h, [ta, tb], [lo, hi], xt, ticks(lo, hi, 4).map((v) => [v, String(v)]));
    for (const e of res.episodes) {
      if (e.t1 < ta || e.t0 > tb) continue;
      el("rect", { x: X(Math.max(ta, e.t0)), y: y0, width: X(Math.min(tb, e.t1)) - X(Math.max(ta, e.t0)), height: h, fill: "rgba(224,123,0,0.13)" }, s);
    }
    for (const i of idx) el("circle", { cx: X(beats.t[i]), cy: Y(beats.rr[i]), r: 0.32,
      fill: res.label[i] === Alternans.SHORT ? "var(--a)" : res.label[i] === Alternans.LONG ? "var(--b)" : "#333" }, s);
    text("RR ms", 0.5, y0 + 2, { size: 1.9, fill: "#555" }, s);
    $("tach-sub").textContent = `${clock(ta, false)}–${clock(tb, false)} · shaded: episode · orange short / blue long cycle`;
    return idx;
  }

  function poincare(beats, res, idx) {
    const W = 50, H = 44, s = svg($("poin"), W, H), x0 = 8, y0 = 1, w = 38, h = 36;
    const pts = [];
    for (const i of idx) if (i + 1 < beats.t.length && !beats.gap[i + 1] && beats.rr[i + 1] >= 300 && beats.rr[i + 1] <= 2000)
      pts.push([beats.rr[i], beats.rr[i + 1], res.ep[i] >= 0 && res.ep[i + 1] >= 0]);
    if (!pts.length) return;
    const all = pts.flatMap((p) => [p[0], p[1]]), lo = Math.min(...all) - 30, hi = Math.max(...all) + 30;
    const tk = ticks(lo, hi, 4).map((v) => [v, String(v)]);
    const { X, Y } = frame(s, x0, y0, w, h, [lo, hi], [lo, hi], tk, tk);
    el("line", { x1: X(lo), y1: Y(lo), x2: X(hi), y2: Y(hi), stroke: "#aaa", "stroke-width": 0.12, "stroke-dasharray": "0.8 0.8" }, s);
    for (const p of pts.filter((q) => !q[2])) el("circle", { cx: X(p[0]), cy: Y(p[1]), r: 0.35, fill: "#777", "fill-opacity": 0.6 }, s);
    for (const p of pts.filter((q) => q[2])) el("circle", { cx: X(p[0]), cy: Y(p[1]), r: 0.38, fill: "var(--a)", "fill-opacity": 0.8 }, s);
    text("RRn ms", x0 + w / 2, H - 0.5, { size: 1.9, anchor: "middle", fill: "#555" }, s);
    $("poin-sub").textContent = `orange: episode (${pts.filter((q) => q[2]).length}) · grey: other beats (${pts.filter((q) => !q[2]).length})`;
  }

  function splitPlot(sa) {
    const W = 64, H = 30, s = svg($("split"), W, H), x0 = 8, y0 = 1, w = 55, h = 24;
    if (!sa) { text("not enough clean beats", 4, 10, { size: 2.4 }, s); return; }
    const ys = [sa.A, sa.B].filter(Boolean).flatMap((g) => Array.from(g.y));
    const lo = Math.min(...ys), hi = Math.max(...ys), m = 0.06 * (hi - lo);
    const xr = [sa.tms[0], sa.tms[sa.tms.length - 1]];
    const { X, Y } = frame(s, x0, y0, w, h, xr, [lo - m, hi + m], ticks(xr[0], xr[1], 5).map((v) => [v, String(v)]), []);
    el("rect", { x: X(-250), y: y0, width: X(-40) - X(-250), height: h, fill: "rgba(0,0,0,0.05)" }, s);
    for (const [g, c] of [[sa.B, "var(--b)"], [sa.A, "var(--a)"]]) if (g) poly(sa.tms.map((t, i) => [X(t), Y(g.y[i])]), { stroke: c, width: 0.3 }, s);
    text("ms from R · shaded: P window", x0 + w / 2, H - 0.3, { size: 1.9, anchor: "middle", fill: "#555" }, s);
    const g = (k, f) => (sa[k] ? f(sa[k]) : "–");
    const row = (n, f, u) => `<tr><td>${n}</td><td>${g("A", f)}</td><td>${g("B", f)}</td><td>${u}</td></tr>`;
    $("split-tab").innerHTML = `<table><tr><th></th><th style="color:var(--a)">A short</th><th style="color:var(--b)">B long</th><th></th></tr>` +
      row("beats", (x) => x.n, "") + row("RR before", (x) => r0(x.rr), "ms") + row("PR", (x) => r0(x.m.pr), "ms") +
      row("P onset", (x) => r0(x.m.pOn), "ms from R") + row("P amplitude", (x) => (x.m.pAmp == null ? "–" : (x.m.pAmp / cal * 1000).toFixed(0)), "µV") +
      row("P duration", (x) => r0(x.m.pDur), "ms") + row("QRS", (x) => r0(x.m.qrs), "ms") +
      `<tr><td>P corr. A–B</td><td colspan="2">${sa.pCorr === sa.pCorr ? sa.pCorr.toFixed(2) : "–"}</td><td>−250…−40 ms</td></tr></table>` +
      `<div class="hint ${sa.verdict}">${sa.hint}</div>`;
  }

  // ---------------- the report ----------------
  async function build() {
    const h = new URLSearchParams(location.hash.slice(1));
    const id = h.get("s");
    let a = +h.get("a"), b = +h.get("b");
    if (!id) { msg("no session in the URL (#s=…&a=…&b=…)"); return; }
    msg("loading the recording…");
    const [ses, cur, events] = await Promise.all([
      fetch(`/api/sessions/${id}`).then((r) => r.json()),
      fetch("/api/current").then((r) => r.json()).catch(() => ({})),
      fetch(`/api/sessions/${id}/events`).then((r) => r.json()).catch(() => []),
    ]);
    const beats = ses.beats, t = beats.t;
    if (!t.length) { msg("no beats in this recording"); return; }
    if (!(b > a)) { a = t[0]; b = t[t.length - 1]; }
    const res = Alternans.detect(beats, ses.ectopy);
    const eps = Alternans.inRange(res, a, b);
    const main = eps.slice().sort((x, y) => y.dur - x.dur)[0] || null;
    const fs = (ses.meta && ses.meta.ecg_fs) || 250;
    const live = cur && cur.id === id;
    $("h-meta").textContent = `${date(a)} ${clock(a, false)}–${clock(b, false)} · HRM Raw RR chest strap, ECG ${fs} Hz · source: ${live ? "live (session being recorded)" : "saved recording"} ${id}`;
    $("h-meta2").textContent = `Detector ${Alternans.paramsKey()} · generated ${new Date().toLocaleString()}`;
    $("h-filter").textContent = `Strips: 0.5–40 Hz, ${ses.meta && ses.meta.ecg_info && ses.meta.ecg_info.notched_hz ? "mains notch in the strap" : "50 Hz notch"} · 10 mm/mV at ${cal} ADC counts/mV (estimated, not calibrated).`;

    // strips: onset, mid-episode, a reference without alternation
    const winOf = async (ta) => { try { return await Alternans.fetchEcg(id, ta - 2, ta + STRIP_S + 2); } catch (e) { return null; } };
    const s1a = main ? main.t0 - 3 : a, s2a = main ? (main.t0 + main.t1) / 2 - STRIP_S / 2 : (a + b) / 2 - STRIP_S / 2;
    const s3a = Alternans.referenceWindow(beats, res, main || { t0: a, t1: b });
    msg("loading the ECG strips…");
    const [e1, e2, e3] = await Promise.all([winOf(s1a), winOf(s2a), s3a != null ? winOf(s3a) : null]);
    strip($("s1"), $("s1-lab"), e1, s1a, main ? "Episode onset" : "Start of the range", res.episodes);
    strip($("s2"), $("s2-lab"), e2, s2a, main ? "Mid-episode" : "Middle of the range", res.episodes);
    if (s3a != null) strip($("s3"), $("s3-lab"), e3, s3a, "Reference (no alternation)", res.episodes);
    else $("s3-lab").textContent = "Reference: no stretch without alternation found in this recording";

    // tachogram and Poincaré: the episode(s) ±2 min (at most 40 min)
    let ta = Math.max(t[0], Math.min(a, main ? main.t0 : a) - 120), tb = Math.min(t[t.length - 1], Math.max(b, main ? main.t1 : b) + 120);
    if (tb - ta > 2400) { const c = main ? (main.t0 + main.t1) / 2 : (a + b) / 2; ta = Math.max(t[0], c - 1200); tb = Math.min(t[t.length - 1], c + 1200); }
    const idx = tachogram(beats, res, ta, tb);
    poincare(beats, res, idx);

    // summary
    const inR = (x) => x >= a && x <= b;
    const ecto = ses.ectopy.filter((e) => inR(e[0]));
    const nOf = (k) => ecto.filter((e) => e[1] === k).length;
    const artIn = ecto.filter((e) => e[1] === "ARTIFACT" && res.episodes.some((p) => e[0] >= p.t0 && e[0] <= p.t1 + 1)).length;
    const hr = [];
    const ib = [];
    for (let i = 0; i < t.length; i++) if (inR(t[i]) && beats.rr[i] >= 300 && beats.rr[i] <= 2000) ib.push(beats.rr[i]);
    for (let i = 0; i + 10 <= ib.length; i += 5) hr.push(60000 / Alternans.median(ib.slice(i, i + 10)));
    hr.sort((x, y) => x - y);
    const pct = (q) => hr[Math.min(hr.length - 1, Math.max(0, Math.round(q * (hr.length - 1))))];
    const totDur = eps.reduce((s, e) => s + Math.min(e.t1, b) - Math.max(e.t0, a), 0);
    const hv1 = Alternans.hrv(beats, t.findIndex((x) => x >= a), t.findIndex((x) => x > b) < 0 ? t.length : t.findIndex((x) => x > b));
    const hv2 = Alternans.hrv(beats, t.findIndex((x) => x >= a), t.findIndex((x) => x > b) < 0 ? t.length : t.findIndex((x) => x > b), Alternans.hrvMask(res));
    $("sum").innerHTML = `<table>
      <tr><td>alternans episodes</td><td>${eps.length}</td></tr>
      <tr><td>total duration</td><td>${dur(totDur)} (${(100 * totDur / Math.max(1, b - a)).toFixed(0)} % of the range)</td></tr>
      <tr><td>HR range (10-beat medians, 2–98 %)</td><td>${hr.length ? `${Math.round(pct(0.02))}–${Math.round(pct(0.98))} bpm` : "–"}</td></tr>
      <tr><td>strap PVC / PAC</td><td>${nOf("PVC")} / ${nOf("PAC")}</td></tr>
      <tr><td>strap ARTIFACT labels</td><td>${nOf("ARTIFACT")} (${artIn} inside episodes)</td></tr>
      <tr><td>RMSSD all / without episodes</td><td>${r0(hv1.rmssd)} / ${r0(hv2.rmssd)} ms</td></tr>
      </table>` +
      (eps.length ? `<table style="margin-top:1mm"><tr><th>start</th><th>dur</th><th>beats</th><th>short</th><th>long</th><th>|ΔRR|</th><th>prem.</th></tr>` +
        eps.slice(0, 6).map((e) => `<tr><td>${clock(e.t0)}</td><td>${dur(e.dur)}</td><td>${e.n}</td><td>${r0(e.shortMean)}</td><td>${r0(e.longMean)}</td><td>${r0(e.medDelta)}</td><td>${e.prematurity.toFixed(2)}</td></tr>`).join("") +
        (eps.length > 6 ? `<tr><td colspan="7">… ${eps.length - 6} more</td></tr>` : "") + `</table>` : "");
    const notes = events.filter((e) => e.t >= a - 600 && e.t <= b + 600 && e.note);
    $("notes").innerHTML = notes.length ? "<b>Notes:</b> " + notes.map((e) => `${clock(e.t, false)} ${escapeHtml(e.note)}`).join(" · ") : "<b>Notes:</b> none";

    // split average over the episodes in the range (at most 15 min of ECG)
    if (eps.length) {
      let left = 900;
      const segs = [];
      let efs = fs, notched = 0;
      const parts = [];
      for (const e of eps) { if (left <= 0) break; const p0 = Math.max(a, e.t0), p1 = Math.min(b, e.t1, p0 + left); parts.push([p0, p1]); left -= p1 - p0; }
      for (let k = 0; k < parts.length; k++) {
        const d = await Alternans.fetchEcg(id, parts[k][0], parts[k][1], (fr) => msg(`split average: loading the ECG… ${Math.round(100 * (k + fr) / parts.length)} %`));
        efs = d.fs; notched = d.notched; segs.push(...d.segs);
      }
      const sa = Alternans.splitAverage({ fs: efs, segs, notched }, eps.map((e) => ({ t0: Math.max(a, e.t0), t1: Math.min(b, e.t1) })));
      $("split-sub").textContent = `R-aligned means of the episodes' beats ending a short (A) / long (B) R-R`;
      splitPlot(sa);
    } else {
      $("split-sub").textContent = "no alternans episode in this range";
    }
    msg(eps.length ? "ready · print it, or save as PDF (A4 landscape)" : "ready · no alternans episode in this range");
  }
  function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  $("print").addEventListener("click", () => window.print());
  $("cal").addEventListener("change", () => {
    cal = Math.max(50, +$("cal").value || 1500);
    try { localStorage.setItem("hrm.report.cal", cal); } catch (e) { /* private mode */ }
    build().catch((e) => msg("error: " + e.message));
  });
  addEventListener("hashchange", () => build().catch((e) => msg("error: " + e.message)));
  build().catch((e) => msg("error: " + e.message));
})();
