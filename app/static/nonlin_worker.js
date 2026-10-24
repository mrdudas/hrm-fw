/* Heavy analyses off the main thread (0.1 s .. tens of seconds).
 *   { id, rr, maxN }                       -> { id, res }  Lyapunov panel (nonlin.js)
 *   { id, kind: "chaos", rr }              -> { id, res }  noise titration + entropy plane (chaos.js)
 *   { id, kind: "rollChaos", t, rrc, bad, gap, o } -> { id, res, part, frac } ... { id, res } */
importScripts("/static/nonlin.js", "/static/chaos.js");
onmessage = (e) => {
  const m = e.data;
  let res = null;
  try {
    if (m.kind === "chaos") res = Chaos.analyze(Array.from(m.rr));
    else if (m.kind === "rollChaos")
      res = Chaos.rolling(m.t, m.rrc, m.bad, m.gap, m.o, (part, frac) => postMessage({ id: m.id, res: part, part: true, frac }));
    else res = NonLin.analyze(m.rr, 12345, m.maxN);
  } catch (err) { res = null; }
  postMessage({ id: m.id, res });
};
