/* Daily view of RR alternans: every recording's episodes (alternans.js, cached per
 * recording on the server), drawn per calendar day across the hours of the day,
 * with a table per day. Recordings without a valid cached result are analysed here,
 * with progress, and the result stored back. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const css = getComputedStyle(document.documentElement);
  const C = (n) => css.getPropertyValue(n).trim();
  const FONT = "11px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
  const ROW = 18, LEFT = 86, RIGHT = 10, TOP = 22;
  const pad = (v) => String(v).padStart(2, "0");
  const dayKey = (t) => { const d = new Date(t * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const midnight = (t) => { const d = new Date(t * 1000); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; };
  const hm = (t) => { const d = new Date(t * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  let sums = [], hits = [], scanning = false;

  // split [t0, t1] at midnights: [[dayStart, from s, to s], ...]
  function byDay(t0, t1) {
    const out = [];
    for (let m = midnight(t0); m < t1; m = midnight(m + 36 * 3600)) out.push([m, Math.max(t0, m) - m, Math.min(t1, midnight(m + 36 * 3600)) - m]);
    return out;
  }

  function days() {
    const map = new Map();
    const get = (m) => { const k = dayKey(m + 3600); if (!map.has(k)) map.set(k, { key: k, m, rec: [], eps: [], mon: 0, ids: new Set() }); return map.get(k); };
    for (const s of sums) {
      if (s.start == null) continue;
      for (const [h, sec] of s.mon || []) {                 // clock hours with signal (hours never straddle midnight)
        const d = get(midnight(h)); d.rec.push([h - d.m, h - d.m + 3600, Math.min(1, sec / 3600)]); d.mon += sec; d.ids.add(s.id);
      }
      for (const e of s.episodes || []) for (const [m, a, b] of byDay(e.t0, e.t1)) get(m).eps.push({ a, b, e, id: s.id });
    }
    return [...map.values()].sort((x, y) => y.m - x.m);
  }

  function draw() {
    const cv = $("a-map"), D = days(), dpr = devicePixelRatio || 1;
    const h = TOP + Math.max(1, D.length) * ROW + 8, w = cv.clientWidth;
    cv.style.height = h + "px"; cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr); ctx.font = FONT;
    const X = (s) => LEFT + s / 86400 * (w - LEFT - RIGHT);
    ctx.fillStyle = C("--muted"); ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    for (let hr = 0; hr <= 24; hr += 3) {
      ctx.fillText(pad(hr) + ":00", X(hr * 3600), 13);
      ctx.strokeStyle = C("--grid"); ctx.beginPath(); ctx.moveTo(X(hr * 3600) + 0.5, TOP - 4); ctx.lineTo(X(hr * 3600) + 0.5, h - 6); ctx.stroke();
    }
    hits = [];
    D.forEach((d, i) => {
      const y = TOP + i * ROW;
      ctx.fillStyle = C("--muted"); ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(d.key, LEFT - 8, y + ROW / 2);
      for (const [a, b, f] of d.rec) {                        // grey: share of the hour with signal
        ctx.fillStyle = `rgba(139,150,165,${(0.08 + 0.3 * f).toFixed(3)})`;
        ctx.fillRect(X(a), y + 4, Math.max(1, X(b) - X(a)), ROW - 8);
      }
      ctx.fillStyle = "#ffb454";
      for (const p of d.eps) {
        const x0 = X(p.a), x1 = Math.max(x0 + 2, X(p.b));
        ctx.fillRect(x0, y + 2, x1 - x0, ROW - 4);
        hits.push({ x0: x0 - 2, x1: x1 + 2, y0: y, y1: y + ROW, p });
      }
    });
    if (!D.length) { ctx.fillStyle = C("--muted"); ctx.textAlign = "left"; ctx.fillText("no recordings", LEFT, TOP + 10); }
    table(D);
  }

  function table(D) {
    const fm = (s) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : `${Math.round(s / 60)} min`);
    $("a-table").innerHTML = `<thead><tr><th>day</th><th>recorded</th><th>episodes</th><th>total</th><th>% of recorded</th><th>when (duration)</th></tr></thead><tbody>` +
      D.map((d) => {
        const tot = d.eps.reduce((s, p) => s + p.b - p.a, 0);
        return `<tr data-k="${d.key}"><td>${d.key}</td><td>${fm(d.mon)}</td><td>${d.eps.length}</td><td>${d.eps.length ? fm(tot) : "–"}</td>` +
          `<td>${d.mon ? (100 * tot / d.mon).toFixed(1) + " %" : "–"}</td>` +
          `<td style="text-align:left">${d.eps.slice(0, 12).map((p) => `${hm(d.m + p.a)} (${Math.max(1, Math.round((p.b - p.a) / 60))}′)`).join(" · ")}${d.eps.length > 12 ? " …" : ""}</td></tr>`;
      }).join("") + "</tbody>";
    for (const tr of $("a-table").querySelectorAll("tbody tr")) {
      const d = D.find((x) => x.key === tr.dataset.k);
      if (d && d.eps.length) tr.addEventListener("click", () => open(d.eps[0]));
    }
  }

  function open(p) {
    window.open(`/review#s=${p.id}&a=${(p.e.t0 - 120).toFixed(1)}&b=${(p.e.t1 + 120).toFixed(1)}&e=${(p.e.t0 + 5).toFixed(1)}`, "_blank");
  }
  $("a-map").addEventListener("click", (ev) => {
    const r = $("a-map").getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    const h = hits.find((q) => x >= q.x0 && x <= q.x1 && y >= q.y0 && y <= q.y1);
    if (h) open(h.p);
  });
  $("a-map").addEventListener("mousemove", (ev) => {
    const r = $("a-map").getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
    const h = hits.find((q) => x >= q.x0 && x <= q.x1 && y >= q.y0 && y <= q.y1);
    $("a-map").style.cursor = h ? "pointer" : "";
    $("a-map").title = h ? `${hm(h.p.e.t0)}–${hm(h.p.e.t1)} · ${h.p.e.n} beats · short ${Math.round(h.p.e.shortMean)} / long ${Math.round(h.p.e.longMean)} ms` : "";
  });

  async function scan(force) {
    if (scanning) return;
    scanning = true;
    try {
      $("a-info").textContent = "reading the cache…";
      const list = await (await fetch("/api/alternans")).json();
      const valid = (s) => Alternans.valid(s);
      sums = list.filter((s) => !force && valid(s)).map((s) => s.cached);
      const todo = list.filter((s) => force || !valid(s));
      draw();
      for (let i = 0; i < todo.length; i++) {
        $("a-info").textContent = `analysing recordings… ${i + 1} / ${todo.length}`;
        const r = await Alternans.forSession(todo[i].id, null, true);
        if (r.summary) { sums.push(r.summary); if (i % 5 === 4 || i === todo.length - 1) draw(); }
      }
      draw();
      const n = sums.reduce((s, x) => s + (x.episodes ? x.episodes.length : 0), 0);
      $("a-info").textContent = `${sums.length} recordings · ${n} episodes` + (todo.length ? ` · ${todo.length} analysed now, the rest from the cache` : " · all from the cache");
    } catch (e) {
      $("a-info").textContent = "could not scan: " + e;
    } finally {
      scanning = false;
    }
  }
  $("a-rescan").addEventListener("click", () => scan(true));
  // multi-day report: the range defaults to the last 30 days
  {
    const p2 = (n) => String(n).padStart(2, "0"), ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
    const now = new Date(), ago = new Date(now); ago.setDate(now.getDate() - 29);
    $("a-from").value = ymd(ago); $("a-to").value = ymd(now);
    const link = () => {
      let f = $("a-from").value, t = $("a-to").value;
      if (f && t && f > t) [f, t] = [t, f];
      $("a-report").href = `/report#from=${f}&to=${t}`;
    };
    $("a-from").addEventListener("change", link); $("a-to").addEventListener("change", link); link();
  }
  let rt = 0;
  addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(draw, 150); });
  scan(false);
})();
