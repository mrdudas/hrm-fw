/* Beat-timing analysis off the main thread (dtw.js; ~1-5 s for 10 min).
 *   { id, segs, o } -> { id, res } | { id, error }
 * o as for BeatDTW.analyse / kernelAnalyse, plus o.method ("kernel" | "ref");
 * the RR cleaning (HRV.clean) is applied here. The result is slimmed to what
 * the page draws (no filtered segments, no per-cycle K0 alignment). */
importScripts("/static/hrv.js", "/static/dtw.js");

onmessage = (e) => {
  const { id, segs, o } = e.data;
  try {
    const clean = (rr, gap) => HRV.clean(rr, Uint8Array.from(gap)).bad;
    const res = o.method === "kernel" ? BeatDTW.kernelAnalyse(segs, { ...o, clean }) : BeatDTW.analyse(segs, { ...o, clean });
    if (res && res.cycles) {
      delete res.segs;
      for (const c of res.cycles) { delete c.seg; delete c.g; }
    }
    postMessage({ id, res });
  } catch (err) {
    postMessage({ id, error: String((err && err.stack) || err) });
  }
};
