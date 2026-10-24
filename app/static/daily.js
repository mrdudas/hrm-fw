/* Daily summary page: resting HRV day by day against your own baseline.
 * The resting windows (5 min, strap still, clean beats) come from
 * /api/rest (recordings.rest_windows); this groups them into days, takes the
 * day's median, and draws it with a 7-day rolling mean and the normal range
 * (mean ± 0.5 SD of the preceding 30 days, the "smallest worthwhile change"
 * used for lnRMSSD-guided training, Plews et al. 2013). */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const css = getComputedStyle(document.documentElement);
  const C = (name) => css.getPropertyValue(name).trim();
  const COL = { text: C("--muted"), grid: C("--grid"), fg: C("--text"), dot: C("--ecg"), worse: C("--warn"),
                better: C("--x"), hr: C("--hr"), band: "rgba(75,209,160,0.13)", mean: C("--text") };
  const FONT = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  const dpr = () => window.devicePixelRatio || 1;
  const LEFT = 54, RIGHT = 10;
  const BASE_DAYS = 30, BASE_MIN = 5, ROLL_DAYS = 7, ROLL_MIN = 3, SWC = 0.5;

  // higher: which direction is good (colours the days outside the normal range)
  const METRICS = [
    { id: "c-ln", key: "ln", label: "lnRMSSD", d: 2, higher: "better", h: 190,
      fmt: (v) => `${v.toFixed(2)} (${Math.exp(v).toFixed(0)} ms)` },
    { id: "c-dc", key: "dc", label: "DC ms", d: 1, higher: "better", h: 170,
      refs: [[4.5, "4.5"], [2.5, "2.5"]], fmt: (v) => `${v.toFixed(1)} ms` },
    { id: "c-hr", key: "hr", label: "rest HR bpm", d: 0, higher: "worse", h: 170,
      fmt: (v) => `${v.toFixed(0)} bpm` },
  ];

  let wins = [];            // all resting windows from the server
  let days = [];            // [{key, date, wins, ln, dc, hr, min, ...}]
  let slots = [];           // every date from the first to the last day
  let hits = [];            // per canvas: drawn window dots, for hover / click

  const pad = (v) => String(v).padStart(2, "0");
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fmtTime = (t) => { const d = new Date(t * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const meanSd = (a) => { const m = a.reduce((s, v) => s + v, 0) / a.length; return [m, Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, a.length - 1))]; };

  // ---------- grouping ----------
  // mode -> which windows count and which date they belong to; [start, length]
  // of the day's slot in hours from that date's midnight (dots spread over it)
  const MODES = {
    night: { take: (h) => h >= 21 || h < 9, shift: 6, slot: [-3, 12] },
    day:   { take: (h) => h >= 9 && h < 21, shift: 0, slot: [9, 12] },
    all:   { take: () => true, shift: 6, slot: [-6, 24] },
  };
  let mode = MODES.night;

  function group() {
    mode = MODES[$("d-mode").value] || MODES.night;
    const accOnly = $("d-acc").checked, minW = Math.max(1, +$("d-min").value || 1);
    const by = new Map();
    for (const w of wins) {
      if (accOnly && w.still !== true) continue;
      const d = new Date(w.t * 1000);
      if (!mode.take(d.getHours())) continue;
      const key = dateKey(new Date((w.t + mode.shift * 3600) * 1000));
      if (!by.has(key)) by.set(key, []);
      by.get(key).push(w);
    }
    days = [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([key, ws]) => {
      const [y, m, dd] = key.split("-").map(Number);
      const mid = new Date(y, m - 1, dd).getTime() / 1000;
      const dcw = ws.filter((w) => w.dc != null);
      const anchors = dcw.reduce((s, w) => s + w.anchors, 0);
      return {
        key, mid, wins: ws, ok: ws.length >= minW, min: ws.length * 5,
        ln: median(ws.map((w) => w.ln).filter((v) => v != null)),
        hr: median(ws.map((w) => w.hr)),
        // pooled over the day's anchors (= anchor-weighted mean of the windows)
        dc: anchors ? dcw.reduce((s, w) => s + w.dc * w.anchors, 0) / anchors : null,
        sessions: [...new Set(ws.map((w) => w.ses))],
        unchecked: ws.filter((w) => w.still !== true).length,
      };
    });
    // baseline: 7-day rolling mean, normal range from the 30 days before
    const DAY = 86400;
    for (const d of days) {
      for (const m of METRICS) {
        const past = (n, incl) => days.filter((e) => e.ok && e[m.key] != null &&
          e.mid <= d.mid - (incl ? 0 : DAY / 2) && e.mid > d.mid - n * DAY + DAY / 2).map((e) => e[m.key]);
        const r = past(ROLL_DAYS, true);
        d[m.key + "Roll"] = r.length >= ROLL_MIN ? meanSd(r)[0] : null;
        const b = past(BASE_DAYS + 1, false);
        if (b.length >= BASE_MIN) {
          const [mu, sd] = meanSd(b);
          d[m.key + "Band"] = [mu - SWC * sd, mu + SWC * sd];
        } else d[m.key + "Band"] = null;
        const band = d[m.key + "Band"], v = d[m.key];
        d[m.key + "St"] = !d.ok || band == null || v == null ? null
          : v < band[0] ? (m.higher === "better" ? "worse" : "better")
          : v > band[1] ? (m.higher === "better" ? "better" : "worse") : "normal";
      }
    }
    slots = [];
    if (days.length) {
      const [y, m, dd] = days[0].key.split("-").map(Number);
      for (let d = new Date(y, m - 1, dd, 12); dateKey(d) <= days[days.length - 1].key; d.setDate(d.getDate() + 1))
        slots.push(dateKey(d));
    }
    const nAll = wins.length, nChk = wins.filter((w) => w.still === true).length;
    $("d-info").textContent = `${days.filter((d) => d.ok).length} days · ${nAll} resting windows (${nChk} movement-checked)`;
  }

  // ---------- drawing ----------
  function setup(cv, h) {
    const w = cv.clientWidth;
    cv.style.height = h + "px";
    cv.width = Math.round(w * dpr()); cv.height = Math.round(h * dpr());
    const ctx = cv.getContext("2d");
    ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = FONT;
    return { ctx, w, h };
  }
  const slotOf = (key) => slots.indexOf(key);
  function xs(w) {
    const n = Math.max(1, slots.length), sw = (w - LEFT - RIGHT) / n;
    return { sw, x: (i) => LEFT + (i + 0.5) * sw, left: (i) => LEFT + i * sw };
  }
  // where a window sits inside its day's slot (time order)
  function winX(X, d, w) {
    const frac = Math.min(1, Math.max(0, ((w.t - d.mid) / 3600 - mode.slot[0]) / mode.slot[1]));
    return X.left(slotOf(d.key)) + X.sw * (0.12 + 0.76 * frac);
  }

  function niceTicks(lo, hi, n) {
    const step0 = (hi - lo) / n, p = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= step0) || step0;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
  }

  function xAxis(ctx, X, top, bottom, labels) {
    ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
    const every = Math.max(1, Math.ceil(46 / X.sw));
    slots.forEach((k, i) => {
      if (i % every) return;
      ctx.beginPath(); ctx.moveTo(X.left(i), top); ctx.lineTo(X.left(i), bottom); ctx.stroke();
      if (labels) { ctx.fillStyle = COL.text; ctx.textAlign = "center"; ctx.fillText(k.slice(5), X.x(i), bottom + 13); }
    });
  }

  function drawMetric(m) {
    const cv = $(m.id), { ctx, w, h } = setup(cv, m.h), X = xs(w);
    const top = 8, bottom = h - 6;
    const vals = [];
    for (const d of days) for (const wn of d.wins) if (wn[m.key] != null) vals.push(wn[m.key]);
    for (const d of days) { const b = d[m.key + "Band"]; if (b) vals.push(b[0], b[1]); }
    hits[m.id] = [];
    if (!vals.length) { ctx.fillStyle = COL.text; ctx.fillText("no resting windows", LEFT + 8, top + 16); return; }
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (m.refs) for (const [v] of m.refs) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const padv = (hi - lo) * 0.08 || 1; lo -= padv; hi += padv;
    const y = (v) => bottom - (v - lo) / (hi - lo) * (bottom - top);
    // grid + y axis
    ctx.textAlign = "right"; ctx.strokeStyle = COL.grid; ctx.fillStyle = COL.text;
    for (const v of niceTicks(lo, hi, 4)) {
      ctx.beginPath(); ctx.moveTo(LEFT, y(v)); ctx.lineTo(w - RIGHT, y(v)); ctx.stroke();
      ctx.fillText(v.toFixed(m.d === 0 ? 0 : v % 1 ? m.d : 0), LEFT - 6, y(v) + 4);
    }
    xAxis(ctx, X, top, bottom, false);
    ctx.save(); ctx.translate(12, (top + bottom) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center";
    ctx.fillText(m.label, 0, 0); ctx.restore();
    if (m.refs) {
      ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = "rgba(139,150,165,0.55)"; ctx.textAlign = "left";
      for (const [v, label] of m.refs) {
        ctx.beginPath(); ctx.moveTo(LEFT, y(v)); ctx.lineTo(w - RIGHT, y(v)); ctx.stroke();
        ctx.fillText(label, LEFT + 4, y(v) - 3);
      }
      ctx.restore();
    }
    // normal range band, per day slot
    ctx.fillStyle = COL.band;
    for (const d of days) {
      const b = d[m.key + "Band"]; if (!b) continue;
      const i = slotOf(d.key);
      ctx.fillRect(X.left(i), y(b[1]), X.sw, y(b[0]) - y(b[1]));
    }
    // window dots
    for (const d of days) for (const wn of d.wins) {
      const v = wn[m.key]; if (v == null) continue;
      const px = winX(X, d, wn), py = y(v);
      ctx.globalAlpha = d.ok ? 0.55 : 0.25;
      ctx.beginPath(); ctx.arc(px, py, 2.2, 0, 2 * Math.PI);
      if (wn.still === true) { ctx.fillStyle = COL.dot; ctx.fill(); }
      else { ctx.strokeStyle = COL.dot; ctx.lineWidth = 1; ctx.stroke(); }
      hits[m.id].push({ x: px, y: py, w: wn, d });
    }
    ctx.globalAlpha = 1;
    // 7-day rolling mean
    ctx.strokeStyle = COL.mean; ctx.lineWidth = 1.5; ctx.beginPath();
    let pen = false, prev = -9;
    for (const d of days) {
      const v = d[m.key + "Roll"], i = slotOf(d.key);
      if (v == null || i - prev > ROLL_DAYS) { pen = false; }
      if (v == null) continue;
      if (pen) ctx.lineTo(X.x(i), y(v)); else ctx.moveTo(X.x(i), y(v));
      pen = true; prev = i;
    }
    ctx.stroke();
    // day medians
    for (const d of days) {
      const v = d[m.key]; if (v == null || !d.ok) continue;
      const st = d[m.key + "St"];
      ctx.fillStyle = st === "worse" ? COL.worse : st === "better" ? COL.better : COL.fg;
      ctx.beginPath(); ctx.arc(X.x(slotOf(d.key)), y(v), 4.5, 0, 2 * Math.PI); ctx.fill();
      ctx.strokeStyle = "#0e1116"; ctx.lineWidth = 1.5; ctx.stroke();
    }
  }

  function drawCount() {
    const cv = $("c-n"), { ctx, w, h } = setup(cv, 78), X = xs(w);
    const top = 6, bottom = h - 18;
    const hi = Math.max(30, ...days.map((d) => d.min));
    const y = (v) => bottom - v / hi * (bottom - top);
    xAxis(ctx, X, top, bottom, true);
    ctx.fillStyle = COL.text; ctx.textAlign = "right";
    ctx.fillText(`${hi} min`, LEFT - 6, top + 8); ctx.fillText("0", LEFT - 6, bottom);
    ctx.save(); ctx.translate(12, (top + bottom) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center";
    ctx.fillText("rest", 0, 0); ctx.restore();
    for (const d of days) {
      const i = slotOf(d.key), bw = Math.max(2, X.sw * 0.6);
      const chk = (d.wins.length - d.unchecked) * 5;
      ctx.fillStyle = COL.dot; ctx.globalAlpha = d.ok ? 0.8 : 0.35;
      ctx.fillRect(X.x(i) - bw / 2, y(chk), bw, bottom - y(chk));
      ctx.globalAlpha = d.ok ? 0.3 : 0.15;
      ctx.fillRect(X.x(i) - bw / 2, y(d.min), bw, y(chk) - y(d.min));
    }
    ctx.globalAlpha = 1;
  }

  function draw() {
    for (const m of METRICS) drawMetric(m);
    drawCount();
  }

  // ---------- hover / click ----------
  const f = (v, d) => (v == null ? "–" : v.toFixed(d));
  function dayText(d) {
    const st = (k) => (d[k + "St"] && d[k + "St"] !== "normal" ? ` <i class="d-key ${d[k + "St"]}">${d[k + "St"]}</i>` : "");
    return `<b>${d.key}</b> · ${d.wins.length} windows (${d.min} min${d.unchecked ? `, ${d.unchecked} not movement-checked` : ""})` +
      ` · lnRMSSD <b>${f(d.ln, 2)}</b> (${d.ln == null ? "–" : Math.exp(d.ln).toFixed(0)} ms)${st("ln")}` +
      ` · DC <b>${f(d.dc, 1)}</b> ms${st("dc")} · HR <b>${f(d.hr, 0)}</b>${st("hr")}` +
      (d.lnRoll != null ? ` · 7-day lnRMSSD ${d.lnRoll.toFixed(2)}` : "") +
      (d.lnBand ? ` · normal ${d.lnBand[0].toFixed(2)}–${d.lnBand[1].toFixed(2)}` : "") +
      (d.ok ? "" : " · too few windows");
  }
  function winText(w) {
    return `<b>${new Date(w.t * 1000).toLocaleDateString()} ${fmtTime(w.t - 150)}–${fmtTime(w.t + 150)}</b> · HR <b>${w.hr.toFixed(0)}</b>` +
      ` · RMSSD <b>${w.rmssd.toFixed(1)}</b> ms (ln ${f(w.ln, 2)}) · SDNN ${w.sdnn.toFixed(1)} · DC <b>${f(w.dc, 1)}</b>` +
      ` · ${(100 * w.bad).toFixed(1)} % corrected · ${w.still === true ? "still" : "movement not checked"} · click: open`;
  }
  const reviewUrl = (w) => `/review#s=${w.ses}&a=${Math.round(w.t - 150)}&b=${Math.round(w.t + 150)}`;
  function pick(cv, ev) {
    const r = cv.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
    let best = null, bd = 49;
    for (const p of hits[cv.id] || []) {
      const dd = (p.x - mx) ** 2 + (p.y - my) ** 2;
      if (dd < bd) { bd = dd; best = p; }
    }
    if (best) return { win: best.w, day: best.d };
    const X = xs(cv.clientWidth), i = Math.floor((mx - LEFT) / X.sw);
    const day = days.find((d) => d.key === slots[i]);
    return day ? { day } : null;
  }
  for (const id of [...METRICS.map((m) => m.id), "c-n"]) {
    const cv = $(id);
    cv.addEventListener("mousemove", (ev) => {
      const p = pick(cv, ev);
      $("d-readout").innerHTML = p ? (p.win ? winText(p.win) : dayText(p.day)) : "&nbsp;";
      cv.style.cursor = p && p.win ? "pointer" : "default";
    });
    cv.addEventListener("click", (ev) => {
      const p = pick(cv, ev);
      if (p) window.open(reviewUrl(p.win || p.day.wins[0]), "_blank");
    });
  }

  // ---------- table ----------
  function table() {
    const cls = (st) => (st && st !== "normal" ? ` class="d-key ${st}"` : "");
    const rows = [...days].reverse().map((d) =>
      `<tr data-key="${d.key}"${d.ok ? "" : ' class="d-few"'}><td>${d.key}</td><td>${d.wins.length}</td>` +
      `<td${cls(d.lnSt)}>${f(d.ln, 2)}</td><td>${d.ln == null ? "–" : Math.exp(d.ln).toFixed(0)}</td>` +
      `<td>${f(d.lnRoll, 2)}</td><td>${d.lnBand ? d.lnBand.map((v) => v.toFixed(2)).join("–") : "–"}</td>` +
      `<td${cls(d.dcSt)}>${f(d.dc, 1)}</td><td${cls(d.hrSt)}>${f(d.hr, 0)}</td>` +
      `<td>${d.unchecked ? `${d.wins.length - d.unchecked} / ${d.wins.length}` : "all"}</td></tr>`);
    $("d-table").innerHTML =
      "<thead><tr><th>day</th><th>windows</th><th>lnRMSSD</th><th>RMSSD ms</th><th>7-day</th><th>normal</th>" +
      "<th>DC ms</th><th>HR</th><th>still</th></tr></thead><tbody>" + rows.join("") + "</tbody>";
  }
  $("d-table").addEventListener("click", (ev) => {
    const tr = ev.target.closest("tr[data-key]");
    const d = tr && days.find((e) => e.key === tr.dataset.key);
    if (d) window.open(reviewUrl(d.wins[0]), "_blank");
  });

  // ---------- settings ----------
  const IDS = ["d-mode", "d-acc", "d-min"];
  try {
    const s = JSON.parse(localStorage.getItem("hrm.daily") || "{}");
    if (s.mode) $("d-mode").value = s.mode;
    if (s.acc != null) $("d-acc").checked = s.acc;
    if (s.min) $("d-min").value = s.min;
  } catch (e) {}
  function update() {
    try { localStorage.setItem("hrm.daily", JSON.stringify({ mode: $("d-mode").value, acc: $("d-acc").checked, min: $("d-min").value })); } catch (e) {}
    group(); draw(); table();
  }
  for (const id of IDS) $(id).addEventListener("change", update);
  let rt = 0;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(draw, 150); });

  async function load() {
    $("d-info").textContent = "finding resting windows in the recordings… (the first time takes a while)";
    const r = await fetch("/api/rest");
    if (!r.ok) { $("d-info").textContent = "could not load: " + r.status; return; }
    wins = await r.json();
    update();
  }
  load();
})();
