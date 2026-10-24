/* HRM Raw RR dashboard client.
 * Connects to /ws, keeps rolling ring buffers, and drives (all uPlot / canvas):
 *   - the live strip: ECG + accelerometer (X/Y/Z, rotation rate, |a|) as stacked
 *     lanes on one time axis
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

  const COL = { ecg:"#4bd1a0", beat:"#ff2d2d", rr:"#ff5470", x:"#5aa2ff", y:"#ffb454", z:"#c792ea", rot:"#f78c6c", mag:"#7fdbca",
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
  // DOM text is written only when it changes: an unchanged value costs nothing
  // (no style recalculation, layout or repaint of the surrounding card)
  const textShown = new Map();
  function setText(id, v) {
    v = String(v);
    if (textShown.get(id) === v) return;
    const e = $(id);
    if (e) { e.textContent = v; textShown.set(id, v); }
  }

  // troubleshooting switches in the page URL:
  //   ?fps=N   chart redraw rate (default 30: about half the GPU load of 60 and
  //            the scrolling still looks continuous; ?fps=60 for the full rate)
  //   ?sw=0    GPU-accelerated canvases. The default is software rendering:
  //            with one-device-pixel traces it costs the same CPU in total, and
  //            Chrome's GPU process does not pile up ~500 MB of canvas caches
  //            (measured on a 2016 MacBook Pro: 118 MB flat instead of 420 -> 670 MB)
  const URL_OPT = new URLSearchParams(location.search);
  const FRAME_MIN = 1 / Math.min(240, Math.max(5, +URL_OPT.get("fps") || 30)) - 0.003;
  //   ?lw=N   ECG trace width of the live strip in CSS px (default: one device pixel)
  // Strokes wider than one device pixel are what costs: on a 2016 MacBook Pro
  // (Retina) the 1.2 px traces kept one core busy in Chrome's GPU process and
  // the strip at ~38 fps; one-device-pixel lines run at a steady 60.
  const LINE_W = Math.min(4, Math.max(0, +URL_OPT.get("lw"))) || 1 / devicePixelRatio;
  const ACC_W = Math.min(LINE_W, 1);      // the accelerometer lanes stay at 1 px at most
  if (URL_OPT.get("sw") !== "0") {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, opts) {
      return getContext.call(this, type, type === "2d" ? { ...opts, willReadFrequently: true } : opts);
    };
  }

  // ---------- ECG ring buffer (continuous client-side sample index) ----------
  // ecgRaw: samples as received (the CSV is written server-side, always raw).
  // ecgRing: what is displayed / used for beat dots and the averaged beat --
  // ecgRaw through the optional mains notch.
  let ecgRaw = new Float32Array(RING).fill(NaN);
  let ecgRing = new Float32Array(RING).fill(NaN);
  let ecgFit = new StreamClock(1 / FS, 0.10);     // ±10 %: follows firmware sample loss
  let ecgLast = -1;           // index of newest sample
  let ecgLastBase = null;     // last server `base` (wraps at 65536 packets)
  let ecgLastLen = 0;         // samples in that packet
  let ecgLastArrival = 0;
  const ecgAt = (n) => (n > ecgLast - RING && n <= ecgLast && n >= 0) ? ecgRing[n % RING] : NaN;

  // samples received / missing (packets the strap could not send), and the share
  // missing over the last LOSS_WIN seconds for the strip header
  let ecgGot = 0, ecgLost = 0, ecgLossPct = 0;
  const LOSS_WIN = 10, lossLog = [];     // [t, got, lost] once a second
  setInterval(() => {
    lossLog.push([now(), ecgGot, ecgLost]);
    while (lossLog.length > LOSS_WIN + 1) lossLog.shift();
    const got = ecgGot - lossLog[0][1], lost = ecgLost - lossLog[0][2];
    ecgLossPct = got + lost > 0 && got >= 0 && lost >= 0 ? 100 * lost / (got + lost) : 0;
    setText("ecg-fs", fsLabel());
  }, 1000);

  function pushEcg(msg, ta) {
    if (msg.fs && msg.fs !== FS) setEcgRate(msg.fs);
    if (msg.base === ecgLastBase) return;   // repeated packet (strap TX retry): already have it
    const len = msg.samples.length;
    let skip = 0;             // samples missing before this packet
    if (ecgLastBase != null) {
      const wrap = 65536 * len;
      const d = (((msg.base - ecgLastBase) % wrap) + wrap) % wrap;
      if (d !== len) {
        if (d > len && d <= 2 * FS) { skip = d - len; ecgLost += skip; }   // dropped packets: leave a gap
        else                                                  // restart / reconnect: keep the
          skip = Math.max(0, Math.round((ta - ecgLastArrival - len / FS) * FS));   // index ~ time
      }
    }
    for (let k = 0; k < Math.min(skip, RING); k++) {
      const j = (ecgLast + 1 + k) % RING; ecgRaw[j] = NaN; ecgRing[j] = NaN;
    }
    if (skip) notch.reset();              // gap: don't ring across it
    ecgLast += skip;
    for (const s of msg.samples) {
      ecgLast++;
      ecgRaw[ecgLast % RING] = s;
      ecgRing[ecgLast % RING] = notch.step(s);
    }
    ecgGot += len;
    ecgLastBase = msg.base;
    ecgLastLen = len;
    ecgLastArrival = ta;
    ecgFit.add(ecgLast, ta);
  }
  const ecgLive = () => ecgFit.ready && now() - ecgLastArrival < 5;

  // ---------- display-only mains notch (biquad, RBJ cookbook, Q = 30) ----------
  // The strap streams raw ECG on purpose; this only cleans the plotted trace.
  const notch = {
    f0: 50, b: null, a: null, z1: 0, z2: 0,
    design() {                                        // null when off
      if (!this.f0 || this.f0 >= FS / 2) { this.b = this.a = null; return; }
      const w0 = 2 * Math.PI * this.f0 / FS, alpha = Math.sin(w0) / (2 * 30), c = Math.cos(w0);
      const a0 = 1 + alpha;
      this.b = [1 / a0, -2 * c / a0, 1 / a0];
      this.a = [-2 * c / a0, (1 - alpha) / a0];
      this.reset();
    },
    reset() { this.z1 = this.z2 = 0; },
    step(x) {                                         // direct form II transposed
      if (!this.b || x !== x) { if (x !== x) this.reset(); return x; }
      const y = this.b[0] * x + this.z1;
      this.z1 = this.b[1] * x - this.a[0] * y + this.z2;
      this.z2 = this.b[2] * x - this.a[1] * y;
      return y;
    },
    // re-filter everything in the buffer (toggle / rate change), so the trace is
    // never half filtered
    refilter() {
      this.design();
      for (let n = Math.max(0, ecgLast - RING + 1); n <= ecgLast; n++) {
        const j = n % RING;
        ecgRing[j] = this.step(ecgRaw[j]);
      }
    },
  };
  let notchPref = 50;                 // the user's choice (remembered); the strap may override
  try { const f = localStorage.getItem("hrm.notch"); if (f != null) notchPref = +f; } catch (e) {}
  notch.f0 = notchPref;
  notch.design();
  let strapNotchHz = 0;               // > 0: the strap already notches the stream at this frequency

  // a1b20003 flags: if the strap notches in firmware, the display notch would
  // only notch twice -> force it off and say so; otherwise honour the user's choice
  function onEcgInfo(msg) {
    strapNotchHz = msg.notched_hz || 0;
    setStrapHpComp(!!msg.hp_comp, msg.hp_comp_hz || 0);
    const ns = $("notch-sel");
    const strapOpt = ns.querySelector('option[value="strap"]');
    if (strapNotchHz) {
      strapOpt.textContent = `Notch in strap (${strapNotchHz} Hz)`;
      strapOpt.hidden = false;
      ns.value = "strap";
      ns.disabled = true;
      ns.title = "The strap already removes mains hum from the ECG stream (and the recording)";
      notch.f0 = 0;
    } else {
      strapOpt.hidden = true;
      ns.disabled = false;
      ns.value = String(notchPref);
      ns.title = "Mains-hum notch on the displayed ECG only (recording stays raw)";
      notch.f0 = notchPref;
    }
    notch.refilter();
  }

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
  // derived per sample: tilt rate (deg/s) and magnitude (g). There is no gyro:
  // the rotation rate is how fast the direction of the measured acceleration
  // (mostly gravity) turns, so a turn about the vertical axis is invisible and
  // strong linear acceleration leaks into it.
  const accW = new Float32Array(ACC_RING).fill(NaN), accM = new Float32Array(ACC_RING);
  const ACC_G = 16384;        // LSB per g (SC7A20, +-2 g, left-justified int16)
  const ACC_CH = [["x", accX], ["y", accY], ["z", accZ]];
  const accDir = { n: 0, k: -1, h: [], p: null };   // 3-sample mean direction, previous one
  let accN = 0, accK = 0;     // stored count, packet counter (no seq in the packet)
  // angle between consecutive 3-sample mean vectors, per second (NaN across a gap)
  function accRot(x, y, z) {
    const d = accDir;
    if (accK !== d.k + 1) { d.h.length = 0; d.p = null; }
    d.k = accK;
    d.h.push([x, y, z]); if (d.h.length > 3) d.h.shift();
    if (d.h.length < 3) return NaN;
    const s = [0, 0, 0];
    for (const v of d.h) { s[0] += v[0]; s[1] += v[1]; s[2] += v[2]; }
    const p = d.p; d.p = s;
    if (!p) return NaN;
    const cx = p[1] * s[2] - p[2] * s[1], cy = p[2] * s[0] - p[0] * s[2], cz = p[0] * s[1] - p[1] * s[0];
    const dot = p[0] * s[0] + p[1] * s[1] + p[2] * s[2];
    return Math.atan2(Math.hypot(cx, cy, cz), dot) * 180 / Math.PI * ACC_FS;
  }
  let accLastArrival = 0, accLinkBroken = false;
  function pushAccel(m, ta) {
    if (accLinkBroken && accN > 0) {   // after a real link break, skip the counter by the gap
      accK += Math.max(0, Math.round((ta - accLastArrival) * ACC_FS) - 1);
    }
    accLinkBroken = false;
    accFit.add(accK, ta);
    const j = accN % ACC_RING;
    const x = m.x / ACC_G, y = m.y / ACC_G, z = m.z / ACC_G;
    accI[j] = accK; accX[j] = x; accY[j] = y; accZ[j] = z;
    accM[j] = Math.hypot(x, y, z);
    accW[j] = accRot(x, y, z);
    accE[j] = m.ecg_index != null ? hubToClientEcg(m.ecg_index) : NaN;
    accN++; accK++; accLastArrival = ta;
  }

  // ---------- beats: R-peak snapping, RR points, ensemble average ----------
  // search window around the newest ECG sample at the time the RR event arrived
  // (both share the BLE link, so a stall delays them together)
  let SNAP_BACK = Math.round(0.35 * FS), SNAP_FWD = Math.round(0.12 * FS);
  // Signal-averaged beat: every segment is one continuous piece of ECG aligned on
  // its R peak (0 ms), from AVG_T0 to AVG_T1 -- long enough to hold the next beat.
  // The first beat (up to half a beat period after R) is shown as the mean. The
  // second beat is deliberately neither re-aligned nor averaged: RR varies, so
  // its QRS lands at slightly different times -- there the individual beats are
  // drawn on top of each other, the newest sharpest and older ones fading out.
  const AVG_T0 = -0.3, AVG_T1 = 1.2;        // s around the R peak
  let AVG_PRE = Math.round(-AVG_T0 * FS);
  let AVG_LEN = Math.round((AVG_T1 - AVG_T0) * FS) + 1;
  const rrRecent = [];                      // last R-R distances (samples): median = beat period
  const pendingBeats = [];  // { ta, rr: [ms...] }  awaiting ECG data around the beat
  const pendingSegs = [];   // R-peak indices awaiting the samples up to AVG_T1
  const beatDots = [];      // R-peak sample indices (value read back from the ring)
  const segs = [];          // Float32Array(AVG_LEN) ring for the ensemble average
  let lastR = -1e9;

  // The strap reports its ECG rate (250 Hz on older firmware, 500 / 1024 Hz newer).
  // A change re-creates everything indexed by ECG sample.
  function setEcgRate(fs) {
    const oldDelay = ecgFit.delay;
    FS = fs;
    RING = FS * (WIN_MAX + 4);
    ecgRaw = new Float32Array(RING).fill(NaN);
    ecgRing = new Float32Array(RING).fill(NaN);
    notch.design();                          // coefficients depend on fs
    ecgFit = new StreamClock(1 / FS, 0.10);
    ecgFit.delay = oldDelay;                 // keep the playout delay: no jump in the view
    ecgLast = -1; ecgLastBase = null; ecgLastLen = 0; ecgLastArrival = 0;
    accE.fill(NaN);                          // accel ECG positions referred to the old index space
    SNAP_BACK = Math.round(0.35 * FS); SNAP_FWD = Math.round(0.12 * FS);
    pendingBeats.length = 0; beatDots.length = 0;
    pendingEcto.length = 0;                  // their sample indices are gone
    lastR = -1e9;
    rrRecent.length = 0;
    resetAvg();                              // new sample grid; clears the collected segments
    setText("ecg-fs", fsLabel());
  }

  function onRr(msg) {
    if (msg.hr != null) setText("hr", msg.hr);
    if (msg.contact) setText("contact", msg.contact);
    if (msg.rr && msg.rr.length) {
      const lastRr = msg.rr[msg.rr.length - 1];
      setText("rr", Math.round(lastRr));
      stream("rr", msg.rr.slice());
      hrvAdd(msg.rr);
      if (!msg.replay) { RRHist.add(msg.t, msg.rr); ExLive.add(msg.t, msg.rr); }
    }
  }

  // ---------- HRV (time domain) over a rolling window of firmware RR intervals ----------
  // Standard short-term metrics: RMSSD (successive differences), SDNN, pNN50.
  // Artifact/ectopy rejection: RR outside 300–2000 ms or changing > 20 % from the
  // previous RR is excluded, and successive differences only use two consecutive
  // accepted beats (so an ectopic beat drops both of its intervals). A pause of
  // more than 3 s (lost link) breaks the chain.
  // Display: the KPI card shows the 5 min window values through a ~1 min
  // exponential moving average (no jumping from beat to beat). The HRV trend card
  // is per beat on a 2 min time axis: RMSSD over the trailing 30 s (a value from
  // the second RR on, then smoothed by the moving window), |dRR| per beat, and
  // beat-to-beat HR. It fills from the left, then scrolls like the live strip.
  const HRV_WIN = 300, HRV_MIN_S = 30;   // 5 min window, first value after 30 s
  const HRV_TAU = 60;                    // s, display smoothing time constant
  const TREND_WIN = 120;                 // s on the trend's x axis
  const TREND_RMS_WIN = 30;              // s, moving RMSSD window of the trend line
  const hrvBeats = [];                   // { t, rr, ok, chain }  chain: diff to previous is valid
  let hrvPrev = null;
  let hrvEma = null;                     // { t, rmssd, sdnn, pnn50 }
  const trend = { t: [], rmssd: [], dabs: [], hr: [] };   // one entry per beat
  let trendT0 = null;                    // first beat: left edge while the window fills
  let trendPlots = null, trendDirty = false, trendDrawn = 0;
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
      hrvTrendAdd(beat, prev);
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
    const pnn50 = nDiff ? 100 * nn50 / nDiff : 0;
    if (!Number.isFinite(rmssd)) { setText("hrv", "--"); return; }
    // ~1 min exponential moving average of the window values
    const t = hrvBeats[hrvBeats.length - 1].t;
    if (!hrvEma) hrvEma = { t, rmssd, sdnn, pnn50 };
    else {
      const a = 1 - Math.exp(-Math.max(0, t - hrvEma.t) / HRV_TAU);
      hrvEma.rmssd += a * (rmssd - hrvEma.rmssd);
      hrvEma.sdnn += a * (sdnn - hrvEma.sdnn);
      hrvEma.pnn50 += a * (pnn50 - hrvEma.pnn50);
      hrvEma.t = t;
    }
    setText("hrv", Math.round(hrvEma.rmssd));
    const win = span < HRV_WIN - 5 ? `${Math.round(span)} s` : "5 min";
    setText("hrv-sub", `SDNN ${Math.round(hrvEma.sdnn)} ms · pNN50 ${Math.round(hrvEma.pnn50)} % · ` +
                       `${good.length} beats / ${win}` +
                       (good.length < hrvBeats.length ? ` · ${hrvBeats.length - good.length} excluded` : ""));
    $("hrv").title = `now (window ${win}): RMSSD ${Math.round(rmssd)} ms, SDNN ${Math.round(sdnn)} ms; ` +
                     `card shows a ~1 min moving average`;
  }

  // one trend point per beat: moving RMSSD (as soon as one successive difference
  // exists, i.e. from the second RR), |dRR| of this beat, and beat-to-beat HR
  function hrvTrendAdd(beat, prev) {
    const t = beat.t;
    if (trendT0 == null) trendT0 = t;
    let sumSq = 0, n = 0;
    for (let i = hrvBeats.length - 1; i >= 1 && hrvBeats[i].t > t - TREND_RMS_WIN; i--) {
      if (!hrvBeats[i].chain) continue;
      const d = hrvBeats[i].rr - hrvBeats[i - 1].rr;
      sumSq += d * d; n++;
    }
    trend.t.push(t);
    trend.rmssd.push(n ? Math.sqrt(sumSq / n) : null);
    trend.dabs.push(beat.chain ? Math.abs(beat.rr - prev.rr) : null);
    trend.hr.push(beat.rr >= 300 && beat.rr <= 2000 ? 60000 / beat.rr : null);
    while (trend.t.length && trend.t[0] < t - TREND_WIN - 10) {
      trend.t.shift(); trend.rmssd.shift(); trend.dabs.shift(); trend.hr.shift();
    }
    trendDirty = true;
  }

  function makeHrvTrend() {
    const clock = (u, splits) => splits.map((v) => new Date(v * 1000).toLocaleTimeString([], { hour12: false }));
    const axis = { stroke: COL.text, font: FONT, ticks: { show: false }, grid: { stroke: COL.grid, width: 1 } };
    const mk = (id, h, label, bottom, series) => new uPlot({
      width: $(id).clientWidth, height: h, legend: { show: false }, pxAlign: 0,
      padding: [6, 8, bottom ? 0 : 4, 0],
      cursor: { sync: { key: "hrv" }, y: false, points: { show: false },
                drag: { x: false, y: false, setScale: false } },
      scales: { x: { time: false, auto: false }, y: { auto: false } },
      axes: [
        { ...axis, scale: "x", space: 80, incrs: [10, 15, 30, 60],
          values: bottom ? clock : (u, splits) => splits.map(() => ""), size: bottom ? 26 : 0 },
        { ...axis, scale: "y", label, labelSize: 14, labelFont: FONT, size: 50, space: 30 },
      ],
      series: [{}, ...series],
    }, [[], ...series.map(() => [])], $(id));
    trendPlots = {
      hrv: mk("hrv-lane", 170, "RMSSD ms", false, [
        { stroke: "transparent", paths: () => null,                       // |dRR| per beat
          points: { show: true, size: 4, fill: COL.text, stroke: COL.text } },
        { stroke: COL.ecg, width: 2, spanGaps: true, points: { show: false } },   // moving RMSSD
      ]),
      hr: mk("hr-lane", 130, "HR bpm", true, [
        { stroke: COL.rr, width: 1.4, spanGaps: true,
          points: { show: true, size: 4, fill: COL.rr, stroke: COL.rr } },
      ]),
      hrvRange: autoRange(10), hrRange: autoRange(6),
    };
  }

  // x range: [first beat, +2 min] while filling, then the last 2 min, scrolling.
  // ~9 px/s on screen, so redrawing 10 times a second is smooth enough.
  function drawHrvTrend(tNow) {
    if (!trendPlots || trendT0 == null) return;
    const scrolling = tNow > trendT0 + TREND_WIN;
    if (!trendDirty && (!scrolling || tNow - trendDrawn < 0.1)) return;
    trendDirty = false; trendDrawn = tNow;
    const end = scrolling ? tNow : trendT0 + TREND_WIN;
    const xr = { min: end - TREND_WIN, max: end };
    const span = (arrs) => {
      let lo = Infinity, hi = -Infinity;
      for (const a of arrs) for (let i = 0; i < a.length; i++) {
        const v = a[i];
        if (v != null && trend.t[i] >= xr.min) { if (v < lo) lo = v; if (v > hi) hi = v; }
      }
      return [lo, hi];
    };
    const P = trendPlots;
    const [vlo, vhi] = span([trend.rmssd, trend.dabs]);
    P.hrv.batch(() => {
      P.hrv.setData([trend.t, trend.dabs, trend.rmssd], false);
      P.hrv.setScale("x", xr);
      const r = P.hrvRange(vlo, vhi);
      P.hrv.setScale("y", { min: Math.max(0, r.min), max: r.max });
    });
    const [hlo, hhi] = span([trend.hr]);
    P.hr.batch(() => {
      P.hr.setData([trend.t, trend.hr], false);
      P.hr.setScale("x", xr);
      P.hr.setScale("y", P.hrRange(hlo, hhi));
    });
    const last = (a) => { for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
    const r = last(trend.rmssd), h = last(trend.hr);
    setText("hrv-now", (r != null ? `RMSSD ${Math.round(r)} ms` : "RMSSD –") +
                       (h != null ? ` · HR ${Math.round(h)} bpm` : ""));
  }

  function localBaseline(n) {
    let s = 0, c = 0;
    for (let j = n - 2 * FS; j <= n; j++) { const v = ecgAt(j); if (v === v) { s += v; c++; } }
    return c ? s / c : 0;
  }

  function processBeats() {
    for (let k = 0; k < pendingBeats.length; ) {
      const b = pendingBeats[k];
      const nb = b.nb;
      if (!ecgLive() || nb < 0) {                     // no ECG to snap the beat to
        pendingBeats.splice(k, 1); continue;
      }
      if (ecgLast < nb + SNAP_FWD) { k++; continue; } // wait for the samples after the beat
      pendingBeats.splice(k, 1);
      const base = localBaseline(nb);
      let best = -1, bestv = -Infinity;
      for (let j = nb - SNAP_BACK; j <= nb + SNAP_FWD; j++) {
        const v = ecgAt(j);
        if (v === v && v - base > bestv) { bestv = v - base; best = j; }
      }
      if (best < 0) continue;
      if (best - lastR > 0.2 * FS) { beatDots.push(best); avgOnBeat(lastR, best); lastR = best; }
    }
    for (let k = 0; k < pendingSegs.length; ) {
      const r = pendingSegs[k];
      if (ecgLast < r - AVG_PRE + AVG_LEN) { k++; continue; }
      pendingSegs.splice(k, 1);
      const seg = new Float32Array(AVG_LEN);
      let ok = true;
      for (let i = 0; i < AVG_LEN; i++) { const v = ecgAt(r - AVG_PRE + i); if (v !== v) { ok = false; break; } seg[i] = v; }
      if (ok) { segs.push(seg); avgSegRev++; }
    }
    for (let k = 0; k < pendingEcto.length; ) {
      const p = pendingEcto[k];
      // wait for the beats after the event; a stalled stream gets what there is
      if (ecgLast < p.n0 + ECTO_POST * FS && now() - p.ta < ECTO_POST + 3) { k++; continue; }
      pendingEcto.splice(k, 1);
      ectoCapture(p.ev, p.n0);
    }
    while (beatDots.length && beatDots[0] <= ecgLast - RING) beatDots.shift();
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
    { key: "ecg", label: "ECG", h: 240, color: COL.ecg, width: LINE_W, minSpan: 200, paper: true },
    { key: "acc", label: "XYZ g",    h: 96, color: [COL.x, COL.y, COL.z], width: ACC_W, minSpan: 0.1,
      legend: ["X", "Y", "Z"] },
    { key: "rot", label: "Rot °/s",  h: 66, color: COL.rot, width: ACC_W, minSpan: 20, floor: 0 },
    { key: "mag", label: "|a| g",    h: 92, color: COL.mag, width: ACC_W, minSpan: 0.1, bottom: true },
  ];

  function laneOpts(L, width) {
    const axisBase = { stroke: COL.text, font: FONT, ticks: { show: false } };
    const axes = [
      // side given explicitly: uPlot only defaults axis 0 to the bottom, and the
      // paper grid below takes that slot on the ECG lane
      { ...axisBase, scale: "x", side: 2, space: L.bottom ? 70 : 60, incrs: [0.2, 0.5, 1, 2, 5, 10, 15, 30],
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
    const series = [{}];
    for (const c of [].concat(L.color)) series.push({ stroke: c, width: L.width, spanGaps: false, points: { show: false } });
    const hooks = { draw: [(u) => drawMeasure(u, L.key === "ecg")] };
    if (L.legend) hooks.draw.unshift((u) => drawLaneLegend(u, L));
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

  // colour key of a multi-trace lane, top left inside the plot
  function drawLaneLegend(u, L) {
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
  // m: marker state {a, b}; hover: x under the cursor; unit: seconds per x unit
  function drawMeasure(u, withLabel, m = meas, hover = hoverT, unit = 1, labelY = 4) {
    const a = m.a;
    const b = m.b != null ? m.b : (measureMode && hover != null ? hover : null);
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
    ctx.setLineDash(m.b == null ? [4 * dpr, 3 * dpr] : []);
    for (const x of xb != null ? [xa, xb] : [xa]) {
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + height); ctx.stroke();
    }
    if (withLabel && xb != null && b !== a && Math.max(xa, xb) > left && Math.min(xa, xb) < left + width) {
      const txt = measText(a * unit, b * unit);
      ctx.setLineDash([]);
      ctx.font = `600 ${12 * dpr}px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif`;
      const tw = ctx.measureText(txt).width, pad = 6 * dpr, bh = 20 * dpr;
      let x = (xa + xb) / 2 - tw / 2 - pad;
      x = Math.max(left + 2 * dpr, Math.min(left + width - tw - 2 * pad - 2 * dpr, x));
      const y = top + labelY * dpr;
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
      const range = autoRange(L.minSpan);
      lanes[L.key] = { u: new uPlot(laneOpts(L, w), [[], ...[].concat(L.color).map(() => [])], div),
                       range: L.floor == null ? range : (a, b) => {   // lane pinned to a floor (rate >= 0)
                         const r = range(L.floor, b); return { min: L.floor, max: r.max }; } };
    }
  }

  // reusable plain arrays (uPlot needs null for gaps, typed arrays can't hold it)
  const ecgXs = [], ecgYs = [], accXs = [], accVs = { x: [], y: [], z: [], rot: [], mag: [] };
  const ACC_KEYS = ["x", "y", "z", "rot", "mag"];
  function update(key, data, xr, dmin, dmax) {
    const lane = lanes[key];
    lane.u.batch(() => {
      lane.u.setData(data, false);
      lane.u.setScale("x", xr);
      lane.u.setScale("y", lane.range(dmin, dmax));
    });
  }

  let stripSig = null;      // what a frozen view was last drawn with
  function drawStrip() {
    stepZoom();
    if (paused) {             // frozen view: draw only when something in it changed
      const sig = `${viewEnd}|${win}|${meas.a}|${meas.b}|${measureMode ? hoverT : ""}|${notch.f0}|${FS}`;
      if (sig === stripSig) return;
      stripSig = sig;
    } else stripSig = null;
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
    accXs.length = 0;
    for (const c of ACC_KEYS) accVs[c].length = 0;
    const mm = { acc: [Infinity, -Infinity], rot: [Infinity, -Infinity], mag: [Infinity, -Infinity] };
    const span = (r, v) => { if (v < r[0]) r[0] = v; if (v > r[1]) r[1] = v; };
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
        for (const c of ACC_KEYS) accVs[c].push(null);
      }
      accXs.push(x);
      for (const [c, arr] of ACC_CH) { accVs[c].push(arr[j]); span(mm.acc, arr[j]); }
      const w = accW[j];
      accVs.rot.push(w === w ? w : null); if (w === w) span(mm.rot, w);
      accVs.mag.push(accM[j]); span(mm.mag, accM[j]);
    }
    update("acc", [accXs, accVs.x, accVs.y, accVs.z], xr, mm.acc[0], mm.acc[1]);
    update("rot", [accXs, accVs.rot], xr, mm.rot[0], mm.rot[1]);
    update("mag", [accXs, accVs.mag], xr, mm.mag[0], mm.mag[1]);

  }

  // ---------- signal-averaged beat (two beats) ----------
  let avgX = Array.from({ length: AVG_LEN }, (_, i) => (i - AVG_PRE) / FS * 1000);
  let avgPlot = null;
  // x zoom / pan (ms) and time measurement, like the live strip
  const AVG_VIEW = { min: AVG_T0 * 1000, max: AVG_T1 * 1000 };
  const avgView = { ...AVG_VIEW };
  const avgMeas = { a: null, b: null };
  let avgHover = null;
  // Per-beat equalisation before averaging: the strap's contact changes the gain
  // (and offset) from beat to beat, and artifacts distort single beats. avgUse is
  // what gets averaged / overlaid: each beat with its own baseline removed and
  // its QRS amplitude scaled to the median, minus the beats rejected as outliers.
  let avgNorm = true, avgUse = [], avgRejected = 0;
  let avgSegRev = 0;                        // counts collected beats (redraw trigger)
  try { avgNorm = localStorage.getItem("hrm.avgNorm") !== "0"; } catch (e) {}
  const AVG_CORR_MIN = 0.85;                // shape correlation with the mean, QRS..T window
  const AVG_GAIN_MAX = 2.5;                 // amplitude more than this far off the median: artifact
  // automatic QRST analysis of the mean beat (qrst.js)
  let qrstOn = true, qrstHp = 0, qrstRes = null;
  // the strap may already undo its front-end high-pass in the stream (a1b20003
  // flag): then the compensation here would be applied twice, so it is disabled
  let strapHpComp = false, strapHpHz = 0;
  function setStrapHpComp(on, hz) {
    if (on === strapHpComp && hz === strapHpHz) return;
    strapHpComp = on; strapHpHz = hz;
    const qh = $("qrst-hp");
    if (qh) {
      qh.disabled = on;
      qh.value = on ? "" : (qrstHp || "");
      qh.placeholder = on ? "strap" : "off";
      qh.parentElement.title = on
        ? `The strap already compensates its front-end high-pass in the ECG stream${hz ? " (" + hz + " Hz)" : ""}; nothing is added here`
        : qh.parentElement.dataset.tip;
    }
    if (avgPlot) drawAvg();
  }
  // the strap's own front-end HP compensation settings (a1b20005, newer firmware),
  // retuned live from here; null = not connected / firmware without them
  let hpCfg = null;
  const hpCfgKey = (c) => c && [c.shelf, c.fc_hz, c.f0_hz, c.hpf, c.hpf_hz].join("|");
  function onHpCfg(msg) {
    const prev = hpCfg, box = $("strap-hp");
    hpCfg = msg.available ? msg : null;
    box.hidden = !hpCfg;
    box.classList.remove("busy");
    if (!hpCfg) return;
    $("strap-hp-on").checked = hpCfg.shelf;
    $("strap-hp-fc").value = hpCfg.fc_hz;
    $("strap-hp-fc").disabled = !hpCfg.shelf;
    setText("strap-hp-val", hpCfg.shelf ? hpCfg.fc_hz.toFixed(1) + " Hz" : "off");
    // beats filtered one way and the other do not belong in one mean
    if (prev && hpCfgKey(prev) !== hpCfgKey(hpCfg)) clearAvg();
  }
  function sendHpCfg() {
    if (!hpCfg) return;
    const fc = +$("strap-hp-fc").value;
    const ok = send({ cmd: "hp_cfg", shelf: $("strap-hp-on").checked, fc_hz: fc,
                      f0_hz: Math.min(hpCfg.f0_hz, fc), hpf: hpCfg.hpf, hpf_hz: hpCfg.hpf_hz });
    if (ok) $("strap-hp").classList.add("busy");     // until the strap's read-back arrives
  }
  try {
    qrstOn = localStorage.getItem("hrm.qrst") !== "0";
    qrstHp = Math.max(0, parseFloat(localStorage.getItem("hrm.qrstHp")) || 0);
  } catch (e) {}
  const QRST_MIN_BEATS = 8;
  function avgSetData(data) {
    avgPlot.batch(() => { avgPlot.setData(data, false); avgPlot.setScale("x", avgView); });
  }
  function avgSetView(min, max) {
    const full = AVG_VIEW.max - AVG_VIEW.min;
    let span = Math.min(full, Math.max(20, max - min));          // 20 ms .. full window
    min = Math.min(AVG_VIEW.max - span, Math.max(AVG_VIEW.min, min));
    avgView.min = min; avgView.max = min + span;
    avgPlot.setScale("x", avgView);
  }

  // (re)start the collection on the current sample rate's grid
  function resetAvg() {
    AVG_PRE = Math.round(-AVG_T0 * FS);
    AVG_LEN = Math.round((AVG_T1 - AVG_T0) * FS) + 1;
    avgX = Array.from({ length: AVG_LEN }, (_, i) => (i - AVG_PRE) / FS * 1000);
    segs.length = 0; pendingSegs.length = 0;
    avgUse = []; avgRejected = 0;
    qrstRes = null;
    if (avgPlot) avgSetData([avgX, ...[0, 1, 2, 3].map(() => avgX.map(() => null))]);
    renderQrst();
    setText("avg-count", 0);
    if ($("avg-csv")) $("avg-csv").disabled = true;
  }
  // beat period in samples: median of the recent R-R distances (0.9 s until known)
  function avgPeriod() {
    if (!rrRecent.length) return Math.round(0.9 * FS);
    return rrRecent.slice().sort((a, b) => a - b)[rrRecent.length >> 1];
  }
  // a new R peak r2 after r1: every beat is collected
  function avgOnBeat(r1, r2) {
    const d = r2 - r1;
    if (d > 0.3 * FS && d < 2 * FS) {                    // consecutive beats
      rrRecent.push(d);
      if (rrRecent.length > 9) rrRecent.shift();
      setText("avg-rr", Math.round(avgPeriod() / FS * 1000) + " ms");
    }
    pendingSegs.push(r2);
  }
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
      scales: { x: { time: false, auto: false } },
      axes: [
        { stroke: COL.text, font: FONT, grid: { stroke: COL.grid }, ticks: { show: false },
          label: "ms  (R = 0)", labelSize: 18, labelFont: FONT },
        { stroke: COL.text, font: FONT, grid: { stroke: COL.grid }, ticks: { show: false },
          label: "ECG (avg)", labelSize: 14, labelFont: FONT, size: 50 },
      ],
      series: [{}, { stroke: COL.ecg, width: 2, points: { show: false } },      // mean, first beat
               { stroke: "transparent", points: { show: false } },      // envelope of the
               { stroke: "transparent", points: { show: false } },      // overlaid beats (y range)
               { stroke: COL.y, width: 1.5, points: { show: false } }], // high-pass compensated mean
      hooks: { draw: [drawAvgOverlay, drawQrst, (u) => drawMeasure(u, true, avgMeas, avgHover, 0.001)] },
    }, [avgX, ...[0, 1, 2, 3].map(() => avgX.map(() => null))], host);
    avgPlot.setScale("x", avgView);
  }
  // first sample of the "second beat" part: half a beat period after R
  const avgSeam = () => Math.min(AVG_LEN - 1, AVG_PRE + (avgPeriod() >> 1));

  // second beat: every collected beat drawn individually, oldest first and faint,
  // the newest last and sharpest
  // y shift of each overlaid beat so that it starts where the mean ends: a beat's
  // own baseline offset would otherwise show as a step at the seam
  let avgOff = new Float32Array(0);
  function avgSeamOffsets(mean, seam) {
    const h = Math.max(1, Math.round(0.004 * FS)), a = Math.max(0, seam - h), b = Math.min(AVG_LEN - 1, seam + h);
    const lvl = (v) => { let t = 0; for (let i = a; i <= b; i++) t += v[i]; return t / (b - a + 1); };
    const m = lvl(mean);
    avgOff = Float32Array.from(avgUse, (seg) => m - lvl(seg));
  }
  function drawAvgOverlay(u) {
    const n = avgUse.length;
    if (!n || avgOff.length !== n) return;
    const ctx = u.ctx, { left, top, width, height } = u.bbox, dpr = devicePixelRatio, seam = avgSeam();
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    // x pixel of every sample once, shared by all traces
    const xs = new Float32Array(AVG_LEN - seam);
    for (let i = seam; i < AVG_LEN; i++) xs[i - seam] = u.valToPos(avgX[i], "x", true);
    ctx.strokeStyle = COL.ecg; ctx.lineJoin = "round";
    for (let k = 0; k < n; k++) {
      const seg = avgUse[k], off = avgOff[k], newest = k === n - 1;
      const age = (k + 1) / n;                       // 1 = newest
      ctx.globalAlpha = newest ? 1 : 0.05 + 0.5 * age * age * age;
      ctx.lineWidth = newest ? 2 * dpr : 1;          // one device pixel: cheap to stroke
      ctx.beginPath();
      for (let i = seam; i < AVG_LEN; i++) {
        const y = u.valToPos(seg[i] + off, "y", true);
        if (i === seam) ctx.moveTo(xs[0], y); else ctx.lineTo(xs[i - seam], y);
      }
      ctx.stroke();
    }
    // where the mean ends and the overlay begins
    ctx.globalAlpha = 1; ctx.strokeStyle = COL.grid; ctx.lineWidth = dpr; ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(xs[0], top); ctx.lineTo(xs[0], top + height); ctx.stroke();
    ctx.restore();
  }
  // QRST fiducials on the averaged-beat chart: wave peaks as solid lines with a
  // letter, onsets / offsets / T end dashed
  const QRST_MARKS = [
    ["pOn", "", "#c792ea", true], ["P", "P", "#c792ea", false], ["pOff", "", "#c792ea", true],
    ["qrsOn", "", "#ff5470", true], ["Q", "Q", "#8b96a5", false], ["R", "R", "#e6edf3", false],
    ["S", "S", "#8b96a5", false], ["qrsOff", "J", "#ff5470", true],
    ["T", "T", "#ffb454", false], ["tEnd", "Te", "#ffb454", true],
  ];
  function drawQrst(u) {
    if (!qrstRes) return;
    const ctx = u.ctx, { left, top, width, height } = u.bbox, dpr = devicePixelRatio;
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    ctx.font = `600 ${11 * dpr}px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "bottom"; ctx.lineWidth = dpr;
    for (const [key, label, color, dashed] of QRST_MARKS) {
      const v = qrstRes.fid[key];
      if (v == null) continue;
      const x = u.valToPos(v, "x", true);
      ctx.strokeStyle = color; ctx.fillStyle = color;
      ctx.globalAlpha = dashed ? 0.75 : 0.9;
      ctx.setLineDash(dashed ? [3 * dpr, 3 * dpr] : []);
      // labels in one row just above the bottom edge, the line runs down to it
      const yLab = top + height - 3 * dpr;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, label ? yLab - 13 * dpr : top + height); ctx.stroke();
      if (label) { ctx.globalAlpha = 1; ctx.fillText(label, x, yLab); }
    }
    ctx.restore();
  }
  let qrstHtml = "";
  function renderQrst() {
    const html = qrstMarkup();
    if (html === qrstHtml) return;          // rebuilt only when a value changed
    const el = $("qrst-out");
    if (el) { el.innerHTML = html; qrstHtml = html; }
  }
  function qrstMarkup() {
    if (!qrstOn) return "";
    if (!qrstRes) {
      return avgUse.length < QRST_MIN_BEATS
        ? `QRST: collecting beats… ${avgUse.length} / ${QRST_MIN_BEATS}` : "QRST: no clear complex found";
    }
    const m = qrstRes.m, a = qrstRes.amp, f = (v, u = " ms") => v == null ? "–" : Math.round(v) + u;
    const item = (k, v, tip) => `<span class="q-item" title="${tip}"><span class="q-k">${k}</span> ${v}</span>`;
    return item("PR", f(m.pr), "P onset to QRS onset") +
      item("QRS", f(m.qrs), "QRS onset to J point") +
      item("QT", f(m.qt), "QRS onset to T end (tangent method)") +
      item("QTc", m.qt == null ? "–" : `${Math.round(m.qtcF)} / ${Math.round(m.qtcB)} ms`, "Fridericia / Bazett, RR " + Math.round(m.rr) + " ms") +
      item("P–R", f(m.pPeakR), "P peak to R peak") +
      item("R–T", f(m.rtPeak), "R peak to T peak") +
      item("HR", f(m.hr, " bpm"), "from the median RR") +
      item("amp", ["P", "Q", "R", "S", "T"].map((k) => `${k} ${a[k] == null ? "–" : Math.round(a[k])}`).join(" · "), "wave amplitudes, ADC counts") +
      `<span class="q-note">${qrstRes.comp
        ? `front-end high-pass compensated at ${qrstRes.comp} Hz (orange curve) — amplitudes and QT depend on this value`
        : strapHpComp
          ? `front-end high-pass compensated in the strap${strapHpHz ? " at " + strapHpHz + " Hz" : ""} — amplitudes and QT depend on that corner`
          : "front end not compensated: timings are reliable; QT and amplitudes are estimates"}</span>`;
  }

  // Build avgUse from the collected raw segments.
  //  1. baseline of each beat = median of its first 50 ms (before the P wave)
  //  2. gain of each beat = median QRS peak-to-peak (R +/- 60 ms) / its own
  //  3. reject beats whose amplitude is far off, then those whose shape does not
  //     correlate with the mean of the rest (ectopic beats, motion artifacts)
  function avgPrepare() {
    avgRejected = 0;
    if (!avgNorm || segs.length < 3) { avgUse = segs.slice(); return; }
    const k50 = Math.max(4, Math.round(0.05 * FS)), q = Math.round(0.06 * FS);
    const med = (a) => { const b = Array.from(a).sort((x, y) => x - y); return b[b.length >> 1]; };
    const base = [], amp = [];
    for (const seg of segs) {
      base.push(med(seg.subarray(0, k50)));
      let lo = Infinity, hi = -Infinity;
      for (let i = AVG_PRE - q; i <= AVG_PRE + q; i++) { const v = seg[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      amp.push(hi - lo);
    }
    const refAmp = med(amp), refBase = med(base);
    let cand = [];
    segs.forEach((seg, k) => {
      const g = refAmp / amp[k];
      if (!(amp[k] > 0) || g > AVG_GAIN_MAX || g < 1 / AVG_GAIN_MAX) return;      // amplitude outlier
      const out = new Float32Array(AVG_LEN);
      for (let i = 0; i < AVG_LEN; i++) out[i] = (seg[i] - base[k]) * g + refBase;
      cand.push(out);
    });
    // shape check against the mean of the candidates, over -150 .. +350 ms
    if (cand.length >= 5) {
      const a = Math.max(0, AVG_PRE - Math.round(0.15 * FS)), b = Math.min(AVG_LEN, AVG_PRE + Math.round(0.35 * FS));
      const m = new Float64Array(b - a);
      for (const c of cand) for (let i = a; i < b; i++) m[i - a] += c[i] / cand.length;
      let mm = 0; for (const v of m) mm += v / m.length;
      let smm = 0; for (const v of m) smm += (v - mm) ** 2;
      const keep = cand.filter((c) => {
        let cm = 0; for (let i = a; i < b; i++) cm += c[i] / (b - a);
        let sxy = 0, scc = 0;
        for (let i = a; i < b; i++) { sxy += (c[i] - cm) * (m[i - a] - mm); scc += (c[i] - cm) ** 2; }
        return sxy / Math.sqrt(scc * smm || 1) >= AVG_CORR_MIN;
      });
      if (keep.length >= 3) cand = keep;
    }
    avgUse = cand;
    avgRejected = segs.length - cand.length;
  }
  function avgStats() {                 // mean and SD per sample over the beats in use
    const n = avgUse.length, mean = new Array(AVG_LEN).fill(0), sd = new Array(AVG_LEN).fill(0);
    for (const seg of avgUse) for (let i = 0; i < AVG_LEN; i++) mean[i] += seg[i];
    for (let i = 0; i < AVG_LEN; i++) mean[i] /= n;
    if (n > 1) {
      for (const seg of avgUse) for (let i = 0; i < AVG_LEN; i++) sd[i] += (seg[i] - mean[i]) ** 2;
      for (let i = 0; i < AVG_LEN; i++) sd[i] = Math.sqrt(sd[i] / (n - 1));
    }
    return { n, mean, sd };
  }
  // runs 4x a second, but only does anything when a beat arrived or a setting changed
  let avgSig = null;
  function drawAvg() {
    while (segs.length > avgN()) segs.shift();
    const sig = [segs.length, avgSegRev, avgNorm, qrstOn, qrstHp, strapHpComp, FS, avgPeriod()].join("|");
    if (sig === avgSig) return;
    avgSig = sig;
    avgPrepare();
    setText("avg-count", segs.length + (avgRejected ? ` (${avgRejected} rejected)` : ""));
    $("avg-csv").disabled = !avgUse.length;
    if (!avgUse.length) return;
    // first beat: mean; second beat: no averaging -- only the envelope of the
    // individual beats goes in as invisible series, so the y axis fits them
    const { mean } = avgStats(), seam = avgSeam();
    avgSeamOffsets(mean, seam);
    const hi = new Array(AVG_LEN).fill(null), lo = new Array(AVG_LEN).fill(null);
    for (let i = seam; i < AVG_LEN; i++) {
      let a = Infinity, b = -Infinity;
      avgUse.forEach((seg, k) => { const v = seg[i] + avgOff[k]; if (v < a) a = v; if (v > b) b = v; });
      lo[i] = a; hi[i] = b;
    }
    // QRST analysis on the whole mean (not only up to the seam)
    const comp = new Array(AVG_LEN).fill(null);
    qrstRes = null;
    if (qrstOn && avgUse.length >= QRST_MIN_BEATS && rrRecent.length) {
      qrstRes = QRST.analyze(avgX, mean, FS, avgPeriod() / FS * 1000, { hpHz: strapHpComp ? 0 : qrstHp });
      if (qrstRes && qrstRes.comp) for (let i = 0; i < qrstRes.sig.length; i++) comp[i] = qrstRes.sig[i] + qrstRes.base;
    }
    avgSetData([avgX, mean.map((v, i) => (i <= seam ? v : null)), hi, lo, comp]);
    renderQrst();
  }
  function clearAvg() { resetAvg(); }
  function downloadAvg() {
    if (!avgUse.length) return;
    const { n, mean, sd } = avgStats();
    const stamp = new Date();
    const lines = [
      `# Govinda / HRM Raw RR signal-averaged beat, ${AVG_T0 * 1000} .. ${AVG_T1 * 1000} ms around the R peak (t_ms = 0); ` +
        `later beats in the window are not re-aligned -- sd shows their spread`,
      `# exported ${stamp.toISOString()}, ${n} beats, ECG ${FS} Hz, display notch ${notch.f0 ? notch.f0 + " Hz" : (strapNotchHz ? "in strap " + strapNotchHz + " Hz" : "off")}`,
      ...(qrstRes ? [`# QRST (${qrstRes.comp ? "high-pass compensated at " + qrstRes.comp + " Hz"
        : strapHpComp ? "high-pass compensated in the strap" + (strapHpHz ? " at " + strapHpHz + " Hz" : "") : "uncompensated"}): ` +
        Object.entries(qrstRes.m).map(([k, v]) => `${k}=${Math.round(v)}`).join(" ") + " | fiducials ms: " +
        Object.entries(qrstRes.fid).map(([k, v]) => `${k}=${Math.round(v)}`).join(" ")] : []),
      `# beats: ${avgUse.length} averaged of ${segs.length} collected` + (avgNorm
        ? `; each beat baseline-corrected and scaled to the median QRS amplitude, ${avgRejected} rejected (amplitude or shape outliers)`
        : "; raw (no per-beat equalisation)"),
      "t_ms,mean_adc,sd_adc",
    ];
    for (let i = 0; i < AVG_LEN; i++)
      lines.push(`${((i - AVG_PRE) * 1000 / FS).toFixed(3)},${mean[i].toFixed(2)},${sd[i].toFixed(2)}`);
    const pad = (v) => String(v).padStart(2, "0");
    const name = `hrm_avg_beat_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_` +
                 `${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.csv`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- render loop ----------
  // playout delay: the larger of the streams' adaptive delays (slewed, never jumps)
  let delayNow = 0.35, lastFrame = null;
  function frame() {
    requestAnimationFrame(frame);
    const t = now();
    if (lastFrame != null && t - lastFrame < FRAME_MIN) return;   // frame-rate cap
    const dt = lastFrame == null ? 0 : Math.min(0.1, t - lastFrame);
    lastFrame = t;
    if (!paused) {
      delayNow = Math.max(ecgFit.displayDelay(t, dt), accFit.ready ? accFit.displayDelay(t, dt) : 0);
      processBeats();              // frozen view: keep beats/RR exactly as they were
    }
    drawStrip();
    drawHrvTrend(t);
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
    else if (kind === "ecto") pendingEcto.push({ ev: msg, n0: ecgLast, ta });
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
    $("avg-measure-btn").classList.toggle("active", on);
    if (!on) {                       // leaving the mode takes the markers with it
      hoverT = null; avgHover = null;
      meas.a = meas.b = avgMeas.a = avgMeas.b = null;
      if (avgPlot) avgPlot.redraw(false);
      if (ectoPlot) ectoPlot.redraw(false);
    }
    updateCursor();
    updateReadout();
  }
  function clearMeasure() {
    meas.a = meas.b = avgMeas.a = avgMeas.b = null;
    updateReadout();
    if (avgPlot) avgPlot.redraw(false);
  }
  function updateReadout() {
    const el = $("meas-readout");
    if (meas.a != null && meas.b != null) el.textContent = measText(meas.a, meas.b);
    else if (measureMode) el.textContent = meas.a == null ? "click the start point" : "click the end point";
    else el.textContent = "";
    const ea = $("avg-meas-readout");
    if (avgMeas.a != null && avgMeas.b != null) ea.textContent = measText(avgMeas.a / 1000, avgMeas.b / 1000);
    else if (measureMode) ea.textContent = avgMeas.a == null ? "click the start point" : "click the end point";
    else ea.textContent = "";
  }
  function updateCursor() {
    $("strip-chart").style.cursor = measureMode ? "crosshair" : paused ? "grab" : "";
    $("avg-chart").style.cursor = measureMode ? "crosshair" : "grab";
  }

  // averaged-beat chart: wheel = zoom around the cursor, drag = pan, double-click =
  // whole window, and in measure mode a click places a marker (shared mode/keys)
  function initAvgTools() {
    const host = $("avg-chart");
    const msAt = (clientX) => {
      const r = avgPlot.over.getBoundingClientRect(), x = clientX - r.left;
      return x >= 0 && x <= r.width ? avgPlot.posToVal(x, "x") : null;
    };
    host.addEventListener("wheel", (e) => {
      e.preventDefault();
      const dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
      const k = Math.exp(dy * 0.002);
      let c = msAt(e.clientX);
      if (c == null) c = (avgView.min + avgView.max) / 2;
      avgSetView(c + (avgView.min - c) * k, c + (avgView.max - c) * k);
    }, { passive: false });
    host.addEventListener("dblclick", () => { if (!measureMode) avgSetView(AVG_VIEW.min, AVG_VIEW.max); });
    let drag = null;
    host.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      drag = { x0: e.clientX, min0: avgView.min, max0: avgView.max, moved: false };
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      const r = host.getBoundingClientRect();
      const h = e.clientY >= r.top && e.clientY <= r.bottom ? msAt(e.clientX) : null;
      const rubber = measureMode && avgMeas.a != null && avgMeas.b == null && h !== avgHover;
      avgHover = h;
      if (drag) {
        const dx = e.clientX - drag.x0;
        if (drag.moved || Math.abs(dx) >= 4) {
          drag.moved = true;
          host.style.cursor = "grabbing";
          const pxW = avgPlot.bbox.width / devicePixelRatio;
          const d = dx * (drag.max0 - drag.min0) / pxW;
          avgSetView(drag.min0 - d, drag.max0 - d);
          return;
        }
      }
      if (rubber) avgPlot.redraw(false);       // rubber band follows the cursor
    });
    window.addEventListener("mouseup", (e) => {
      if (!drag) return;
      const wasClick = !drag.moved;
      drag = null;
      updateCursor();
      if (!wasClick || !measureMode) return;
      const t = msAt(e.clientX);
      if (t == null) return;
      if (avgMeas.a == null || avgMeas.b != null) { avgMeas.a = t; avgMeas.b = null; }
      else avgMeas.b = t;
      updateReadout();
      avgPlot.redraw(false);
    });
    host.addEventListener("mouseleave", () => { avgHover = null; });
    $("avg-measure-btn").addEventListener("click", () => setMeasureMode(!measureMode));
    const nb = $("avg-norm-btn");
    nb.classList.toggle("active", avgNorm);
    nb.addEventListener("click", () => {
      avgNorm = !avgNorm;
      nb.classList.toggle("active", avgNorm);
      try { localStorage.setItem("hrm.avgNorm", avgNorm ? "1" : "0"); } catch (e) {}
      drawAvg();
    });
    const qb = $("qrst-btn"), qh = $("qrst-hp");
    qb.classList.toggle("active", qrstOn);
    qh.parentElement.dataset.tip = qh.parentElement.title;
    if (!strapHpComp) qh.value = qrstHp || "";
    else { const on = strapHpComp, hz = strapHpHz; strapHpComp = !on; setStrapHpComp(on, hz); }
    qb.addEventListener("click", () => {
      qrstOn = !qrstOn;
      qb.classList.toggle("active", qrstOn);
      try { localStorage.setItem("hrm.qrst", qrstOn ? "1" : "0"); } catch (e) {}
      drawAvg(); if (!qrstOn) { qrstRes = null; avgPlot.redraw(false); renderQrst(); }
    });
    qh.addEventListener("change", () => {
      qrstHp = Math.min(100, Math.max(0, parseFloat(qh.value) || 0));
      qh.value = qrstHp || "";
      try { localStorage.setItem("hrm.qrstHp", String(qrstHp)); } catch (e) {}
      drawAvg();
    });
    updateCursor();
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
      else if (e.key === "Escape") {
        if (meas.a != null || avgMeas.a != null) clearMeasure(); else setMeasureMode(false);
      }
    });
  }

  function resize() {
    const w = $("strip-chart").clientWidth;
    for (const L of LANES) lanes[L.key].u.setSize({ width: w, height: L.h });
    const a = $("avg-chart");
    if (avgPlot) avgPlot.setSize({ width: a.clientWidth, height: a.clientHeight || 300 });
    const ev = $("ecto-chart");
    if (ectoPlot && ectoSel) ectoPlot.setSize({ width: ev.clientWidth, height: ev.clientHeight || 220 });
    if (trendPlots) {
      trendPlots.hrv.setSize({ width: $("hrv-lane").clientWidth, height: 170 });
      trendPlots.hr.setSize({ width: $("hr-lane").clientWidth, height: 130 });
      trendDirty = true;
    }
  }

  // ---------- DOM panels ----------
  // Every event the strap reports keeps its own piece of ECG: the strap decides
  // one beat late (it needs the pause after the early beat), so the early beat
  // is pause_ms before the notification. Kept: ECTO_PRE before the beat that
  // precedes it .. ECTO_POST after the notification, with the R positions.
  // Click a row of the log to look at it. (Browser memory only; the whole
  // recording is in the ECG CSV.)
  const ECTO_PRE = 2.0, ECTO_POST = 2.0;   // s
  const ECTO_KEEP = 40;                    // rows (and waveforms) in the log
  const pendingEcto = [];                  // { ev, n0, ta }  waiting for the samples after the event
  let ectoPlot = null, ectoSel = null;     // the event shown
  const ectoCls = (name) => name === "PVC" ? "pvc" : name === "PAC" ? "pac" : "art";

  function ectoCapture(ev, n0) {
    const pause = ev.pause_ms / 1000 * FS, coup = ev.coupling_ms / 1000 * FS;
    // the early beat: the R whose intervals before and after are the reported
    // coupling and pause, the pause ending at about the notification
    let r0 = null, err = 0.12 * FS;
    for (let k = 1; k + 1 < beatDots.length; k++) {
      const r = beatDots[k], next = beatDots[k + 1];
      if (next < n0 - 0.7 * FS || next > n0 + 0.2 * FS) continue;
      const e = Math.abs(r - beatDots[k - 1] - coup) + Math.abs(next - r - pause);
      if (e < err) { err = e; r0 = r; }
    }
    const exact = r0 != null;
    if (!exact) r0 = Math.round(n0 - pause - 0.15 * FS);        // ~ detection + radio latency
    const from = Math.max(0, ecgLast - RING + 1, Math.round(r0 - coup - ECTO_PRE * FS));
    const to = Math.min(ecgLast, Math.round(n0 + ECTO_POST * FS));
    if (to - from < 0.5 * FS) return;
    const x = new Array(to - from + 1), y = new Array(to - from + 1);
    let any = false;
    for (let n = from; n <= to; n++) {
      const v = ecgRing[n % RING];
      x[n - from] = (n - r0) / FS * 1000;
      y[n - from] = v === v ? v : null;
      if (v === v) any = true;
    }
    if (!any) return;
    ev.wave = { x, y, exact,
                beats: beatDots.filter((n) => n >= from && n <= to).map((n) => (n - r0) / FS * 1000) };
    if (ev.row) { ev.row.classList.add("has-wave"); ev.row.title = "Show the ECG around this beat"; }
  }

  function ectoShow(ev) {
    if (ectoSel && ectoSel.row) ectoSel.row.classList.remove("sel");
    ectoSel = ev && ev.wave ? ev : null;
    $("ecto-view").hidden = !ectoSel;
    if (!ectoSel) return;
    ev.row.classList.add("sel");
    const w = ev.wave;
    $("ecto-view-title").innerHTML =
      `<span class="tag ${ectoCls(ev.type_name)}">${ev.type_name}</span> ${ev.ts}` +
      ` <span class="meta">· coupling ${ev.coupling_ms} ms · pause ${ev.pause_ms} ms` +
      (w.exact ? "" : " · beat position estimated") + `</span>`;
    const host = $("ecto-chart");
    if (!ectoPlot) {
      ectoPlot = new uPlot({
        width: host.clientWidth, height: host.clientHeight || 220, legend: { show: false },
        padding: [6, 12, 0, 0],
        cursor: { y: false, drag: { x: false, y: false, setScale: false } },
        scales: { x: { time: false } },
        axes: [
          { stroke: COL.text, font: FONT, grid: { stroke: COL.grid }, ticks: { show: false },
            label: "ms  (reported beat = 0)", labelSize: 18, labelFont: FONT },
          { stroke: COL.text, font: FONT, grid: { stroke: COL.grid }, ticks: { show: false },
            label: "ECG", labelSize: 14, labelFont: FONT, size: 50 },
        ],
        series: [{}, { stroke: COL.ecg, width: 1.5, points: { show: false } }],
        hooks: { draw: [drawEctoBeats] },
      }, [w.x, w.y], host);
    } else {
      ectoPlot.setSize({ width: host.clientWidth, height: host.clientHeight || 220 });
      ectoPlot.setData([w.x, w.y]);
    }
  }
  // R positions, the R-R interval between them, the reported beat highlighted
  function drawEctoBeats(u) {
    if (!ectoSel) return;
    const w = ectoSel.wave, ctx = u.ctx, { left, top, width, height } = u.bbox, dpr = devicePixelRatio;
    const col = getComputedStyle(document.documentElement)
      .getPropertyValue("--" + ectoCls(ectoSel.type_name)).trim() || COL.rr;
    ctx.save();
    ctx.beginPath(); ctx.rect(left, top, width, height); ctx.clip();
    const x0 = u.valToPos(0, "x", true);
    ctx.fillStyle = col; ctx.globalAlpha = 0.13;
    ctx.fillRect(x0 - 14 * dpr, top, 28 * dpr, height);
    ctx.globalAlpha = 1;
    ctx.font = `600 ${11 * dpr}px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillText(ectoSel.type_name, x0, top + height - 3 * dpr);
    ctx.textBaseline = "top";
    ctx.strokeStyle = COL.text; ctx.lineWidth = dpr; ctx.setLineDash([2 * dpr, 3 * dpr]);
    let prev = null;
    for (const t of w.beats) {
      const x = u.valToPos(t, "x", true);
      ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + 16 * dpr); ctx.stroke();
      ctx.globalAlpha = 1;
      if (prev != null && t - prev < 2500) {
        const early = Math.abs(t) < 1, late = Math.abs(prev) < 1;
        ctx.fillStyle = early || late ? col : COL.text;
        ctx.fillText(Math.round(t - prev) + " ms", (x + u.valToPos(prev, "x", true)) / 2, top + 3 * dpr);
      }
      prev = t;
    }
    ctx.restore();
  }

  function onEctopy(msg) {
    setText("pvc", msg.pvc);
    setText("pac", msg.pac);
    setText("artifact", msg.artifact);
    setText("burden", (msg.burden_pct != null ? msg.burden_pct : 0).toFixed(1));
    setText("total-beats", msg.total);
    if (msg.type_name && msg.type_name !== "NONE") {
      const log = $("ecto-log");
      // the last event again (sent to every new page / after a reconnect)
      if (msg.replay && [...log.children].some((d) => d.ev && d.ev.t === msg.t)) return;
      const empty = log.querySelector(".ecto-empty");
      if (empty) empty.remove();
      const div = document.createElement("div");
      div.className = "evt " + ectoCls(msg.type_name);
      msg.ts = new Date((msg.t || Date.now() / 1000) * 1000).toLocaleTimeString();
      div.innerHTML = `<span class="tag">${msg.type_name}</span>` +
        `<span>${msg.ts}</span>` +
        `<span class="meta">coupling ${msg.coupling_ms}ms · pause ${msg.pause_ms}ms</span>`;
      div.ev = msg; msg.row = div;
      div.addEventListener("click", () => ectoShow(ectoSel === msg ? null : msg));
      log.prepend(div);
      while (log.children.length > ECTO_KEEP) {
        const old = log.lastChild;
        if (old.ev === ectoSel) ectoShow(null);
        log.removeChild(old);
      }
      if (!msg.replay) stream("ecto", msg);          // its waveform follows with the ECG
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
    if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(obj)); return true; }
    setText("status-text", "Not connected to the app — reconnecting…");
    return false;
  }

  // Connection state machine as the user sees it:
  //   Connect    -> Connecting… -> Connected | Failed (auto-retry countdown)
  //   Disconnect -> Disconnecting… -> Disconnected
  // A click shows its "…ing" state immediately (`pending`) until the backend's
  // next status confirms or replaces it.
  // A click the backend does not answer is sent once more after 2 s; after 6 s
  // the buttons come back with a note, so a lost command is never a dead end.
  let pending = null;            // "connecting" | "disconnecting" | null
  let pendingCmd = null, pendingAt = 0, pendingResent = false, cmdNote = "", cmdNoteUntil = 0;
  function command(obj, state) {
    if (!send(obj)) return false;
    pending = state; pendingCmd = obj; pendingAt = Date.now(); pendingResent = false; cmdNote = "";
    renderStatus();
    return true;
  }
  setInterval(() => {
    if (cmdNote && Date.now() > cmdNoteUntil) { cmdNote = ""; renderStatus(); }
    if (!pending) return;
    const age = Date.now() - pendingAt;
    if (age > 6000) {
      cmdNote = `the app did not answer “${pendingCmd.cmd}” · `; cmdNoteUntil = Date.now() + 15000;
      console.warn("hrm: no status change after", pendingCmd, "backend state:", status.state);
      pending = null; renderStatus();
    } else if (age > 2000 && !pendingResent) {
      pendingResent = true;
      console.warn("hrm: no answer to", pendingCmd, "after 2 s, sending it again");
      send(pendingCmd);
    }
  }, 500);
  function uiState() {
    if (pending) return pending;
    switch (status.state) {
      case "connected": return "connected";
      case "scanning": case "connecting": return "connecting";
      case "disconnected": return "reconnecting";
      case "failed": case "waiting": case "error": return "failed";
      case "disconnecting": return "disconnecting";
      case "demo": return "demo";
      case "idle": return "disconnected";
      default: return "disconnected";
    }
  }
  function statusLabel() {
    const s = status;
    const left = Math.max(0, Math.round((s.next_scan || 0) - Date.now() / 1000));
    return cmdNote + statusLabelBase(s, left);
  }
  function statusLabelBase(s, left) {
    switch (uiState()) {
      case "connected": return "Connected" + (s.detail ? " · " + s.detail : "");
      case "connecting":
        return "Connecting… " + (s.state === "connecting" && s.detail ? s.detail : "searching " + targetName());
      case "reconnecting": return "Connection lost · reconnecting…";
      case "failed": return `Failed: ${s.detail || "error"}` + (s.next_scan ? ` · retry in ${left} s` : "");
      case "disconnecting": return "Disconnecting…";
      case "demo": return "Demo mode";
      default: return "Disconnected";
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
    // the backend has acted on the click once it reports anything but the old state
    if (pending === "disconnecting" && ["idle", "disconnecting"].includes(msg.state)) pending = null;
    if (pending === "connecting" && msg.state !== "idle") pending = null;
    renderStatus();
  }
  function renderStatus() {
    const st = uiState();
    const el = $("status");
    el.classList.remove("status-on", "status-off", "status-demo", "status-wait", "status-idle");
    el.classList.add({ connected: "status-on", demo: "status-demo", connecting: "status-wait",
                       reconnecting: "status-wait", disconnecting: "status-wait",
                       disconnected: "status-idle" }[st] || "status-off");
    setText("status-text", statusLabel());
    $("status").title = statusLabel();
    renderDevices();
  }
  setInterval(() => { if (uiState() === "failed") setText("status-text", statusLabel()); }, 1000);

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
      (ecgLossPct >= 1 ? ` · ⚠ ${ecgLossPct.toFixed(0)} % of the ECG lost on the radio link` : "") +
      (link && link.conn_count > 1 ? ` · ⚠ ${link.conn_count} hosts connected` : "") +
      // sample buffers the strap itself dropped (its processing lagged), since it booted
      (link && link.adc_overrun > 0 ? ` · ⚠ ${link.adc_overrun} ADC overruns` : "");
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
    const opts = [[AUTO, `Auto · find “${(t.auto !== false && t.name) || "Govinda"}” by name`, ""]];
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

    // Fixed labels, fixed widths: only enabled/disabled changes, so nothing moves.
    //   disconnected / failed : Connect (failed: retry now)   | Disconnect only if retrying
    //   connecting / reconn.  : Connect off                   | Disconnect = cancel
    //   connected             : Connect only to switch device | Disconnect
    //   disconnecting         : both off
    const st0 = uiState(), st = st0 === "demo" ? "connected" : st0;   // demo behaves as connected
    const scanning = devScanning || status.state === "scanning";
    $("scan-btn").classList.toggle("busy", scanning);
    $("scan-btn").disabled = scanning || st === "disconnecting";
    $("conn-btn").disabled = !(st === "disconnected" || st === "failed" ||
                               (st === "connected" && sel.value !== current));
    $("disc-btn").disabled = !(st === "connecting" || st === "reconnecting" || st === "connected" ||
                               (st === "failed" && status.enabled !== false));
  }

  function initDevicePicker() {
    const sel = $("dev-select");
    sel.addEventListener("change", () => { userPicked = true; renderDevices(); });
    $("conn-btn").addEventListener("click", () => {
      const opt = sel.selectedOptions[0];
      if (!command({ cmd: "connect", address: sel.value || null, name: opt ? opt.dataset.name : "" }, "connecting")) return;
      userPicked = false; renderDevices();
    });
    $("disc-btn").addEventListener("click", () => {
      command({ cmd: "disconnect" }, "disconnecting");
    });
    $("take-raw").addEventListener("click", () => send({ cmd: "take_raw" }));
    $("avg-clear").addEventListener("click", clearAvg);
    $("strap-hp-fc").addEventListener("input", (e) => setText("strap-hp-val", (+e.target.value).toFixed(1) + " Hz"));
    $("strap-hp-fc").addEventListener("change", sendHpCfg);
    $("strap-hp-on").addEventListener("change", sendHpCfg);
    $("avg-csv").addEventListener("click", downloadAvg);
    const ns = $("notch-sel");
    ns.value = String(notch.f0 || 0);
    ns.addEventListener("change", () => {
      notchPref = notch.f0 = +ns.value;
      try { localStorage.setItem("hrm.notch", ns.value); } catch (e) {}
      notch.refilter();
    });
    $("scan-btn").addEventListener("click", () => { devScanning = true; renderDevices(); send({ cmd: "scan" }); });
    renderDevices();
  }

  function handle(msg) {
    switch (msg.type) {
      case "ecg": stream("ecg", msg); break;
      case "rr": onRr(msg); break;
      case "accel": setText("steps", msg.steps); stream("accel", msg); if (!msg.replay) ExLive.steps(msg.t, msg.steps); break;
      case "ectopy": onEctopy(msg); break;
      case "battery": onBattery(msg); break;
      case "status": onStatus(msg); break;
      case "devices": onDevices(msg); break;
      case "link": onLink(msg); break;
      case "raw": $("raw-note").hidden = msg.state !== "other"; break;
      case "ecg_info": onEcgInfo(msg); break;
      case "hp_cfg": onHpCfg(msg); break;
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
                      delay: () => delayNow, paused: () => paused, avgView: () => ({ ...avgView }),
                      trend: () => ({ t0: trendT0, n: trend.t.length,
                                      x: trendPlots && [trendPlots.hrv.scales.x.min, trendPlots.hrv.scales.x.max] }) };

  // ---------- init ----------
  window.addEventListener("load", () => {
    makeStrip();
    makeAvg();
    makeHrvTrend();
    RRHist.init({ canvas: "rh-canvas", stats: "rh-stats", span: "rh-span", normal: "rh-normal" });
    ExLive.init({ now: "ex-now", stats: "ex-stats", span: "ex-span", a1: "ex-a1", time: "ex-time", hrMax: "ex-hrmax", hrRest: "ex-hrrest" });
    initZoom();
    initPauseMeasure();
    initAvgTools();
    initDevicePicker();
    $("ecto-view-close").addEventListener("click", () => ectoShow(null));
    connect();
    new ResizeObserver(resize).observe($("strip-chart"));
    requestAnimationFrame(frame);
  });
})();
