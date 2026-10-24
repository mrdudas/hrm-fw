/* Runs NonLin.analyze off the main thread (it takes 0.1-1 s): post
 * { id, rr, maxN }, get back { id, res }. */
importScripts("/static/nonlin.js");
onmessage = (e) => {
  const { id, rr, maxN } = e.data;
  let res = null;
  try { res = NonLin.analyze(rr, 12345, maxN); } catch (err) { res = null; }
  postMessage({ id, res });
};
