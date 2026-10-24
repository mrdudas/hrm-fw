/* Live exercise / fatigue card on the dashboard: the analysis of exercise.js
 * over the last N minutes of beats (and the strap's step counter), redone
 * every 10 s. Prefills from the session being recorded (/api/current ->
 * /api/sessions/<id>), so a reload does not start it over.
 *
 * Plain script: defines window.ExLive ({ init, add, steps }).
 */
(function (root) {
  "use strict";

  const SPANS = [[1800, "30 min"], [3600, "1 h"], [7200, "2 h"], [14400, "4 h"], [0, "session"]];
  const EVERY_MS = 10000, BIN_S = 10;

  let el = null, span = 3600, timer = 0;
  let T = [], RR = [];                 // beat times (strap order) and RR ms
  const act = { t: [], spm: [] };      // cadence per 10 s bin
  let lastSteps = null, binK = null, binSteps = 0, liveT0 = null;

  function add(t, rrList) {
    if (liveT0 == null) liveT0 = t;
    // the packet arrives after its last beat: earlier RRs in it end earlier
    let back = 0;
    for (let i = rrList.length - 1; i >= 0; i--) { T.push(null); RR.push(null); }
    for (let i = rrList.length - 1, j = T.length - 1; i >= 0; i--, j--) { T[j] = t - back / 1000; RR[j] = rrList[i]; back += rrList[i]; }
    if (T.length > 60000) { T = T.slice(-40000); RR = RR.slice(-40000); }
  }

  function steps(t, s) {
    const k = Math.floor(t / BIN_S);
    if (binK != null && k !== binK) {
      act.t.push(binK * BIN_S + BIN_S / 2); act.spm.push(binSteps * 60 / BIN_S);
      if (act.t.length > 3000) { act.t.splice(0, 1000); act.spm.splice(0, 1000); }
      binSteps = 0;
    }
    binK = k;
    if (lastSteps != null) {
      let d = s - lastSteps;
      if (d < 0) d += 65536;
      if (d <= 500) binSteps += d;         // more: the counter was reset (strap restart)
    }
    lastSteps = s;
  }

  async function prefill() {
    try {
      const cur = await (await fetch("/api/current")).json();
      if (!cur.id) return;
      const r = await fetch("/api/sessions/" + cur.id);
      if (!r.ok) return;
      const s = await r.json(), b = s.beats;
      const ot = [], orr = [];
      for (let i = 0; i < b.t.length; i++) if (liveT0 == null || b.t[i] < liveT0 - 0.5) { ot.push(b.t[i]); orr.push(b.rr[i]); }
      T = ot.concat(T); RR = orr.concat(RR);
      const a = s.activity || {};
      if (a.spm && a.spm.length) {
        const t0 = act.t.length ? act.t[0] : Infinity, keep = a.t.findIndex((x) => x >= t0);
        const n = keep < 0 ? a.t.length : keep;
        act.t.unshift(...a.t.slice(0, n)); act.spm.unshift(...a.spm.slice(0, n));
      }
      update();
    } catch (e) { /* no backend session: live only */ }
  }

  const f = (v, d = 0) => (v == null || !isFinite(v) ? "–" : v.toFixed(d));
  function update() {
    if (!el || T.length < 100) { if (el) el.stats.textContent = "waiting for beats…"; return; }
    // the prefill can land after the first live beats: keep the series in time order
    for (let i = 1; i < T.length; i++) if (T[i] < T[i - 1]) {
      const ix = T.map((_, k) => k).sort((x, y) => T[x] - T[y]);
      T = ix.map((k) => T[k]); RR = ix.map((k) => RR[k]);
      break;
    }
    for (let i = 1; i < act.t.length; i++) if (act.t[i] < act.t[i - 1]) {
      const ix = act.t.map((_, k) => k).sort((x, y) => act.t[x] - act.t[y]);
      const at = ix.map((k) => act.t[k]), as = ix.map((k) => act.spm[k]);
      act.t.length = 0; act.spm.length = 0; act.t.push(...at); act.spm.push(...as);
      break;
    }
    const tEnd = T[T.length - 1], tStart = span ? tEnd - span : T[0];
    let a = 0;
    while (a < T.length && T[a] < tStart) a++;
    const t = T.slice(a), rr = RR.slice(a);
    // breaks: a beat time jumping well ahead of its RR means lost beats
    const gap = new Uint8Array(t.length);
    for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] > rr[i] / 1000 + 2.5) gap[i] = 1;   // arrival jitter stays under this
    const cl = HRV.clean(rr, gap);
    const ath = Exercise.athlete();
    const R = Exercise.analyze(t, cl, act.t.length ? act : null, t[0], tEnd, { athlete: ath, maxBad: 5 });
    const v = Exercise.verdict(R), last = R.pts.length ? R.pts[R.pts.length - 1] : null;
    const fresh = last && tEnd - last.t < 90;
    const zone = last ? Math.round(100 * last.hr / ath.hrMax) : null;
    const thr = R.dur.all && R.dur.all.ok && R.dur.all.vt1In ? R.dur.all.vt1 : null;
    const where = fresh && last.a1 != null ? (last.a1 > 0.75 ? "below HRVT1 (easy, aerobic)" : last.a1 > 0.5 ? "between the thresholds" : "above HRVT2 (hard)") : "";
    el.now.innerHTML = fresh
      ? `α1 <b>${f(last.a1, 2)}</b> · HR <b>${f(last.hr)}</b> (${zone} % max) · ${where}${thr ? ` · HRVT1 ≈ <b>${f(thr)}</b> bpm` : ""}`
      : "α1 – (needs 2 min of clean, steady beats)";
    el.stats.innerHTML = `<b class="${v.cls}">${v.head}</b>${v.text ? " · " + v.text : ""}` +
      ` · TRIMP ${f(R.load.banister)} (Edwards ${f(R.load.edwards)})`;
    Exercise.renderA1(el.a1, R);
    Exercise.renderTime(el.time, R);
  }

  function init(ids) {
    el = { now: document.getElementById(ids.now), stats: document.getElementById(ids.stats),
           a1: document.getElementById(ids.a1), time: document.getElementById(ids.time) };
    const sel = document.getElementById(ids.span);
    for (const [v, label] of SPANS) {
      const o = document.createElement("option");
      o.value = v; o.textContent = label;
      sel.appendChild(o);
    }
    try { const s = localStorage.getItem("hrm.exspan"); if (s != null) span = +s; } catch (e) {}
    sel.value = String(span);
    sel.addEventListener("change", () => {
      span = +sel.value;
      try { localStorage.setItem("hrm.exspan", sel.value); } catch (e) {}
      update();
    });
    const ath = Exercise.athlete(), mx = document.getElementById(ids.hrMax), rs = document.getElementById(ids.hrRest);
    mx.value = ath.hrMax; rs.value = ath.hrRest;
    const save = () => { const a = Exercise.athlete(); a.hrMax = +mx.value || 190; a.hrRest = +rs.value || 60; Exercise.saveAthlete(a); update(); };
    mx.addEventListener("change", save); rs.addEventListener("change", save);
    timer = setInterval(update, EVERY_MS);
    let rt = 0;
    window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(update, 200); });
    prefill();
  }

  root.ExLive = { init, add, steps };
})(window);
