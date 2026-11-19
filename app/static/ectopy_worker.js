/* Runs Ectopy.analyze off the page's thread: {ecg, acc} in, the result out (progress on the way). */
importScripts("/static/ectopy.js");
self.onmessage = (ev) => {
  try {
    const r = Ectopy.analyze(ev.data.ecg, ev.data.acc, (f, what) => self.postMessage({ progress: f, what }));
    self.postMessage({ result: r });
  } catch (e) {
    self.postMessage({ error: String(e && e.stack || e) });
  }
};
