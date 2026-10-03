/* HRM Raw RR dashboard client.
 * Connects to /ws, keeps rolling ring buffers, and drives (all uPlot / canvas):
 *   - the live strip: ECG + Accel X/Y/Z + RR as stacked lanes on one time axis
 *   - the signal-averaged (R-aligned) beat
 *   - plain DOM for HR, steps, ectopy counts/log and battery.
 *
 * Smooth scrolling: data arrives in bursts (20 ECG samples per BLE packet, BLE
 * batches packets per connection event, and some hosts stall for 1–2 s). Each
 * stream gets a StreamClock (clock.js) that maps sample index -> display time
 * without ever jumping, and the view is rendered every animation frame at
 * (now - playout delay), with the delay adapted to the host's real jitter.
 *
 * Auto-reconnects the WebSocket if the link or the page connection drops.
 */
(() => {
  "use strict";

  const COL = { ecg:"#4bd1a0", beat:"#ff2d2d", rr:"#ff5470", x:"#5aa2ff", y:"#ffb454", z:"#c792ea",
                grid:"#232936", gridMinor:"#1b2029", text:"#8b96a5",
                meas:"#f2f5f8", measFill:"rgba(242,245,248,0.07)", measBox:"rgba(14,17,22,0.85)" };
  const FONT = "11px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

  let FS = 250;              // ECG sample rate (Hz); each ECG message carries the strap's real rate
  const ACC_FS = 25;         // accelerometer rate (Hz, nominal)
  const WIN_DEFAULT = 6;     // visible window (s), zoomable WIN_MIN..WIN_MAX
  const WIN_MIN = 2, WIN_MAX = 60;
  let RING = FS * (WIN_MAX + 4);     // ECG ring buffer: longest window + margin

  const now = () => (performance.timeOrigin + performance.now()) / 1000;
  const $ = (id) => document.getElementById(id);
  function setText(id, v) { const e = $(id); if (e) e.textContent = v; }

  // ---------- ECG ring buffer (continuous client-side sample index) ----------
  let ecgRing = new Float32Array(RING).fill(NaN);
  let ecgFit = new StreamClock(1 / FS, 0.10);     // ±10 %: follows firmware sample loss
  let ecgLast = -1;           // index of newest sample
  let ecgLastBase = null;     // last server `base` (wraps at 65536 packets)
  let ecgLastLen = 0;         // samples in that packet
  let ecgLastArrival = 0;
  const ecgAt = (n) => (n > ecgLast - RING && n <= ecgLast && n >= 0) ? ecgRing[n % RING] : NaN;

  function pushEcg(msg, ta) {
    if (msg.fs && msg.fs !== FS) setEcgRate(msg.fs);
    if (msg.base === ecgLastBase) return;   // repeated packet (strap TX retry): already have it
    const len = msg.samples.length;
    let skip = 0;             // samples missing before this packet
    if (ecgLastBase != null) {
      const wrap = 65536 * len;
      const d = (((msg.base - ecgLastBase) % wrap) + wrap) % wrap;
      if (d !== len) {
        if (d > len && d <= 2 * FS) skip = d - len;          // dropped packets: leave a gap
        else                                                  // restart / reconnect: keep the
          skip = Math.max(0, Math.round((ta - ecgLastArrival - len / FS) * FS));   // index ~ time
      }
    }
    for (let k = 0; k < Math.min(skip, RING); k++) ecgRing[(ecgLast + 1 + k) % RING] = NaN;
    ecgLast += skip;
    for (const s of msg.samples) { ecgLast++; ecgRing[ecgLast % RING] = s; }
    ecgLastBase = msg.base;
    ecgLastLen = len;
    ecgLastArrival = ta;
    ecgFit.add(ecgLast, ta);
  }
  const ecgLive = () => ecgFit.ready && now() - ecgLastArrival < 5;

  // hub ECG index (seq * batch + offset, wraps at 65536 packets) -> client ECG
  // index, relative to the newest ECG packet (valid within the current stream run)
  function hubToClientEcg(hubIdx) {
    if (ecgLastBase == null || !ecgFit.ready) return NaN;
    const wrap = 65536 * ecgLastLen;
    let d = ((ecgLastBase + ecgLastLen - 1 - hubIdx) % wrap + wrap) % wrap;
    if (d > wrap / 2) d -= wrap;             // accel ahead of the last ECG packet
    return Math.abs(d) < 10 * FS ? ecgLast - d : NaN;
  }

  // ---------- accelerometer ring (timestamps from a packet-counter fit) ----------
  const ACC_RING = ACC_FS * (WIN_MAX + 6);
  // accE: the sample's position on the client ECG index (accel v2 firmware reports
  // it), so it is drawn on the ECG clock -- exact and immune to dropped accel
  // packets. NaN -> fall back to the accel packet-counter clock (accI / accFit).
  const accE = new Float64Array(ACC_RING).fill(NaN);
  const accI = new Float64Array(ACC_RING), accX = new Float32Array(ACC_RING),
        accY = new Float32Array(ACC_RING), accZ = new Float32Array(ACC_RING);
  const accFit = new StreamClock(1 / ACC_FS, 0.25);
  const ACC_CH = [["x", accX], ["y", accY], ["z", accZ]];
  let accN = 0, accK = 0;     // stored count, packet counter (no seq in the packet)
  let accLastArrival = 0, accLinkBroken = false;
  function pushAccel(m, ta) {
    if (accLinkBroken && accN > 0) {   // after a real link break, skip the counter by the gap
      accK += Math.max(0, Math.round((ta - accLastArrival) * ACC_FS) - 1);
    }
    accLinkBroken = false;
    accFit.add(accK, ta);
    const j = accN % ACC_RING;
    accI[j] = accK; accX[j] = m.x; accY[j] = m.y; accZ[j] = m.z;
    accE[j] = m.ecg_index != null ? hubToClientEcg(m.ecg_index) : NaN;
    accN++; accK++; accLastArrival = ta;
  }

  // ---------- beats: R-peak snapping, RR points, ensemble average ----------
  // search window around the newest ECG sample at the time the RR event arrived
  // (both share the BLE link, so a stall delays them together)
  let SNAP_BACK = Math.round(0.35 * FS), SNAP_FWD = Math.round(0.12 * FS);
  let AVG_PRE = Math.round(0.20 * FS);      // -200 ms
  let AVG_POST = Math.round(0.50 * FS);     // +500 ms
  let AVG_LEN = AVG_PRE + AVG_POST + 1;
  const pendingBeats = [];  // { ta, rr: [ms...] }  awaiting ECG data around the beat
  const pendingSegs = [];   // R indices awaiting +AVG_POST samples
  const beatDots = [];      // R-peak sample indices (value read back from the ring)
  const rrPts = [];         // { idx } or { t }, plus { v: rr ms }
  const segs = [];          // Float32Array(AVG_LEN) ring for the ensemble average
  let lastR = -1e9;

  // The strap reports its ECG rate (250 Hz on older firmware, 1024 Hz newer).
  // A change re-creates everything indexed by ECG sample; RR points already
  // placed on the old index are converted to absolute times so they stay put.
  function setEcgRate(fs) {
    if (ecgFit.ready) {
      for (const p of rrPts) if (p.t == null) { p.t = ecgFit.t(p.idx); delete p.idx; }
    } else {
      rrPts.length = 0;
    }
    const oldDelay = ecgFit.delay;
    FS = fs;
    RING = FS * (WIN_MAX + 4);
    ecgRing = new Float32Array(RING).fill(NaN);
    ecgFit = new StreamClock(1 / FS, 0.10);
    ecgFit.delay = oldDelay;                 // keep the playout delay: no jump in the view
    ecgLast = -1; ecgLastBase = null; ecgLastLen = 0; ecgLastArrival = 0;
    accE.fill(NaN);                          // accel ECG positions referred to the old index space
    SNAP_BACK = Math.round(0.35 * FS); SNAP_FWD = Math.round(0.12 * FS);
    AVG_PRE = Math.round(0.20 * FS); AVG_POST = Math.round(0.50 * FS);
    AVG_LEN = AVG_PRE + AVG_POST + 1;
    avgX = Array.from({ length: AVG_LEN }, (_, i) => Math.round((i - AVG_PRE) / FS * 1000));
    pendingBeats.length = 0; pendingSegs.length = 0; beatDots.length = 0; segs.length = 0;
    lastR = -1e9;
    if (avgPlot) avgPlot.setData([avgX, avgX.map(() => null)]);
    setText("avg-count", 0);
    setText("ecg-fs", fsLabel());
  }

  function onRr(msg) {
    if (msg.hr != null) setText("hr", msg.hr);
    if (msg.contact) setText("contact", msg.contact);
    if (msg.rr && msg.rr.length) {
      setText("rr", Math.round(msg.rr[msg.rr.length - 1]));
      stream("rr", msg.rr.slice());
      hrvAdd(msg.rr);
    }
  }

  // ---------- HRV (time domain) over a rolling window of firmware RR intervals ----------
  // Standard short-term metrics: RMSSD (successive differences), SDNN, pNN50.
  // Artifact/ectopy rejection: RR outside 300–2000 ms or changing > 20 % from the
  // previous RR is excluded, and successive differences only use two consecutive
  // accepted beats (so an ectopic beat drops both of its intervals). A pause of
  // more than 3 s (lost link) breaks the chain.
  const HRV_WIN = 300, HRV_MIN_S = 30;   // 5 min window, first value after 30 s
  const hrvBeats = [];                   // { t, rr, ok, chain }  chain: diff to previous is valid
  let hrvPrev = null;
  function hrvAdd(rrs) {
    const tArr = now();
    // several RRs in one notification: the last beat is "now", earlier ones step back
    const times = rrs.map(() => tArr);
    for (let k = rrs.length - 2; k >= 0; k--) times[k] = times[k + 1] - rrs[k + 1] / 1000;
    rrs.forEach((rr, k) => {
      const t = times[k], prev = hrvPrev;
      const linked = prev && t - prev.t < rr / 1000 + 3;
      const ok = rr >= 300 && rr <= 2000 && (!linked || Math.abs(rr - prev.rr) <= 0.2 * prev.rr);
      const beat = { t, rr, ok, chain: ok && linked && prev.ok };
      hrvBeats.push(beat);
      hrvPrev = beat;
    });
    while (hrvBeats.length && hrvBeats[0].t < tArr - HRV_WIN) hrvBeats.shift();
    hrvUpdate();
  }
  function hrvUpdate() {
    const good = hrvBeats.filter((b) => b.ok);
    const span = hrvBeats.length ? hrvBeats[hrvBeats.length - 1].t - hrvBeats[0].t : 0;
    if (good.length < 10 || span < HRV_MIN_S) {
      setText("hrv", "--");
      setText("hrv-sub", `collecting… ${Math.round(span)} / ${HRV_MIN_S} s`);
      return;
    }
    let sumSq = 0, nDiff = 0, nn50 = 0;
    for (let i = 1; i < hrvBeats.length; i++) {
      if (!hrvBeats[i].chain) continue;
      const d = hrvBeats[i].rr - hrvBeats[i - 1].rr;
      sumSq += d * d; nDiff++;
      if (Math.abs(d) > 50) nn50++;
    }
    const mean = good.reduce((a, b) => a + b.rr, 0) / good.length;
    const sdnn = Math.sqrt(good.reduce((a, b) => a + (b.rr - mean) ** 2, 0) / (good.length - 1));
    const rmssd = nDiff ? Math.sqrt(sumSq / nDiff) : NaN;
    setText("hrv", Number.isFinite(rmssd) ? Math.round(rmssd) : "--");
    const win = span < HRV_WIN - 5 ? `${Math.round(span)} s` : "5 min";
    setText("hrv-sub", `SDNN ${Math.round(sdnn)} ms · pNN50 ${nDiff ? Math.round(100 * nn50 / nDiff) : 0} % · ` +
                       `${good.length} beats / ${win}` +
                       (good.length < hrvBeats.length ? ` · ${hrvBeats.length - good.length} excluded` : ""));
  }

  // place RR values ending at beat position `end` (sample index or time)
  function placeRr(rr, end, byIdx) {
    let pos = end;
    for (let k = rr.length - 1; k >= 0; k--) {
      rrPts.push(byIdx ? { idx: pos, v: rr[k] } : { t: pos, v: rr[k] });
      pos -= byIdx ? rr[k] / 1000 * FS : rr[k] / 1000;
    }
    rrPts.sort((p, q) => xOfPt(p) - xOfPt(q));
  }
  const xOfPt = (p) => p.t != null ? p.t : ecgFit.t(p.idx);

  function localBaseline(n) {
    let s = 0, c = 0;
    for (let j = n - 2 * FS; j <= n; j++) { const v = ecgAt(j); if (v === v) { s += v; c++; } }
    return c ? s / c : 0;
  }

  function processBeats() {
    const tnow = now();
    for (let k = 0; k < pendingBeats.length; ) {
      const b = pendingBeats[k];
      const nb = b.nb;
      if (!ecgLive() || nb < 0) {                     // no ECG: plot RR at arrival time
        placeRr(b.rr, b.ta, false); pendingBeats.splice(k, 1); continue;
      }
      if (ecgLast < nb + SNAP_FWD) { k++; continue; } // wait for the samples after the beat
      pendingBeats.splice(k, 1);
      const base = localBaseline(nb);
      let best = -1, bestv = -Infinity;
      for (let j = nb - SNAP_BACK; j <= nb + SNAP_FWD; j++) {
        const v = ecgAt(j);
        if (v === v && v - base > bestv) { bestv = v - base; best = j; }
      }
      if (best < 0) { placeRr(b.rr, b.ta, false); continue; }
      placeRr(b.rr, best, true);
      if (best - lastR > 0.2 * FS) { beatDots.push(best); pendingSegs.push(best); lastR = best; }
    }
    for (let k = 0; k < pendingSegs.length; ) {
      const r = pendingSegs[k];
      if (ecgLast < r + AVG_POST) { k++; continue; }
      pendingSegs.splice(k, 1);
      const seg = new Float32Array(AVG_LEN);
      let ok = true;
      for (let i = 0; i < AVG_LEN; i++) { const v = ecgAt(r - AVG_PRE + i); if (v !== v) { ok = false; break; } seg[i] = v; }
      if (ok) segs.push(seg);
    }
    while (beatDots.length && beatDots[0] <= ecgLast - RING) beatDots.shift();
    const tOld = tnow - delayNow - WIN_MAX - 2;
    while (rrPts.length && xOfPt(rrPts[0]) < tOld) rrPts.shift();
  }

  // ---------- smoothed y-ranges (expand at once, shrink slowly) ----------
  function autoRange(minSpan, pad = 0.12) {
    const r = { lo: null, hi: null };
    return (dmin, dmax) => {
      if (!(dmax >= dmin)) return r.lo == null ? { min: 0, max: 1 } : { min: r.lo, max: r.hi };
      const mid = (dmin + dmax) / 2, half = Math.max(dmax - dmin, minSpan) * (0.5 + pad);
      const lo = mid - half, hi = mid + half;
      if (r.lo == null) { r.lo = lo; r.hi = hi; }
      else {
        r.lo = lo < r.lo ? lo : r.lo + (lo - r.lo) * 0.04;
        r.hi = hi > r.hi ? hi : r.hi + (hi - r.hi) * 0.04;
      }
      return { min: r.lo, max: r.hi };
    };
  }

  // ---------- strip chart: stacked uPlot lanes sharing one x (unix seconds) ----------
  const clockCache = new Map();
  function fmtClock(v, tenths) {
    const s = Math.round(v * 10) / 10;
    const key = tenths ? "t" + s : Math.round(s);
    let str = clockCache.get(key);
    if (str == null) {
      str = new Date(Math.floor(s) * 1000).toLocaleTimeString([], { hour12: false });
      if (tenths) str += "." + Math.round((s - Math.floor(s)) * 10) % 10;
      if (clockCache.size > 400) clockCache.clear();
      clockCache.set(key, str);
    }
    return str;
  }
  // tick labels: tenths of a second only when the tick step is below 1 s
  const clockValues = (u, splits) => {
    const tenths = splits.length > 1 && splits[1] - splits[0] < 0.99;
    return splits.map((v) => fmtClock(v, tenths));
  };

  const LANES = [
    { key: "ecg", label: "ECG", h: 240, color: COL.ecg, width: 1.2, minSpan: 200, paper: true },
    { key: "x",   label: "X",   h: 66,  color: COL.x,   width: 1,   minSpan: 400 },
    { key: "y",   label: "Y",   h: 66,  color: COL.y,   width: 1,   minSpan: 400 },
    { key: "z",   label: "Z",   h: 66,  color: COL.z,   width: 1,   minSpan: 400 },
    { key: "rr",  label: "RR ms", h: 140, color: COL.rr, width: 1.4, minSpan: 80, bottom: true },
  ];

  function laneOpts(L, width) {
    const axisBase = { stroke: COL.text, font: FONT, ticks: { show: false } };
    const axes = [
      { ...axisBase, scale: "x", space: L.bottom ? 70 : 60, incrs: [0.2, 0.5, 1, 2, 5, 10, 15, 30],
        grid: { stroke: COL.grid, width: 1 },
        values: L.bottom ? clockValues : (u, splits) => splits.map(() => ""),
        size: L.bottom ? 26 : 0 },
      { ...axisBase, scale: "y", label: L.label, labelSize: 14, labelFont: FONT, size: 50, space: L.h < 100 ? 22 : 35,
        grid: { stroke: COL.grid, width: 1 } },
    ];
    if (L.paper) {  // ECG-paper style fine grid: 40 ms / 200 ms as zoom allows (grid only)
      axes.unshift({ scale: "x", side: 2, size: 0, incrs: [0.04, 0.2, 1, 5], space: 8,
                     grid: { stroke: COL.gridMinor, width: 1 }, ticks: { show: false }, values: () => [] });
    }
    const series = [{}, { stroke: L.color, width: L.width, spanGaps: false, points: { show: false } }];
    if (L.key === "rr") series[1].points = { show: true, size: 5, fill: COL.rr, stroke: COL.rr };
    const hooks = { draw: [(u) => drawMeasure(u, L.key === "ecg")] };
    if (L.key === "ecg") hooks.draw.unshift(drawBeatDots);
    return {
      width, height: L.h, legend: { show: false }, pxAlign: 0,
      padding: [4, 8, L.bottom ? 0 : 4, 0],
      cursor: { sync: { key: "strip" }, y: false, points: { show: false },
                drag: { x: false, y: false, setScale: false } },
      scales: { x: { time: false, auto: false }, y: { auto: false } },
      axes, series, hooks,
    };
  }

  function drawBeatDots(u) {
    if (!beatDots.length) return;
    const ctx = u.ctx, { left, top, width, height } = u.bbox;
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    ctx.fillStyle = COL.beat;
    const r = 3.5 * devicePixelRatio;
    for (const n of beatDots) {
      const v = ecgAt(n);
      if (v !== v) continue;
      const px = u.valToPos(ecgFit.t(n), "x", true), py = u.valToPos(v, "y", true);
      ctx.beginPath(); ctx.arc(px, py, r, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.restore();
  }

  // measurement overlay: A/B lines (or A + the cursor while placing B), shaded
  // span on every lane, Δt label on the ECG lane
  function drawMeasure(u, withLabel) {
    const a = meas.a;
    const b = meas.b != null ? meas.b : (measureMode && hoverT != null ? hoverT : null);
    if (a == null) return;
    const ctx = u.ctx, { left, top, width, height } = u.bbox, dpr = devicePixelRatio;
    const xa = u.valToPos(a, "x", true), xb = b != null ? u.valToPos(b, "x", true) : null;
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    if (xb != null) {
      ctx.fillStyle = COL.measFill;
      ctx.fillRect(Math.min(xa, xb), top, Math.abs(xb - xa), height);
    }
    ctx.strokeStyle = COL.meas; ctx.lineWidth = dpr;
    ctx.setLineDash(meas.b == null ? [4 * dpr, 3 * dpr] : []);
    for (const x of xb != null ? [xa, xb] : [xa]) {
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
    }
    if (withLabel && xb != null && b !== a && Math.max(xa, xb) > left && Math.min(xa, xb) < left + width) {
      const txt = measText(a, b);
      ctx.setLineDash([]);
      ctx.font = `600 ${12 * dpr}px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif`;
      const tw = ctx.measureText(txt).width, pad = 6 * dpr, bh = 20 * dpr;
      let x = (xa + xb) / 2 - tw / 2 - pad;
      x = Math.max(left + 2 * dpr, Math.min(left + width - tw - 2 * pad - 2 * dpr, x));
      const y = top + 4 * dpr;
      ctx.fillStyle = COL.measBox; ctx.fillRect(x, y, tw + 2 * pad, bh);
      ctx.fillStyle = COL.meas; ctx.textBaseline = "middle"; ctx.textAlign = "left";
      ctx.fillText(txt, x + pad, y + bh / 2);
    }
    ctx.restore();
  }
  function measText(a, b) {
    const ms = Math.abs(b - a) * 1000;
    return `Δt ${ms < 10000 ? ms.toFixed(0) + " ms" : (ms / 1000).toFixed(2) + " s"}` +
           (ms > 0 ? ` · ${(60000 / ms).toFixed(1)} bpm` : "");
  }

  const lanes = {};     // key -> { u, range }
  function makeStrip() {
    const host = $("strip-chart");
    const w = host.clientWidth;
    for (const L of LANES) {
      const div = document.createElement("div");
      div.className = "lane";
      host.appendChild(div);
      lanes[L.key] = { u: new uPlot(laneOpts(L, w), [[], []], div), range: autoRange(L.minSpan) };
    }
  }

  // reusable plain arrays (uPlot needs null for gaps, typed arrays can't hold it)
  const ecgXs = [], ecgYs = [], accXs = [], accVs = { x: [], y: [], z: [] };
  function update(key, data, xr, dmin, dmax) {
    const lane = lanes[key];
    lane.u.batch(() => {
      lane.u.setData(data, false);
      lane.u.setScale("x", xr);
      lane.u.setScale("y", lane.range(dmin, dmax));
    });
  }

  function drawStrip() {
    stepZoom();
    const tEnd = paused ? viewEnd : now() - delayNow, tStart = tEnd - win;
    const xr = { min: tStart, max: tEnd };

    // ECG: visible index range from the clock fit (+1 sample margin each side)
    ecgXs.length = 0; ecgYs.length = 0;
    let emin = Infinity, emax = -Infinity;
    if (ecgFit.ready) {
      const i0 = Math.max(ecgLast - RING + 1, Math.floor(ecgFit.idx(tStart)) - 1, 0);
      const i1 = Math.min(ecgLast, Math.ceil(ecgFit.idx(tEnd)) + 1);
      // zoomed out: min/max per bucket (~1 bucket per pixel) keeps every R peak
      // but caps the point count. Buckets are aligned to the absolute sample
      // index so they don't shimmer while the trace scrolls.
      const bucket = Math.max(1, Math.floor((i1 - i0 + 1) / lanes.ecg.u.bbox.width * devicePixelRatio));
      if (bucket === 1) {
        for (let n = i0; n <= i1; n++) {
          const v = ecgRing[n % RING];
          ecgXs.push(ecgFit.t(n));
          if (v === v) { ecgYs.push(v); if (v < emin) emin = v; if (v > emax) emax = v; }
          else ecgYs.push(null);
        }
      } else {
        for (let b = i0 - (i0 % bucket); b <= i1; b += bucket) {
          let lo = Infinity, hi = -Infinity, nlo = b, nhi = b, gap = false;
          for (let n = Math.max(b, i0); n < b + bucket && n <= i1; n++) {
            const v = ecgRing[n % RING];
            if (v !== v) { gap = true; continue; }
            if (v < lo) { lo = v; nlo = n; }
            if (v > hi) { hi = v; nhi = n; }
          }
          if (gap || lo > hi) { ecgXs.push(ecgFit.t(b)); ecgYs.push(null); }
          if (lo > hi) continue;
          const [na, va, nb, vb] = nlo <= nhi ? [nlo, lo, nhi, hi] : [nhi, hi, nlo, lo];
          ecgXs.push(ecgFit.t(na)); ecgYs.push(va);
          if (nb !== na) { ecgXs.push(ecgFit.t(nb)); ecgYs.push(vb); }
          if (lo < emin) emin = lo; if (hi > emax) emax = hi;
        }
      }
    }
    update("ecg", [ecgXs, ecgYs], xr, emin, emax);

    // accelerometer: walk back from the newest sample
    accXs.length = 0; accVs.x.length = 0; accVs.y.length = 0; accVs.z.length = 0;
    const mm = { x: [Infinity, -Infinity], y: [Infinity, -Infinity], z: [Infinity, -Infinity] };
    const accT = (k) => {
      const j = k % ACC_RING, e = accE[j];
      return e === e ? ecgFit.t(e) : accFit.t(accI[j]);
    };
    let first = accN;
    while (first > 0 && accN - first < ACC_RING && accT(first - 1) >= tStart - 0.1) first--;
    if (first > 0 && accN - first < ACC_RING) first--;   // one sample left of the edge
    for (let k = first; k < accN; k++) {
      const j = k % ACC_RING, x = accT(k);
      if (x > tEnd + 0.1) break;
      // missing accel packets (strap drops accel first when its TX queue fills):
      // break the line instead of drawing a straight segment across the gap
      if (accXs.length && x - accXs[accXs.length - 1] > 3 / ACC_FS) {
        accXs.push((x + accXs[accXs.length - 1]) / 2);
        for (const c of ["x", "y", "z"]) accVs[c].push(null);
      }
      accXs.push(x);
      for (const [c, arr] of ACC_CH) {
        const v = arr[j]; accVs[c].push(v);
        if (v < mm[c][0]) mm[c][0] = v; if (v > mm[c][1]) mm[c][1] = v;
      }
    }
    for (const c of ["x", "y", "z"]) update(c, [accXs, accVs[c]], xr, mm[c][0], mm[c][1]);

    // RR points (the line is drawn beat to beat)
    const rx = [], ry = [];
    let rmin = Infinity, rmax = -Infinity;
    for (const p of rrPts) {
      const x = xOfPt(p);
      if (x < tStart - 3 || x > tEnd + 1) continue;
      rx.push(x); ry.push(p.v);
      if (p.v < rmin) rmin = p.v; if (p.v > rmax) rmax = p.v;
    }
    update("rr", [rx, ry], xr, rmin, rmax);
  }

  // ---------- signal-averaged beat ----------
  let avgX = Array.from({ length: AVG_LEN }, (_, i) => Math.round((i - AVG_PRE) / FS * 1000));
  let avgPlot = null;
  function avgN() {
    const n = parseInt($("avg-n")?.value, 10);
    return Math.min(300, Math.max(5, n || 50));
  }
  function makeAvg() {
    const host = $("avg-chart");
    avgPlot = new uPlot({
      width: host.clientWidth, height: host.clientHeight || 300, legend: { show: false },
      padding: [6, 12, 0, 0],
      cursor: { y: false, drag: { x: false, y: false, setScale: false } },
      scales: { x: { time: false } },
      axes: [
        { stroke: COL.text, font: FONT, grid: { stroke: COL.grid }, ticks: { show: false },
          label: "ms  (R = 0)", labelSize: 18, labelFont: FONT },
        { stroke: COL.text, font: FONT, grid: { stroke: COL.grid }, ticks: { show: false },
          label: "ECG (avg)", labelSize: 14, labelFont: FONT, size: 50 },
      ],
      series: [{}, { stroke: COL.ecg, width: 2, points: { show: false } }],
    }, [avgX, avgX.map(() => null)], host);
  }
  function drawAvg() {
    while (segs.length > avgN()) segs.shift();
    setText("avg-count", segs.length);
    if (!segs.length) return;
    const avg = new Array(AVG_LEN).fill(0);
    for (const seg of segs) for (let i = 0; i < AVG_LEN; i++) avg[i] += seg[i];
    for (let i = 0; i < AVG_LEN; i++) avg[i] /= segs.length;
    avgPlot.setData([avgX, avg]);
  }

  // ---------- render loop ----------
  // playout delay: the larger of the streams' adaptive delays (slewed, never jumps)
  let delayNow = 0.35, lastFrame = null;
  function frame() {
    const t = now(), dt = lastFrame == null ? 0 : Math.min(0.1, t - lastFrame);
    lastFrame = t;
    if (!paused) {
      delayNow = Math.max(ecgFit.displayDelay(t, dt), accFit.ready ? accFit.displayDelay(t, dt) : 0);
      processBeats();              // frozen view: keep beats/RR exactly as they were
    }
    drawStrip();
    requestAnimationFrame(frame);
  }
  setInterval(drawAvg, 250);

  // ---------- x zoom: wheel / pinch / buttons change the window length ----------
  let winTarget = WIN_DEFAULT;
  try { winTarget = clampWin(parseFloat(localStorage.getItem("hrm.win")) || WIN_DEFAULT); } catch (e) {}
  let win = winTarget;
  function clampWin(w) { return Math.min(WIN_MAX, Math.max(WIN_MIN, w)); }
  function setWin(w) {
    winTarget = clampWin(w);
    setText("win-label", (winTarget < 10 ? winTarget.toFixed(1) : Math.round(winTarget)) + " s");
    try { localStorage.setItem("hrm.win", String(winTarget)); } catch (e) {}
  }
  function stepZoom() {   // ease toward the targets so zoom/pan animate
    // win and viewEnd ease with the same factor, so a cursor-anchored zoom keeps
    // the time under the cursor fixed throughout the animation
    win = Math.abs(winTarget - win) < 0.002 ? winTarget : win + (winTarget - win) * 0.25;
    viewEnd = Math.abs(viewEndTarget - viewEnd) < 0.0005 ? viewEndTarget : viewEnd + (viewEndTarget - viewEnd) * 0.25;
  }
  // zoom by factor k; while paused, keep the time under the cursor (tc) in place
  function zoomBy(k, tc) {
    const old = winTarget;
    setWin(winTarget * k);
    if (paused) {
      if (tc == null) tc = viewEndTarget - old / 2;
      viewEndTarget = clampViewEnd(tc + (viewEndTarget - tc) * (winTarget / old));
    }
  }
  function initZoom() {
    const host = $("strip-chart");
    host.addEventListener("wheel", (e) => {
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
      zoomBy(Math.exp(dy * 0.002), timeAt(e.clientX));  // one mouse notch ≈ ×1.22
    }, { passive: false });
    host.addEventListener("dblclick", () => { if (!measureMode) zoomBy(WIN_DEFAULT / winTarget); });
    $("zoom-in").addEventListener("click", () => zoomBy(1 / 1.5));
    $("zoom-out").addEventListener("click", () => zoomBy(1.5));
    setWin(winTarget);
  }

  // ---------- pause: freeze the view, queue incoming stream data, replay on resume ----------
  let paused = false, pausedAt = 0, viewEnd = 0, viewEndTarget = 0;
  let pauseQueue = [];
  const PAUSE_QUEUE_MAX = 150000;    // ~1 h of ECG+accel+RR messages

  function stream(kind, msg) {
    const ta = now();
    if (paused) {
      pauseQueue.push([kind, msg, ta]);
      if (pauseQueue.length > PAUSE_QUEUE_MAX) pauseQueue.splice(0, pauseQueue.length - PAUSE_QUEUE_MAX);
    } else applyStream(kind, msg, ta);
  }
  function applyStream(kind, msg, ta) {
    if (kind === "ecg") pushEcg(msg, ta);
    else if (kind === "accel") pushAccel(msg, ta);
    else if (kind === "rr") pendingBeats.push({ ta, rr: msg, nb: ecgLast });
    else if (kind === "link") accLinkBroken = true;
  }

  function oldestTime() {
    return ecgFit.ready ? ecgFit.t(Math.max(0, ecgLast - RING + 1)) : pausedAt - WIN_MAX;
  }
  function clampViewEnd(t) {
    return Math.min(pausedAt, Math.max(oldestTime() + winTarget, t));
  }

  function setPaused(p) {
    if (p === paused) return;
    if (p) {
      pausedAt = now() - delayNow;
      viewEnd = viewEndTarget = pausedAt;
      paused = true;
    } else {
      paused = false;
      const q = pauseQueue; pauseQueue = [];
      for (const [kind, msg, ta] of q) applyStream(kind, msg, ta);
    }
    const btn = $("pause-btn");
    btn.textContent = paused ? "▶ Live" : "⏸ Pause";
    btn.classList.toggle("active", paused);
    $("strip-card").classList.toggle("paused", paused);
    updateCursor();
  }

  // ---------- measurement tool ----------
  let measureMode = false, hoverT = null;
  const meas = { a: null, b: null };

  // client x (px) -> time on the shared strip x axis, or null outside the plot area
  function timeAt(clientX) {
    const u = lanes.ecg && lanes.ecg.u;
    if (!u) return null;
    const r = u.over.getBoundingClientRect();
    const x = clientX - r.left;
    return x >= 0 && x <= r.width ? u.posToVal(x, "x") : null;
  }
  function setMeasureMode(on) {
    measureMode = on;
    $("measure-btn").classList.toggle("active", on);
    if (!on) hoverT = null;
    updateCursor();
    updateReadout();
  }
  function clearMeasure() { meas.a = meas.b = null; updateReadout(); }
  function updateReadout() {
    const el = $("meas-readout");
    if (meas.a != null && meas.b != null) el.textContent = measText(meas.a, meas.b);
    else if (measureMode) el.textContent = meas.a == null ? "click the start point" : "click the end point";
    else el.textContent = "";
  }
  function updateCursor() {
    $("strip-chart").style.cursor = measureMode ? "crosshair" : paused ? "grab" : "";
  }

  // drag = pan (pauses a live view); a click without movement places a marker
  function initPauseMeasure() {
    const host = $("strip-chart");
    let drag = null;
    host.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      drag = { x0: e.clientX, end0: null, moved: false };
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      const r = host.getBoundingClientRect();
      hoverT = e.clientY >= r.top && e.clientY <= r.bottom ? timeAt(e.clientX) : null;
      if (!drag) return;
      const dx = e.clientX - drag.x0;
      if (!drag.moved && Math.abs(dx) < 4) return;
      if (!drag.moved) {
        drag.moved = true;
        setPaused(true);
        drag.end0 = viewEndTarget;
        host.style.cursor = "grabbing";
      }
      const pxW = lanes.ecg.u.bbox.width / devicePixelRatio;
      viewEnd = viewEndTarget = clampViewEnd(drag.end0 - dx * win / pxW);
    });
    window.addEventListener("mouseup", (e) => {
      if (!drag) return;
      const wasClick = !drag.moved;
      drag = null;
      updateCursor();
      if (!wasClick || !measureMode) return;
      const t = timeAt(e.clientX);
      if (t == null) return;
      if (meas.a == null || meas.b != null) { meas.a = t; meas.b = null; }
      else meas.b = t;
      updateReadout();
    });
    host.addEventListener("mouseleave", () => { hoverT = null; });

    $("pause-btn").addEventListener("click", () => setPaused(!paused));
    $("measure-btn").addEventListener("click", () => setMeasureMode(!measureMode));
    document.addEventListener("keydown", (e) => {
      if (e.target.closest && e.target.closest("input, textarea, select, button")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === " ") { e.preventDefault(); setPaused(!paused); }
      else if (e.key === "m" || e.key === "M") setMeasureMode(!measureMode);
      else if (e.key === "Escape") { if (meas.a != null) clearMeasure(); else setMeasureMode(false); }
    });
  }

  function resize() {
    const w = $("strip-chart").clientWidth;
    for (const L of LANES) lanes[L.key].u.setSize({ width: w, height: L.h });
    const a = $("avg-chart");
    if (avgPlot) avgPlot.setSize({ width: a.clientWidth, height: a.clientHeight || 300 });
  }

  // ---------- DOM panels ----------
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

  // ---------- connection: status, device picker, connect / disconnect / scan ----------
  let status = { state: "starting" };
  let devices = [], devScanning = false, userPicked = false;
  const AUTO = "";   // select value for "auto: find by name"

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function statusLabel() {
    const s = status;
    switch (s.state) {
      case "connected": return "connected" + (s.detail ? " · " + s.detail : "");
      case "connecting": return "connecting" + (s.detail ? " · " + s.detail : "") + "…";
      case "scanning": return "scanning for " + targetName() + "…";
      case "waiting": {
        const left = Math.max(0, Math.round((s.next_scan || 0) - Date.now() / 1000));
        return `not found · next scan in ${left} s`;
      }
      case "idle": return "disconnected";
      case "disconnected": return "link lost · reconnecting…";
      case "demo": return "demo mode";
      case "error": return s.detail || "error";
      default: return s.state;
    }
  }
  function targetName() {
    const t = status.target;
    if (!t) return "strap";
    return t.auto ? `“${t.name}”` : (t.name || t.address);
  }

  function onStatus(msg) {
    if (!["connected", "demo"].includes(msg.state) && ["connected", "demo"].includes(status.state))
      stream("link", null);        // ordered with the data, so a paused replay sees it too
    status = msg;
    const el = $("status");
    el.classList.remove("status-on", "status-off", "status-demo", "status-wait", "status-idle");
    el.classList.add({ connected: "status-on", demo: "status-demo", scanning: "status-wait",
                       connecting: "status-wait", waiting: "status-wait", idle: "status-idle" }[msg.state]
                     || "status-off");
    setText("status-text", statusLabel());
    renderDevices();
  }
  setInterval(() => { if (status.state === "waiting") setText("status-text", statusLabel()); }, 1000);

  // connection parameters the strap reports (a1b20004)
  let link = null;
  function onLink(msg) {
    link = msg;
    setText("ecg-fs", fsLabel());
    if (msg.vdd_min_mv != null) {   // strap supply: resting max and TX-burst dip since the last reading
      $("battery").title = `VDD ${(msg.vdd_max_mv / 1000).toFixed(2)} V resting, ` +
                           `dips to ${(msg.vdd_min_mv / 1000).toFixed(2)} V under radio load (last minute)`;
      setText("batt-vdd", `${(msg.vdd_min_mv / 1000).toFixed(2)}–${(msg.vdd_max_mv / 1000).toFixed(2)} V`);
    }
  }
  function fsLabel() {
    return FS + " Hz" + (link ? ` · CI ${link.interval_ms} ms · MTU ${link.mtu}` : "") +
      (link && link.conn_count > 1 ? ` · ⚠ ${link.conn_count} hosts connected` : "");
  }

  function onDevices(msg) {
    devices = msg.devices || [];
    devScanning = !!msg.scanning;
    renderDevices();
  }

  function renderDevices() {
    const sel = $("dev-select");
    const t = status.target || {};
    const current = t.auto === false ? t.address : AUTO;
    const keep = userPicked ? sel.value : current;
    const opts = [[AUTO, `Auto · find “${(t.auto !== false && t.name) || "HRM Raw RR"}” by name`, ""]];
    const listed = new Set();
    for (const d of devices) {
      listed.add(d.address);
      const nm = d.name || "(unnamed)";
      opts.push([d.address, `${d.strap ? "★ " : ""}${nm} · ${d.address} · ${d.rssi} dBm`, d.name || ""]);
    }
    if (t.auto === false && t.address && !listed.has(t.address))
      opts.push([t.address, `${t.name || "(saved)"} · ${t.address} · not seen`, t.name || ""]);
    if (keep && keep !== AUTO && !opts.some((o) => o[0] === keep))
      opts.push([keep, `${keep} · not seen`, ""]);
    sel.replaceChildren(...opts.map(([v, label, name]) => {
      const o = document.createElement("option");
      o.value = v; o.textContent = label; o.dataset.name = name;
      return o;
    }));
    sel.value = keep;

    const enabled = status.enabled !== false;
    const scanning = devScanning || status.state === "scanning";
    $("scan-btn").textContent = scanning ? "Scanning…" : "⟳ Scan";
    $("scan-btn").disabled = scanning;
    $("disc-btn").disabled = !enabled;
    // Connect is useful when idle, or to switch to a different target
    $("conn-btn").disabled = enabled && sel.value === current;
  }

  function initDevicePicker() {
    const sel = $("dev-select");
    sel.addEventListener("change", () => { userPicked = true; renderDevices(); });
    $("conn-btn").addEventListener("click", () => {
      const opt = sel.selectedOptions[0];
      send({ cmd: "connect", address: sel.value || null, name: opt ? opt.dataset.name : "" });
      userPicked = false;
    });
    $("disc-btn").addEventListener("click", () => send({ cmd: "disconnect" }));
    $("take-raw").addEventListener("click", () => send({ cmd: "take_raw" }));
    $("scan-btn").addEventListener("click", () => { devScanning = true; renderDevices(); send({ cmd: "scan" }); });
    renderDevices();
  }

  function handle(msg) {
    switch (msg.type) {
      case "ecg": stream("ecg", msg); break;
      case "rr": onRr(msg); break;
      case "accel": setText("steps", msg.steps); stream("accel", msg); break;
      case "ectopy": onEctopy(msg); break;
      case "battery": onBattery(msg); break;
      case "status": onStatus(msg); break;
      case "devices": onDevices(msg); break;
      case "link": onLink(msg); break;
      case "raw": $("raw-note").hidden = msg.state !== "other"; break;
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

  // handle for poking at the clocks from the devtools console
  window.hrmDebug = { get ecgFit() { return ecgFit; }, accFit, fs: () => FS,
                      delay: () => delayNow, paused: () => paused };

  // ---------- init ----------
  window.addEventListener("load", () => {
    makeStrip();
    makeAvg();
    initZoom();
    initPauseMeasure();
    initDevicePicker();
    connect();
    new ResizeObserver(resize).observe($("strip-chart"));
    requestAnimationFrame(frame);
  });
})();
