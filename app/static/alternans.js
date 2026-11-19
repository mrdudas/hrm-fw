/* RR alternans / bigeminy episodes, split P-wave averaging.
 *
 * One module for every place that needs it: the live dashboard, the review page,
 * the daily view and the episode report all call the same functions on the same
 * input -- the session's beats as the server reconstructs them from rr_<session>.csv
 * (the live page reads the session being recorded the same way), so a stretch
 * gives the same result live and later from the file.
 *
 * Detector: a window of `win` consecutive normal beats (no lost beat, no PVC, RR in
 * range) qualifies when the sign of dRR alternates in >= altFrac of the consecutive
 * pairs and the median |dRR| >= minDelta ms; a beat qualifies when the window ending
 * at it does. Hysteresis: an episode starts after `startRun` qualifying beats in a row
 * (dated back to the first beat of the first of those windows) and ends after `endRun`
 * beats in a row that do not qualify (at once at a lost beat or a PVC);
 * it covers the beats up to the end of the last qualifying window. On top of the
 * alternation, the window must be regular: the SD of every other RR (the short ones,
 * and the long ones) at most `regular` x the median |dRR| -- an irregular rhythm
 * (atrial fibrillation, noise) alternates in sign by chance in 2 of 3 pairs, and
 * often 8 of 10; true alternation repeats two steady intervals (0 switches this off).
 * An "episode" whose short + long interval is under `split` x the median R-R of the
 * minute before it is one beat counted twice (a T wave or noise taken for an R):
 * it is rejected (res.rejected), not counted as alternans. In an episode a
 * beat ending an RR shorter than the mean of its neighbours is ALT-SHORT, else ALT-LONG.
 *
 * Prematurity in an episode is measured against the median of its LONG intervals
 * (the overall local median is pulled down by the alternation itself).
 *
 * Split average: the ECG's own R peaks (BeatDTW.detect) inside the episodes; beats
 * ending a short R-R (A) and a long one (B) are averaged apart, R-aligned, and the
 * two P waves compared (QRST.analyze for PR, P onset, P amplitude and duration, QRS).
 *
 * Plain script: window.Alternans in the browser (needs dtw.js and qrst.js loaded
 * first for the split average), module.exports in node.
 */
(function (root) {
  "use strict";

  const PARAMS = { win: 12, altFrac: 0.8, minDelta: 80, startRun: 12, endRun: 8, regular: 0.5, split: 1.35, rrMin: 300, rrMax: 2000, version: 1 };
  // results cached per recording carry this key; a change of the parameters invalidates them
  const paramsKey = (p = PARAMS) => `v${p.version}-w${p.win}-a${p.altFrac}-d${p.minDelta}-s${p.startRun}-e${p.endRun}-g${p.regular}-x${p.split}-r${p.rrMin}-${p.rrMax}`;
  const NORMAL = 0, SHORT = 1, LONG = 2;
  const SUMMARY_FMT = 2;               // layout of the cached per-recording summary
  const CLASS = ["N", "ALT-SHORT", "ALT-LONG"];

  function median(a) {
    const b = Array.from(a).filter((v) => v === v).sort((x, y) => x - y), m = b.length >> 1;
    return b.length ? (b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2) : NaN;
  }
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
  function lowerBound(a, x) {
    let lo = 0, hi = a.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; }
    return lo;
  }

  /* Beats the strap called PVC (wide QRS): not "normal-QRS" beats. The strap reports
   * a premature beat one beat late, when the pause after it is known, so the PVC is
   * the beat about pause_ms before the report. ecto rows: [t, type, coupling_ms, pause_ms]. */
  function pvcMask(beats, ecto) {
    const t = beats.t, m = new Uint8Array(t.length);
    for (const e of ecto || []) {
      if (e[1] !== "PVC") continue;
      const want = e[0] - (e[3] || 0) / 1000;
      let k = lowerBound(t, want - 0.6), best = -1, bd = 0.6;
      for (; k < t.length && t[k] <= want + 0.6; k++) { const d = Math.abs(t[k] - want); if (d < bd) { bd = d; best = k; } }
      if (best >= 0) m[best] = 1;
    }
    return m;
  }

  /* beats: {t (unix s), rr (ms), gap (beats lost before this one)}; ecto: strap events.
   * Returns {key, label (Int8Array: 0 normal, 1 ALT-SHORT, 2 ALT-LONG), ep (Int32Array: episode
   * index or -1), episodes: [...], stats: {count, dur, monitored, pct, short, long}}. */
  function detect(beats, ecto, p = PARAMS) {
    const t = beats.t, rr = beats.rr, gap = beats.gap || [], n = t.length;
    const pvc = pvcMask(beats, ecto);
    const ok = new Uint8Array(n);
    for (let i = 0; i < n; i++) ok[i] = rr[i] >= p.rrMin && rr[i] <= p.rrMax && !pvc[i] && !(i > 0 && pvc[i - 1]) ? 1 : 0;
    const d = new Float64Array(n).fill(NaN);                       // dRR ending at beat i
    for (let i = 1; i < n; i++) if (ok[i] && ok[i - 1] && !gap[i]) d[i] = rr[i] - rr[i - 1];
    const W = p.win, q = new Uint8Array(n), ad = [];
    for (let i = W - 1; i < n; i++) {
      let fine = true, alt = 0, pairs = 0;
      ad.length = 0;
      for (let j = i - W + 2; j <= i; j++) {
        if (d[j] !== d[j]) { fine = false; break; }
        ad.push(Math.abs(d[j]));
        if (j > i - W + 2) { pairs++; if (d[j] * d[j - 1] < 0) alt++; }
      }
      if (!fine || alt < p.altFrac * pairs) continue;
      const md = median(ad);
      if (md < p.minDelta) continue;
      if (p.regular > 0) {
        const sd = (par) => { const v = []; for (let j = i - W + 1 + par; j <= i; j += 2) v.push(rr[j]);
          const m = mean(v); return Math.sqrt(mean(v.map((x) => (x - m) ** 2))); };
        if (Math.max(sd(0), sd(1)) > p.regular * md) continue;
      }
      q[i] = 1;
    }
    const label = new Int8Array(n), ep = new Int32Array(n).fill(-1), episodes = [], rejected = [];
    const close = (i0, i1, ongoing) => {
      const k = episodes.length, sh = [], lo = [], dd = [], lab = [];
      for (let i = i0; i <= i1; i++) {
        const a = i > i0 ? rr[i - 1] : rr[i + 1], b = i < i1 ? rr[i + 1] : rr[i - 1];
        lab.push(rr[i] < (a + b) / 2 ? SHORT : LONG);
        (lab[lab.length - 1] === SHORT ? sh : lo).push(rr[i]);
        if (i > i0 && d[i] === d[i]) dd.push(Math.abs(d[i]));
      }
      const refLong = median(lo), t0 = t[i0] - rr[i0] / 1000, t1 = t[i1];
      // the minute before: one beat split in two adds up to about one normal R-R
      // (or the minute after it, or the whole recording)
      const near = [], far = [];
      for (let i = i0 - 1; i >= 0 && t[i] >= t0 - 60; i--) if (ok[i] && ep[i] < 0) near.push(rr[i]);
      if (near.length < 20) for (let i = i1 + 1; i < n && t[i] <= t1 + 60; i++) if (ok[i]) near.push(rr[i]);
      if (near.length < 20) for (let i = 0; i < n; i++) if (ok[i] && (i < i0 || i > i1)) far.push(rr[i]);
      const ref = near.length >= 20 ? median(near) : far.length >= 20 ? median(far) : NaN;
      if (p.split > 0 && ref === ref && mean(sh) + mean(lo) < p.split * ref) {
        rejected.push({ t0, t1, n: i1 - i0 + 1, shortMean: mean(sh), longMean: mean(lo), rrBefore: ref, why: "short + long ≈ one normal R-R: a beat counted twice" });
        return;
      }
      for (let i = i0; i <= i1; i++) { label[i] = lab[i - i0]; ep[i] = k; }
      episodes.push({ i0, i1, t0, t1, dur: t1 - t0, n: i1 - i0 + 1, ongoing: !!ongoing,
                      shortMean: mean(sh), longMean: mean(lo), medDelta: median(dd), refLong,
                      prematurity: mean(sh.map((v) => v / refLong)),        // short RR / median long RR
                      hrMin: 60000 / Math.max(...lo), hrMax: 60000 / Math.min(...sh) });
    };
    let start = -1, lastQ = -1, fails = 0, run = 0;
    for (let i = 0; i < n; i++) {
      run = q[i] ? run + 1 : 0;
      if (q[i]) {
        if (start < 0 && run >= p.startRun) start = i - run + 1 - W + 1;
        if (start >= 0) { lastQ = i; fails = 0; }
      } else if (start >= 0) {
        fails++;
        if (fails >= p.endRun || d[i] !== d[i]) { close(start, lastQ); start = -1; }
      }
    }
    if (start >= 0) close(start, lastQ, true);
    // time the strap watched the heart: the beats' R-R sum, lost beats left out
    let monitored = 0;
    for (let i = 0; i < n; i++) if (!gap[i] && rr[i] >= p.rrMin && rr[i] <= p.rrMax) monitored += rr[i] / 1000;
    return { key: paramsKey(p), params: p, label, ep, episodes, rejected, stats: stats(episodes, monitored, label) };
  }

  function stats(episodes, monitored, label) {
    const dur = episodes.reduce((s, e) => s + e.dur, 0);
    let short = 0, long = 0;
    if (label) for (const l of label) { if (l === SHORT) short++; else if (l === LONG) long++; }
    return { count: episodes.length, dur, monitored, pct: monitored ? 100 * dur / monitored : 0, short, long };
  }

  /* Episodes overlapping [a, b], clipped to it, with their stats (for a selected range). */
  function inRange(res, a, b) {
    return res.episodes.filter((e) => e.t1 > a && e.t0 < b);
  }

  /* Beats to leave out of RMSSD / pNN50 / SDNN: every beat of an episode (and the
   * one after it, whose RR difference still spans the last alternation). */
  function hrvMask(res) {
    const m = new Uint8Array(res.label.length);
    for (const e of res.episodes) for (let i = e.i0; i <= Math.min(m.length - 1, e.i1 + 1); i++) m[i] = 1;
    return m;
  }

  /* RMSSD, SDNN, pNN50 of beats [i0, i1) with `skip` beats left out (and lost beats breaking the chain). */
  function hrv(beats, i0, i1, skip) {
    const rr = beats.rr, gap = beats.gap || [], use = [];
    let ss = 0, nd = 0, n50 = 0;
    for (let i = i0; i < i1; i++) {
      if (skip && skip[i]) continue;
      if (!(rr[i] >= PARAMS.rrMin && rr[i] <= PARAMS.rrMax)) continue;
      use.push(rr[i]);
      if (i > i0 && !gap[i] && !(skip && skip[i - 1]) && rr[i - 1] >= PARAMS.rrMin && rr[i - 1] <= PARAMS.rrMax) {
        const dd = rr[i] - rr[i - 1];
        ss += dd * dd; nd++; if (Math.abs(dd) > 50) n50++;
      }
    }
    const m = mean(use);
    return { n: use.length, rmssd: nd ? Math.sqrt(ss / nd) : NaN, pnn50: nd ? 100 * n50 / nd : NaN,
             sdnn: use.length > 1 ? Math.sqrt(use.reduce((s, v) => s + (v - m) ** 2, 0) / (use.length - 1)) : NaN };
  }

  /* A stretch of `len` s without alternation near an episode (for a reference strip):
   * the closest one before it, else after it, inside the recording and without lost beats. */
  function referenceWindow(beats, res, ep, len = 10) {
    const t = beats.t, gap = beats.gap || [];
    const free = (a) => {
      if (a < t[0] || a + len > t[t.length - 1]) return false;
      if (res.episodes.some((e) => e.t1 > a - 2 && e.t0 < a + len + 2)) return false;
      for (let i = lowerBound(t, a); i < t.length && t[i] <= a + len; i++) if (gap[i]) return false;
      return true;
    };
    for (let s = 5; s < 3600; s += 5) {
      if (free(ep.t0 - s - len)) return ep.t0 - s - len;
      if (free(ep.t1 + s)) return ep.t1 + s;
    }
    return null;
  }

  // ---------------- split averaged beat ----------------
  const PRE_MS = 350, POST_MS = 600;

  function pearson(a, b, i0, i1) {
    let sa = 0, sb = 0, n = 0;
    for (let i = i0; i < i1; i++) { sa += a[i]; sb += b[i]; n++; }
    const ma = sa / n, mb = sb / n;
    let c = 0, va = 0, vb = 0;
    for (let i = i0; i < i1; i++) { c += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
    return va > 0 && vb > 0 ? c / Math.sqrt(va * vb) : NaN;
  }

  /* ecg: {fs, segs: [{t, v}], notched}; episodes: [{t0, t1}]. Returns null without beats, else
   * {tms, A: {y, n, rr, q, m}, B: {...}, pCorr, hint, verdict}. A = beats ending a SHORT R-R, B = a LONG one. */
  function splitAverage(ecg, episodes, o = {}) {
    const D = root.BeatDTW || (typeof require !== "undefined" ? require("./dtw.js") : null);
    const Q = root.QRST || (typeof require !== "undefined" ? require("./qrst.js") : null);
    const fs = ecg.fs, notch = ecg.notched ? 0 : (o.notch ?? 50);
    const f = ecg.segs.filter((s) => s.v.length > 3 * fs).map((s) => ({ t: s.t, v: s.v, x: D.prep(s.v, fs, { notch, hp: 0.5, lp: 40 }) }));
    if (!f.length) return null;
    const det = D.detect(f, fs), B = det.beats;
    const pre = Math.round(PRE_MS * fs / 1000), post = Math.round(POST_MS * fs / 1000), n = pre + post + 1;
    const inEp = (r) => episodes.some((e) => r >= e.t0 - 0.2 && r <= e.t1 + 0.2);
    const groups = { A: [], B: [] };
    for (let k = 2; k + 1 < B.length; k++) {
      const b = B[k], a = B[k - 1], c = B[k + 1];
      if (a.seg !== b.seg || c.seg !== b.seg || B[k - 2].seg !== b.seg || !inEp(b.r)) continue;
      const rp = b.rr, rq = a.rr, rn = c.rr;                       // R-R ending here, before it, after it
      const g = rp < rq && rp < rn ? "A" : rp > rq && rp > rn ? "B" : null;
      if (!g) continue;
      const p0 = Math.round(b.p) - pre;
      if (p0 < 0 || p0 + n > b.seg.x.length) continue;
      const y = new Float64Array(n);
      for (let i = 0; i < n; i++) y[i] = b.seg.x[p0 + i] * det.pol;
      groups[g].push({ y, rr: rp });
    }
    const tms = Array.from({ length: n }, (_, i) => (i - pre) * 1000 / fs);
    const avg = (list) => {
      if (list.length < 3) return null;
      const med = new Float64Array(n);
      for (let i = 0; i < n; i++) med[i] = median(list.map((b) => b.y[i]));
      const keep = list.filter((b) => pearson(b.y, med, 0, n) >= 0.7);     // motion, a stray beat
      if (keep.length < 3) return null;
      const y = new Float64Array(n);
      for (const b of keep) for (let i = 0; i < n; i++) y[i] += b.y[i] / keep.length;
      const rr = mean(keep.map((b) => b.rr));
      const q = Q ? Q.analyze(tms, y, fs, rr, { hpHz: 0 }) : null;
      return { y, n: keep.length, dropped: list.length - keep.length, rr, q, m: metrics(q) };
    };
    const A = avg(groups.A), Bv = avg(groups.B);
    if (!A && !Bv) return null;
    const i0 = Math.round((PRE_MS - 250) * fs / 1000), i1 = Math.round((PRE_MS - 40) * fs / 1000);
    const pCorr = A && Bv ? pearson(A.y, Bv.y, i0, i1) : NaN;
    return { tms, fs, A, B: Bv, pCorr, ...interpret(A, Bv, pCorr) };
  }

  function metrics(q) {
    if (!q) return {};
    const f = q.fid, m = { qrs: q.m.qrs };
    if (q.m.pr != null) m.pr = q.m.pr;
    if (f.pOn != null) m.pOn = f.pOn - f.R;                  // ms, negative: before R
    if (f.pOn != null && f.pOff != null) m.pDur = f.pOff - f.pOn;
    if (q.amp.P != null) m.pAmp = q.amp.P;
    return m;
  }

  // a hint, not a diagnosis
  function interpret(A, B, r) {
    if (!A || !B) return { verdict: "n/a", hint: "Not enough clean beats in one of the groups to compare." };
    const a = A.m, b = B.m, why = [];
    if (r === r && r < 0.9) why.push(`P-wave correlation ${r.toFixed(2)}`);
    if (a.pr != null && b.pr != null && Math.abs(a.pr - b.pr) >= 20) why.push(`PR ${Math.round(a.pr)} vs ${Math.round(b.pr)} ms`);
    if (a.pOn != null && b.pOn != null && Math.abs(a.pOn - b.pOn) >= 20) why.push(`P onset ${Math.round(a.pOn)} vs ${Math.round(b.pOn)} ms`);
    if (a.pAmp != null && b.pAmp != null && Math.max(Math.abs(a.pAmp), Math.abs(b.pAmp)) > 0 &&
        Math.abs(a.pAmp - b.pAmp) > 0.4 * Math.max(Math.abs(a.pAmp), Math.abs(b.pAmp))) why.push("P amplitude differs > 40 %");
    if (a.pOn == null || b.pOn == null) why.push("no P wave found in " + (a.pOn == null ? "A" : "B"));
    if (why.length) return { verdict: "different", hint: `Different P wave or PR in the short-cycle beats (${why.join(", ")}): suggests atrial premature beats (atrial bigeminy).` };
    return { verdict: "same", hint: "The P waves of the short- and long-cycle beats overlap (same shape and PR): suggests sinus-origin alternation rather than premature atrial beats." };
  }

  // ---------------- data (browser) ----------------
  /* Raw ECG of [a, b] of a session in <= 200-s requests, joined: {fs, segs, notched, acc}. */
  async function fetchEcg(id, a, b, onProgress) {
    const CHUNK = 196, OVER = 2, segs = [], acc = { t: [], x: [], y: [], z: [] };
    let fs = null, notched = 0;
    for (let x = a - OVER; x < b + OVER; x += CHUNK) {
      if (onProgress) onProgress((x - a + OVER) / (b - a + 2 * OVER));
      const y = Math.min(x + CHUNK + 2 * OVER, b + OVER);
      const r = await fetch(`/api/sessions/${id}/ecg?a=${x.toFixed(3)}&b=${y.toFixed(3)}`);
      if (!r.ok) throw new Error(r.status === 404 ? "no raw ECG in this session" : "HTTP " + r.status);
      const d = await r.json();
      fs = d.fs; notched = d.notched_hz || 0;
      if (d.acc && d.acc.t) for (let i = 0; i < d.acc.t.length; i++) {
        if (acc.t.length && d.acc.t[i] <= acc.t[acc.t.length - 1]) continue;
        acc.t.push(d.acc.t[i]); acc.x.push(d.acc.x[i]); acc.y.push(d.acc.y[i]); acc.z.push(d.acc.z[i]);
      }
      for (const g of d.ecg) {
        const p = segs[segs.length - 1], pEnd = p ? p.t + (p.v.length - 1) / fs : -Infinity;
        if (p && g.t <= pEnd + 1.5 / fs && g.t + (g.v.length - 1) / fs > pEnd) {
          const from = Math.round((pEnd - g.t) * fs) + 1;
          p.v = p.v.concat(g.v.slice(Math.max(0, from)));
        } else if (!p || g.t > pEnd) segs.push({ t: g.t, v: g.v });
      }
    }
    return { fs, segs, notched, acc, a, b };
  }

  /* The session's result: from the server's cache when it was made from the same rr file
   * with the same parameters, else computed here and stored. */
  async function forSession(id, ses, force) {
    try {
      const c = await (await fetch(`/api/sessions/${id}/alternans`)).json();
      if (!ses && !force && valid(c)) return { summary: c.cached, cached: true };
      if (!ses) ses = await (await fetch(`/api/sessions/${id}`)).json();
      const res = detect(ses.beats, ses.ectopy);
      const summary = summarize(id, ses, res, c.rr);
      fetch(`/api/sessions/${id}/alternans`, { method: "PUT", headers: { "Content-Type": "application/json" },
                                                body: JSON.stringify(summary) }).catch(() => {});
      return { summary, res, ses, cached: false };
    } catch (e) {
      return { error: String(e) };
    }
  }

  // a cached summary still holds: same detector, same layout, made from the rr file as it is now
  function valid(c) {
    return !!(c && c.cached && c.cached.key === paramsKey() && c.cached.fmt === SUMMARY_FMT && c.rr && c.cached.rr &&
              c.cached.rr.size === c.rr.size && c.cached.rr.mtime === c.rr.mtime);
  }

  // what is kept per recording (daily view, episode lists)
  function summarize(id, ses, res, rrStat) {
    // seconds the strap actually watched the heart, per clock hour: [[hour start (unix s), s], ...]
    const mon = new Map(), b = ses.beats;
    for (let i = 0; i < b.t.length; i++) {
      if (b.gap && b.gap[i]) continue;
      if (!(b.rr[i] >= PARAMS.rrMin && b.rr[i] <= PARAMS.rrMax)) continue;
      const h = Math.floor(b.t[i] / 3600) * 3600;
      mon.set(h, (mon.get(h) || 0) + b.rr[i] / 1000);
    }
    const ecto = ses.ectopy || [];
    const artIn = ecto.filter((e) => e[1] === "ARTIFACT" && res.episodes.some((p) => e[0] >= p.t0 && e[0] <= p.t1 + 1)).length;
    return {
      id, key: res.key, fmt: SUMMARY_FMT, rr: rrStat || null, made: Date.now() / 1000,
      mon: [...mon].map(([h, s]) => [h, Math.round(s)]),
      start: ses.beats.t[0], end: ses.beats.t[ses.beats.t.length - 1], stats: res.stats,
      artifactsInEpisodes: artIn, rejected: (res.rejected || []).length,
      episodes: res.episodes.map((e) => ({ t0: e.t0, t1: e.t1, dur: e.dur, n: e.n, ongoing: e.ongoing,
        shortMean: e.shortMean, longMean: e.longMean, medDelta: e.medDelta, refLong: e.refLong, prematurity: e.prematurity })),
    };
  }

  const api = { PARAMS, paramsKey, CLASS, NORMAL, SHORT, LONG, detect, pvcMask, inRange, hrvMask, hrv, referenceWindow,
                splitAverage, metrics, interpret, fetchEcg, forSession, summarize, valid, stats, median };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Alternans = api;
})(typeof window !== "undefined" ? window : globalThis);
