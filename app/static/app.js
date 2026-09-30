/* HRM Raw RR dashboard client.
 * Connects to /ws, keeps rolling buffers, and drives:
 *   - uPlot   for the raw ECG waveform (250 Hz, 6 s window)
 *   - Plotly  for the RR/HRV tachogram and the accelerometer
 *   - plain DOM for HR, steps, ectopy counts/log and battery.
 * Auto-reconnects the WebSocket if the link or the page connection drops.
 */
(() => {
  "use strict";

  const COL = { ecg:"#4bd1a0", rr:"#ff5470", x:"#5aa2ff", y:"#ffb454", z:"#c792ea",
                grid:"#232936", text:"#8b96a5" };

  // ---------- unified strip chart: ECG + Accel X/Y/Z + RR on one time axis ----------
  const FS = 250, WIN = 6, ECG_WIN = FS * WIN;   // 1500 ECG samples = 6 s
  const nowS = () => performance.now() / 1000;
  const PLOTLY_CFG = { displayModeBar: false, responsive: true };
  const AX = { gridcolor: COL.grid, zeroline: false };

  // ECG rolling buffer; fixed x = -6..0 s (newest sample at 0)
  const ecgX = new Float64Array(ECG_WIN);
  for (let i = 0; i < ECG_WIN; i++) ecgX[i] = (i - (ECG_WIN - 1)) / FS;
  const ecgY = new Array(ECG_WIN).fill(null);
  function pushEcg(samples) {
    for (const s of samples) ecgY.push(s);
    while (ecgY.length > ECG_WIN) ecgY.shift();
    while (ecgY.length < ECG_WIN) ecgY.unshift(null);
  }

  // accel + RR: time-stamped rolling buffers (x = seconds relative to now)
  const accTs = [], accX = [], accY = [], accZ = [];
  const rrTs = [], rrVals = [];
  function pushAccel(m) {
    const t = nowS();
    accTs.push(t); accX.push(m.x); accY.push(m.y); accZ.push(m.z);
    while (accTs.length && accTs[0] < t - WIN - 1) { accTs.shift(); accX.shift(); accY.shift(); accZ.shift(); }
    setText("steps", m.steps);
  }
  function pushRr(ms) {
    const t = nowS();
    rrTs.push(t); rrVals.push(Math.round(ms));
    while (rrTs.length && rrTs[0] < t - WIN - 1) { rrTs.shift(); rrVals.shift(); }
    pendingBeats.push(t);   // queue this beat for the signal-average
  }

  // red dots on the ECG lane at each detected beat, snapped to the real R peak
  // in the ECG buffer (auto-corrects the detector/filter latency).
  function beatMarkers() {
    const t0 = nowS();
    let sum = 0, c = 0;
    for (const v of ecgY) if (v != null) { sum += v; c++; }
    const base = c ? sum / c : 2000;
    const BACK = Math.round(0.30 * FS), FWD = Math.round(0.05 * FS);
    const xs = [], ys = [];
    for (const tb of rrTs) {
      const xb = tb - t0;
      if (xb < -WIN || xb > 0) continue;
      const ib = Math.round(xb * FS + (ECG_WIN - 1));
      let best = -1, bestv = -1;
      for (let j = Math.max(0, ib - BACK); j <= Math.min(ECG_WIN - 1, ib + FWD); j++) {
        const v = ecgY[j];
        if (v == null) continue;
        const d = v - base;            // R peak = max POSITIVE deviation (not |.|)
        if (d > bestv) { bestv = d; best = j; }
      }
      if (best >= 0) { xs.push(ecgX[best]); ys.push(ecgY[best]); }
    }
    return { x: xs, y: ys };
  }

  // one Plotly chart, stacked lanes (ECG / X / Y / Z / RR), shared time x-axis
  function stripTraces() {
    const t0 = nowS();
    const ax = accTs.map((t) => t - t0);
    const rx = rrTs.map((t) => t - t0);
    const bm = beatMarkers();
    return [
      { x: ecgX, y: ecgY.slice(), name: "ECG", mode: "lines", line: { color: COL.ecg, width: 1 }, yaxis: "y" },
      { x: bm.x, y: bm.y, name: "beat", mode: "markers",
        marker: { size: 7, color: "#ff2d2d", line: { width: 0 } }, yaxis: "y", hoverinfo: "skip" },
      { x: ax, y: accX.slice(), name: "X", mode: "lines", line: { color: COL.x, width: 1 }, yaxis: "y2" },
      { x: ax, y: accY.slice(), name: "Y", mode: "lines", line: { color: COL.y, width: 1 }, yaxis: "y3" },
      { x: ax, y: accZ.slice(), name: "Z", mode: "lines", line: { color: COL.z, width: 1 }, yaxis: "y4" },
      { x: rx, y: rrVals.slice(), name: "RR", mode: "lines+markers",
        line: { color: COL.rr, width: 1.3 }, marker: { size: 4, color: COL.rr }, yaxis: "y5" },
    ];
  }
  function stripLayout() {
    const lane = (dom, title) => ({ ...AX, domain: dom, title: { text: title, font: { size: 10, color: COL.text } } });
    return {
      paper_bgcolor: "transparent", plot_bgcolor: "transparent",
      font: { color: COL.text, size: 11 },
      margin: { l: 54, r: 10, t: 6, b: 26 },
      showlegend: false,
      xaxis:  { ...AX, range: [-WIN, 0], title: "s", anchor: "y5" },
      yaxis:  lane([0.62, 1.00], "ECG"),
      yaxis2: lane([0.50, 0.605], "X"),
      yaxis3: lane([0.385, 0.49], "Y"),
      yaxis4: lane([0.27, 0.375], "Z"),
      yaxis5: lane([0.00, 0.22], "RR"),
    };
  }
  function drawStrip() { Plotly.react("strip-chart", stripTraces(), stripLayout(), PLOTLY_CFG); }
  function makeStrip() { Plotly.newPlot("strip-chart", stripTraces(), stripLayout(), PLOTLY_CFG); }

  // redraw the whole strip on a timer (~14 fps); ECG dominates the point count
  setInterval(drawStrip, 70);

  // ---------- signal-averaged beat (ensemble average of R-aligned segments) ----------
  const AVG_PRE = Math.round(0.20 * FS);    // 50 samples before R  (-200 ms)
  const AVG_POST = Math.round(0.50 * FS);   // 125 samples after R  (+500 ms)
  const AVG_LEN = AVG_PRE + AVG_POST + 1;
  const avgX = [];
  for (let i = 0; i < AVG_LEN; i++) avgX.push(Math.round(((i - AVG_PRE) / FS) * 1000)); // ms
  const segs = [];                 // ring of segments (each length AVG_LEN)
  const pendingBeats = [];         // beat wall-times awaiting segmentation
  function avgN() {
    const el = document.getElementById("avg-n");
    const n = el ? parseInt(el.value, 10) : 50;
    return Math.min(300, Math.max(5, n || 50));
  }
  function ecgBaseline() {
    let s = 0, c = 0; for (const v of ecgY) if (v != null) { s += v; c++; }
    return c ? s / c : 2000;
  }
  function processBeats() {
    const t0 = nowS(), base = ecgBaseline();
    const ripe = AVG_POST / FS + 0.06;      // wait until +POST is in the buffer
    const BACK = Math.round(0.30 * FS), FWD = Math.round(0.05 * FS);
    for (let k = pendingBeats.length - 1; k >= 0; k--) {
      const age = t0 - pendingBeats[k];
      if (age < ripe) continue;
      const xb = pendingBeats[k] - t0;
      pendingBeats.splice(k, 1);
      if (age > 3.0) continue;              // too old, scrolled out
      const ib = Math.round(xb * FS + (ECG_WIN - 1));
      let best = -1, bestv = -1e18;
      for (let j = Math.max(0, ib - BACK); j <= Math.min(ECG_WIN - 1, ib + FWD); j++) {
        const v = ecgY[j]; if (v == null) continue;
        const d = v - base;                 // R peak = max positive deviation
        if (d > bestv) { bestv = d; best = j; }
      }
      if (best < 0) continue;
      const lo = best - AVG_PRE, hi = best + AVG_POST;
      if (lo < 0 || hi >= ECG_WIN) continue;
      const seg = new Array(AVG_LEN); let ok = true;
      for (let i = 0; i < AVG_LEN; i++) { const v = ecgY[lo + i]; if (v == null) { ok = false; break; } seg[i] = v; }
      if (ok) { segs.push(seg); while (segs.length > avgN()) segs.shift(); }
    }
  }
  function avgLayout() {
    return {
      paper_bgcolor: "transparent", plot_bgcolor: "transparent",
      font: { color: COL.text, size: 11 },
      margin: { l: 50, r: 12, t: 6, b: 30 },
      xaxis: { ...AX, title: "ms  (R = 0)", zeroline: true, zerolinecolor: COL.grid },
      yaxis: { ...AX, title: "ECG (avg)" },
      showlegend: false,
    };
  }
  function drawAvg() {
    while (segs.length > avgN()) segs.shift();
    setText("avg-count", segs.length);
    if (!segs.length) return;
    const avg = new Array(AVG_LEN).fill(0);
    for (const seg of segs) for (let i = 0; i < AVG_LEN; i++) avg[i] += seg[i];
    for (let i = 0; i < AVG_LEN; i++) avg[i] /= segs.length;
    Plotly.react("avg-chart",
      [{ x: avgX, y: avg, mode: "lines", line: { color: COL.ecg, width: 2 } }],
      avgLayout(), PLOTLY_CFG);
  }
  function makeAvg() {
    Plotly.newPlot("avg-chart",
      [{ x: avgX, y: avgX.map(() => null), mode: "lines", line: { color: COL.ecg, width: 2 } }],
      avgLayout(), PLOTLY_CFG);
  }
  setInterval(() => { processBeats(); drawAvg(); }, 250);

  // ---------- DOM helpers ----------
  const $ = (id) => document.getElementById(id);
  function setText(id, v) { const e = $(id); if (e) e.textContent = v; }

  function onRr(msg) {
    if (msg.hr != null) setText("hr", msg.hr);
    if (msg.contact) setText("contact", msg.contact);
    if (msg.rr && msg.rr.length) {
      const last = msg.rr[msg.rr.length - 1];
      setText("rr", Math.round(last));
      for (const v of msg.rr) pushRr(v);
    }
  }

  function onEctopy(msg) {
    setText("pvc", msg.pvc);
    setText("pac", msg.pac);
    setText("artifact", msg.artifact);
    setText("burden", (msg.burden_pct != null ? msg.burden_pct : 0).toFixed(1));
    setText("total-beats", msg.total);
    if (msg.type_name && msg.type_name !== "NONE") {
      const log = $("ecto-log");
      const empty = log.querySelector(".ecto-empty");
      if (empty) empty.remove();
      const cls = msg.type_name === "PVC" ? "pvc" : msg.type_name === "PAC" ? "pac" : "art";
      const div = document.createElement("div");
      div.className = "evt " + cls;
      const ts = new Date((msg.t || Date.now() / 1000) * 1000).toLocaleTimeString();
      div.innerHTML = `<span class="tag">${msg.type_name}</span>` +
        `<span>${ts}</span>` +
        `<span class="meta">coupling ${msg.coupling_ms}ms · pause ${msg.pause_ms}ms</span>`;
      log.prepend(div);
      while (log.children.length > 40) log.removeChild(log.lastChild);
    }
  }

  function onBattery(msg) {
    if (msg.pct == null) return;
    setText("batt-pct", msg.pct + "%");
    const fill = $("batt-fill");
    fill.style.width = Math.max(0, Math.min(100, msg.pct)) + "%";
    fill.style.background = msg.pct <= 15 ? "#f85149" : msg.pct <= 35 ? "#d29922" : "#3fb950";
  }

  function onStatus(msg) {
    const el = $("status");
    el.classList.remove("status-on", "status-off", "status-demo");
    let label = msg.state;
    if (msg.state === "connected") { el.classList.add("status-on"); label = "connected" + (msg.detail ? " · " + msg.detail : ""); }
    else if (msg.state === "demo") { el.classList.add("status-demo"); label = "demo mode"; }
    else if (msg.state === "scanning") { el.classList.add("status-off"); label = "scanning…"; }
    else { el.classList.add("status-off"); label = msg.state; }
    setText("status-text", label);
  }

  function handle(msg) {
    switch (msg.type) {
      case "ecg": pushEcg(msg.samples); break;
      case "rr": onRr(msg); break;
      case "accel": pushAccel(msg); break;
      case "ectopy": onEctopy(msg); break;
      case "battery": onBattery(msg); break;
      case "status": onStatus(msg); break;
    }
  }

  // ---------- WebSocket with reconnect ----------
  let ws, retry = 0;
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { retry = 0; };
    ws.onmessage = (ev) => {
      try { handle(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
    };
    ws.onclose = () => {
      onStatus({ state: "off" });
      setText("status-text", "reconnecting…");
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 500 * retry);
    };
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
  }

  // ---------- init ----------
  window.addEventListener("load", () => {
    makeStrip();
    makeAvg();
    connect();
    window.addEventListener("resize", () => {
      if (window.Plotly) Plotly.Plots.resize("strip-chart");
    });
  });
})();
