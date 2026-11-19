/* Live RR alternans: every 15 s the session being recorded is read back from the
 * server (the same beats the review page gets) and run through alternans.js, so the
 * live result is the saved-recording result. Shows the counts in the Ectopy panel,
 * the split average under the signal-averaged beat, saves each finished episode
 * (±30 s of every stream) as a clip, and handles Mark event / notes.
 * window.AltLive.inEpisode(t) lets the HRV card leave episode beats out. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const POLL_S = 15, SPLIT_EVERY_S = 60, SPLIT_SPAN_S = 180, CLIP_PAD_S = 30, MARK_PAD_S = 60;
  let sesId = null, res = null, eps = [], busy = false, lastSplit = 0, splitKey = "", plot = null;

  const clipped = (() => {                       // episodes already sent for clipping (per browser)
    try { return new Set(JSON.parse(localStorage.getItem("hrm.alt.clipped") || "[]")); } catch (e) { return new Set(); }
  })();
  const saveClipped = () => { try { localStorage.setItem("hrm.alt.clipped", JSON.stringify([...clipped].slice(-200))); } catch (e) { /* private mode */ } };

  function inEpisode(t) {
    for (const e of eps) if (t >= e.t0 - 1 && t <= (e.ongoing ? Infinity : e.t1 + 1)) return true;
    return false;
  }

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const cur = await (await fetch("/api/current")).json();
      if (!cur.id) { $("alt-stats").textContent = "not recording"; return; }
      if (cur.id !== sesId) { sesId = cur.id; lastSplit = 0; splitKey = ""; }
      const r = await fetch(`/api/sessions/${sesId}`);
      if (!r.ok) { $("alt-stats").textContent = "no beats recorded yet"; return; }
      const ses = await r.json();
      if (!ses.beats.t.length) { $("alt-stats").textContent = "no beats recorded yet"; return; }
      res = Alternans.detect(ses.beats, ses.ectopy);
      eps = res.episodes;
      show(ses);
      clips();
      await split(ses);
    } catch (e) {
      $("alt-stats").textContent = "alternans: " + e;
    } finally {
      busy = false;
    }
  }

  function show(ses) {
    const st = res.stats;
    $("alt-count").textContent = st.count;
    const artIn = (ses.ectopy || []).filter((e) => e[1] === "ARTIFACT" && inEpisode(e[0])).length;
    $("alt-stats").textContent = `This recording: ${AltView.statsText(st)}` +
      (st.count ? ` · ${st.short} ALT-SHORT / ${st.long} ALT-LONG beats` : "") +
      (artIn ? ` · ${artIn} of the strap's ARTIFACT labels fall inside episodes` : "") +
      (res.rejected.length ? ` · ${res.rejected.length} rejected (a beat counted twice)` : "");
    const last = eps[eps.length - 1], now = $("alt-now");
    if (last && last.ongoing) {
      now.className = "alt-now on";
      now.textContent = `● In an episode since ${AltView.clock(last.t0)} (${AltView.dur(last.dur)}) · short ${Math.round(last.shortMean)} / long ${Math.round(last.longMean)} ms · |ΔRR| ${Math.round(last.medDelta)} ms · prematurity ${last.prematurity.toFixed(2)} (vs median long RR) · HRV leaves it out`;
    } else {
      now.className = "alt-now";
      now.textContent = last ? `Last episode ${AltView.clock(last.t0)}–${AltView.clock(last.t1)} (${AltView.dur(last.dur)})` : "";
    }
    const host = $("alt-eps");
    host.innerHTML = "";
    if (eps.length) host.appendChild(AltView.episodeTable(eps.slice(-5).reverse()));
  }

  // every finished episode: ±30 s of every stream to recordings/clips/
  function clips() {
    for (const e of eps) {
      if (e.ongoing) continue;
      const key = `${sesId}:${Math.round(e.t0)}`;
      if (clipped.has(key)) continue;
      clipped.add(key); saveClipped();
      const name = "alt_" + new Date(e.t0 * 1000).toTimeString().slice(0, 8).replace(/:/g, "");
      fetch(`/api/sessions/${sesId}/clip`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ a: e.t0 - CLIP_PAD_S, b: e.t1 + CLIP_PAD_S, name,
          info: { kind: "alternans", t0: e.t0, t1: e.t1, n: e.n, shortMean: e.shortMean, longMean: e.longMean,
                  medDelta: e.medDelta, prematurity: e.prematurity, params: Alternans.paramsKey() } }) }).catch(() => {});
    }
  }

  // split average of the latest episode (its last 3 min), refreshed once a minute while it lasts
  async function split() {
    const e = eps[eps.length - 1];
    if (!e) { $("alt-split-wrap").hidden = true; return; }
    const key = `${sesId}:${Math.round(e.t0)}`, now = Date.now() / 1000;
    if (key === splitKey && (!e.ongoing || now - lastSplit < SPLIT_EVERY_S)) return;
    splitKey = key; lastSplit = now;
    const b = e.t1, a = Math.max(e.t0, b - SPLIT_SPAN_S);
    const ecg = await Alternans.fetchEcg(sesId, a, b);
    const sa = Alternans.splitAverage(ecg, [e]);
    $("alt-split-wrap").hidden = false;
    $("alt-split-sub").textContent = `Episode ${AltView.clock(e.t0)}–${e.ongoing ? "now" : AltView.clock(e.t1)}, ` +
      `beats of ${AltView.clock(a)}–${AltView.clock(b)}` + (e.ongoing ? " · updated every minute" : "");
    if (plot) { plot.destroy(); plot = null; }
    plot = AltView.splitChart($("alt-split"), sa);
    $("alt-metrics").innerHTML = sa ? AltView.metricsTable(sa) : "not enough clean beats yet";
  }

  async function mark(clip) {
    if (!sesId) { $("alt-mark-msg").textContent = "not recording"; return; }
    const note = $("alt-note").value.trim(), t = Date.now() / 1000;
    if (!clip && !note) { $("alt-mark-msg").textContent = "write a note first"; return; }
    try {
      const r = await fetch(`/api/sessions/${sesId}/events`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t, kind: clip ? "mark" : "note", note, clip: clip ? [MARK_PAD_S, MARK_PAD_S] : null }) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      $("alt-note").value = "";
      $("alt-mark-msg").textContent = `${clip ? "marked" : "note saved"} at ${AltView.clock(t)}` + (clip ? ` · clip ±${MARK_PAD_S} s in a minute` : "");
    } catch (e) {
      $("alt-mark-msg").textContent = "could not save: " + e;
    }
  }

  $("alt-mark-btn").addEventListener("click", () => mark(true));
  $("alt-note-btn").addEventListener("click", () => mark(false));
  $("alt-note").addEventListener("keydown", (e) => { if (e.key === "Enter") mark(false); });
  addEventListener("resize", () => { if (plot) plot.setSize({ width: $("alt-split").clientWidth, height: 240 }); });
  window.AltLive = { inEpisode, result: () => res };
  setTimeout(poll, 3000);
  setInterval(poll, POLL_S * 1000);
})();
