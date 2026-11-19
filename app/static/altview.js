/* Alternans views shared by the live dashboard, the review page and the report:
 * the split averaged beat (A short-cycle vs B long-cycle, uPlot), its metrics table,
 * and the episode list. Needs uPlot and alternans.js. window.AltView. */
(function () {
  "use strict";
  const css = (n, d) => (getComputedStyle(document.documentElement).getPropertyValue(n).trim() || d);
  const COL = { A: "#ffb454", B: "#5aa2ff" };
  const FONT = "12px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
  const r0 = (v) => (v == null || v !== v ? "–" : Math.round(v));
  const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour12: false });
  const dur = (s) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`
                     : s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`);

  /* A over B, R at 0; the P window (-250 ... -40 ms) shaded; o.print: light colours */
  function splitChart(host, sa, o = {}) {
    host.innerHTML = "";
    if (!sa) { host.textContent = "no split average"; return null; }
    const text = o.print ? "#333" : css("--muted", "#8b96a5"), grid = o.print ? "#ddd" : css("--grid", "#232936");
    const axis = (x) => ({ stroke: text, font: FONT, ticks: { show: false }, grid: { stroke: grid, width: 1 }, labelFont: FONT, labelSize: 14, ...x });
    const ser = [{}];
    const data = [sa.tms];
    for (const [k, g] of [["A", sa.A], ["B", sa.B]]) {
      if (!g) continue;
      ser.push({ label: k === "A" ? `A short-cycle (${g.n})` : `B long-cycle (${g.n})`, stroke: COL[k], width: 1.8, points: { show: false } });
      data.push(Array.from(g.y));
    }
    return new uPlot({
      width: o.width || host.clientWidth || 400, height: o.height || 240, pxAlign: 0,
      legend: { show: true }, padding: [8, 8, 0, 0],
      cursor: { y: false, points: { show: false }, drag: { x: true, y: false } },
      scales: { x: { time: false } },
      axes: [axis({ label: "ms from R" }), axis({ label: "ECG", size: 48 })],
      series: ser,
      hooks: { drawClear: [(u) => {
        const ctx = u.ctx, x0 = u.valToPos(-250, "x", true), x1 = u.valToPos(-40, "x", true);
        ctx.save(); ctx.fillStyle = o.print ? "rgba(0,0,0,0.05)" : "rgba(139,150,165,0.09)";
        ctx.fillRect(x0, u.bbox.top, x1 - x0, u.bbox.height); ctx.restore();
      }] },
    }, data, host);
  }

  function metricsTable(sa) {
    if (!sa) return "";
    const row = (name, f, unit, title) => `<tr title="${title || ""}"><td>${name}</td><td>${sa.A ? f(sa.A) : "–"}</td><td>${sa.B ? f(sa.B) : "–"}</td><td>${unit}</td></tr>`;
    const m = (k, g) => r0(g.m[k]);
    return `<table class="alt-table"><tr><th></th><th style="color:${COL.A}">A short</th><th style="color:${COL.B}">B long</th><th></th></tr>` +
      row("beats", (g) => g.n + (g.dropped ? ` <span class="hint">(−${g.dropped})</span>` : ""), "", "averaged (left out: shape far from the group's median)") +
      row("RR before", (g) => r0(g.rr), "ms") +
      row("PR", (g) => m("pr", g), "ms", "P onset to QRS onset") +
      row("P onset", (g) => m("pOn", g), "ms from R") +
      row("P amplitude", (g) => (g.m.pAmp == null ? "–" : g.m.pAmp.toFixed(0)), "ADC", "P peak above its baseline, in the ECG's own units") +
      row("P duration", (g) => m("pDur", g), "ms") +
      row("QRS", (g) => m("qrs", g), "ms") +
      `<tr><td>P-wave corr.</td><td colspan="2">${sa.pCorr === sa.pCorr ? sa.pCorr.toFixed(2) : "–"}</td><td>A vs B, −250…−40 ms</td></tr></table>` +
      `<div class="alt-hint ${sa.verdict}">${sa.hint} <span class="hint">A hint from a single-lead strap, not a diagnosis.</span></div>`;
  }

  function episodeTable(eps, onClick, sel) {
    const host = document.createElement("table");
    host.className = "alt-table alt-eps";
    host.innerHTML = `<tr><th>start</th><th>end</th><th>duration</th><th>beats</th><th title="mean of the short R-R intervals">short RR</th>` +
      `<th title="mean of the long R-R intervals">long RR</th><th title="median |ΔRR|">|ΔRR|</th>` +
      `<th title="short RR / median long RR (the reference for prematurity during an episode)">prematurity</th></tr>`;
    eps.forEach((e, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${clock(e.t0)}</td><td>${e.ongoing ? "ongoing" : clock(e.t1)}</td><td>${dur(e.dur)}</td><td>${e.n}</td>` +
        `<td>${r0(e.shortMean)}</td><td>${r0(e.longMean)}</td><td>${r0(e.medDelta)}</td><td>${e.prematurity ? e.prematurity.toFixed(2) : "–"}</td>`;
      if (onClick) { tr.className = "click" + (sel === i ? " sel" : ""); tr.addEventListener("click", () => onClick(e, i)); }
      host.appendChild(tr);
    });
    return host;
  }

  function statsText(st) {
    return st.count ? `${st.count} episode${st.count > 1 ? "s" : ""} · ${dur(st.dur)} · ${st.pct.toFixed(1)} % of the monitored time`
                    : "no episodes";
  }

  window.AltView = { splitChart, metricsTable, episodeTable, statsText, dur, clock, COL };
})();
