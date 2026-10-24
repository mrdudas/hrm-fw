/* RR histogram of the live session: the distribution of the strap's RR
 * intervals over a chosen time span (1 min .. the whole session), refined
 * with every beat. Bars: % of beats per bin; curve: Gaussian kernel density
 * estimate; vertical line: the latest RR, with its percentile.
 *
 * On page load the span is filled from the session being recorded
 * (/api/current -> /api/sessions/<id>), so a reload does not start it over.
 *
 * Plain script: defines window.RRHist ({ init, add }).
 */
(function (root) {
  "use strict";

  const RR_MIN = 250, RR_MAX = 2500;          // ms: outside is not a heartbeat
  const SPANS = [[60, "1 min"], [300, "5 min"], [900, "15 min"], [1800, "30 min"], [3600, "1 h"],
                 [7200, "2 h"], [14400, "4 h"], [43200, "12 h"], [0, "∞ whole session"]];
  const COL = { bar: "rgba(75,209,160,0.28)", curve: "#4bd1a0", now: "#ff5470", med: "#8b96a5",
                text: "#8b96a5", grid: "#232936", fg: "#e6edf3" };
  const FONT = "11px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

  const beats = [];                           // { t, rr } in arrival order
  let head = 0;                               // first beat inside the span
  const counts = new Int32Array(RR_MAX + 1);  // beats per 1 ms, inside the span
  let n = 0, sum = 0, sum2 = 0;
  let span = 900, normalOnly = false;
  let last = null;                            // latest accepted RR
  let liveT0 = null;                          // arrival time of the first live beat
  let el = null, dirty = true;
  const recent = [];                          // last accepted RRs (artifact check)

  try {
    const s = JSON.parse(localStorage.getItem("hrm.rrhist") || "{}");
    if (SPANS.some(([v]) => v === s.span)) span = s.span;
    normalOnly = !!s.normalOnly;
  } catch (e) {}
  const save = () => { try { localStorage.setItem("hrm.rrhist", JSON.stringify({ span, normalOnly })); } catch (e) {} };

  // normal beat: within 20 % of the median of the previous 9
  function isNormal(rr) {
    if (recent.length < 5) return true;
    const s = recent.slice().sort((a, b) => a - b), m = s[s.length >> 1];
    return Math.abs(rr - m) <= 0.2 * m;
  }

  function put(t, rr) {
    if (!(rr >= RR_MIN && rr <= RR_MAX)) return;
    const ok = isNormal(rr);
    recent.push(rr); if (recent.length > 9) recent.shift();
    if (normalOnly && !ok) return;
    rr = Math.round(rr);
    beats.push({ t, rr });
    counts[rr]++; n++; sum += rr; sum2 += rr * rr;
    last = rr;
  }

  function expire(now) {
    if (!span) return;
    while (head < beats.length && beats[head].t < now - span) {
      const rr = beats[head++].rr;
      counts[rr]--; n--; sum -= rr; sum2 -= rr * rr;
    }
    if (head > 50000 && head > beats.length / 2) { beats.splice(0, head); head = 0; }
  }

  // rebuild the counts (span or filter changed): from all beats kept so far
  let all = [];                               // every beat seen (t, rr), for rebuilding
  function rebuild() {
    beats.length = 0; head = 0; counts.fill(0); n = sum = sum2 = 0; recent.length = 0; last = null;
    for (const b of all) put(b.t, b.rr);
    expire(Date.now() / 1000);
    dirty = true;
  }

  function add(t, rrList) {
    if (liveT0 == null) liveT0 = t;
    for (const rr of rrList) { all.push({ t, rr }); put(t, rr); }
    if (all.length > 200000) all = all.slice(-150000);
    expire(t);
    dirty = true;
  }

  // ---------- drawing ----------
  function percentile(v) {
    let below = 0;
    for (let i = RR_MIN; i < v; i++) below += counts[i];
    return n ? 100 * (below + counts[v] / 2) / n : null;
  }
  function quantile(p) {
    let c = 0, k = p * n;
    for (let i = RR_MIN; i <= RR_MAX; i++) { c += counts[i]; if (c >= k) return i; }
    return null;
  }

  function draw() {
    if (!el || !dirty) return;
    dirty = false;
    const cv = el.canvas, W = cv.clientWidth, H = cv.clientHeight, k = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * k) || cv.height !== Math.round(H * k)) { cv.width = Math.round(W * k); cv.height = Math.round(H * k); }
    const ctx = cv.getContext("2d");
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.font = FONT;
    if (n < 2) {
      ctx.fillStyle = COL.text; ctx.fillText("waiting for beats…", 50, H / 2);
      el.stats.textContent = "";
      return;
    }
    const mean = sum / n, sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
    const q01 = quantile(0.005), q25 = quantile(0.25), med = quantile(0.5), q75 = quantile(0.75), q99 = quantile(0.995);
    // x range: the bulk of the distribution and the current beat, on 50 ms steps
    let x0 = Math.min(q01, last) - Math.max(30, sd), x1 = Math.max(q99, last) + Math.max(30, sd);
    x0 = Math.max(RR_MIN, Math.floor(x0 / 50) * 50); x1 = Math.min(RR_MAX, Math.ceil(x1 / 50) * 50);
    // bin width: finer as beats accumulate
    const bw = n < 150 ? 20 : n < 1000 ? 10 : 5;
    const bins = [];
    for (let b = Math.floor(x0 / bw) * bw; b < x1; b += bw) {
      let c = 0;
      for (let i = Math.max(RR_MIN, b); i < Math.min(RR_MAX + 1, b + bw); i++) c += counts[i];
      bins.push([b, 100 * c / n]);
    }
    // kernel density (Silverman's rule), scaled to % per bin like the bars
    const iqr = q75 - q25;
    const h = Math.max(3, 0.9 * Math.min(sd, iqr > 0 ? iqr / 1.34 : sd) * Math.pow(n, -0.2));
    const step = Math.max(1, (x1 - x0) / 400), dens = [];
    const lo = Math.max(RR_MIN, Math.floor(x0 - 4 * h)), hi = Math.min(RR_MAX, Math.ceil(x1 + 4 * h));
    for (let x = x0; x <= x1; x += step) {
      let s = 0;
      const a = Math.max(lo, Math.floor(x - 4 * h)), b = Math.min(hi, Math.ceil(x + 4 * h));
      for (let i = a; i <= b; i++) if (counts[i]) s += counts[i] * Math.exp(-0.5 * ((x - i) / h) ** 2);
      dens.push([x, 100 * bw * s / (n * h * Math.sqrt(2 * Math.PI))]);
    }
    let mode = null, dmax = 0;
    for (const [x, d] of dens) if (d > dmax) { dmax = d; mode = x; }
    const ymax = Math.max(dmax, ...bins.map((b) => b[1])) * 1.12 || 1;

    const L = 46, R = 12, T = 20, B = 26, w = W - L - R, hh = H - T - B;
    const X = (v) => L + (v - x0) / (x1 - x0) * w, Y = (v) => T + hh - v / ymax * hh;
    // grid + axes
    ctx.strokeStyle = COL.grid; ctx.lineWidth = 1; ctx.fillStyle = COL.text;
    const xs = niceStep((x1 - x0) / 8);
    ctx.textAlign = "center";
    for (let v = Math.ceil(x0 / xs) * xs; v <= x1; v += xs) {
      ctx.beginPath(); ctx.moveTo(X(v), T); ctx.lineTo(X(v), T + hh); ctx.stroke();
      ctx.fillText(v, X(v), T + hh + 14);
      ctx.fillText(Math.round(60000 / v), X(v), T - 6);          // the same tick in bpm
    }
    ctx.textAlign = "left"; ctx.fillText("bpm", 4, T - 6); ctx.fillText("ms", 4, T + hh + 14);
    const ys = niceStep(ymax / 4);
    ctx.textAlign = "right";
    for (let v = ys; v < ymax; v += ys) {
      ctx.beginPath(); ctx.moveTo(L, Y(v)); ctx.lineTo(L + w, Y(v)); ctx.stroke();
      ctx.fillText(v.toFixed(ys < 1 ? 1 : 0) + " %", L - 5, Y(v) + 4);
    }
    // bars
    ctx.fillStyle = COL.bar;
    for (const [b, p] of bins) {
      const xa = X(Math.max(x0, b)), xb = X(Math.min(x1, b + bw));
      ctx.fillRect(xa + 0.5, Y(p), Math.max(1, xb - xa - 1), T + hh - Y(p));
    }
    // density curve
    ctx.strokeStyle = COL.curve; ctx.lineWidth = 2; ctx.beginPath();
    dens.forEach(([x, d], i) => (i ? ctx.lineTo(X(x), Y(d)) : ctx.moveTo(X(x), Y(d))));
    ctx.stroke();
    // median (dashed) and the current beat
    ctx.setLineDash([4, 4]); ctx.strokeStyle = COL.med; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(med), T); ctx.lineTo(X(med), T + hh); ctx.stroke();
    ctx.setLineDash([]);
    const pc = percentile(last);
    ctx.strokeStyle = COL.now; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(X(last), T); ctx.lineTo(X(last), T + hh); ctx.stroke();
    const lbl = `${last} ms · ${Math.round(pc)}. percentile`;
    ctx.font = "600 " + FONT; ctx.fillStyle = COL.now;
    const tw = ctx.measureText(lbl).width;
    const right = X(last) + 6 + tw < L + w;
    ctx.textAlign = right ? "left" : "right";
    ctx.fillText(lbl, X(last) + (right ? 6 : -6), T + 12);

    const spanTxt = beats.length > head ? fmtDur(beats[beats.length - 1].t - beats[head].t) : "";
    el.stats.textContent = `${n} beats over ${spanTxt} · mean ${Math.round(mean)} ms · median ${med} · SD ${sd.toFixed(1)} · ` +
      `IQR ${q25}–${q75} · peak ${Math.round(mode)} ms (${Math.round(60000 / mode)} bpm)`;
  }

  function niceStep(r) {
    const e = 10 ** Math.floor(Math.log10(r)), m = r / e;
    return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * e;
  }
  function fmtDur(s) {
    s = Math.round(s);
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
    return h ? `${h} h ${String(m).padStart(2, "0")} min` : m ? `${m} min ${String(r).padStart(2, "0")} s` : `${r} s`;
  }

  // ---------- setup ----------
  async function prefill() {
    try {
      const cur = await (await fetch("/api/current")).json();
      if (!cur.id) return;
      const r = await fetch("/api/sessions/" + cur.id);
      if (!r.ok) return;
      const b = (await r.json()).beats;
      // beats recorded before this page got its first live one
      const old = [];
      for (let i = 0; i < b.t.length; i++) if (liveT0 == null || b.t[i] < liveT0 - 0.5) old.push({ t: b.t[i], rr: b.rr[i] });
      all = old.concat(all);
      rebuild();
    } catch (e) { /* older backend or no session yet: start empty */ }
  }

  function init(ids) {
    el = { canvas: document.getElementById(ids.canvas), stats: document.getElementById(ids.stats) };
    const sel = document.getElementById(ids.span);
    for (const [v, label] of SPANS) {
      const o = document.createElement("option");
      o.value = v; o.textContent = label;
      sel.appendChild(o);
    }
    sel.value = span;
    sel.addEventListener("change", () => { span = +sel.value; save(); rebuild(); });
    const cb = document.getElementById(ids.normal);
    cb.checked = normalOnly;
    cb.addEventListener("change", () => { normalOnly = cb.checked; save(); rebuild(); });
    new ResizeObserver(() => { dirty = true; draw(); }).observe(el.canvas);
    setInterval(() => { expire(Date.now() / 1000); draw(); }, 1000);
    prefill();
  }

  // draw soon after a beat, but at most a few times a second
  let raf = 0;
  function addAndDraw(t, rrList) {
    add(t, rrList);
    if (!raf) raf = setTimeout(() => { raf = 0; draw(); }, 200);
  }

  root.RRHist = { init, add: addAndDraw };
})(window);
