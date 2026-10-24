// W0-S01 Pyodide-Z3 module worker on the instrument origin (ARCHITECTURE.md section 6.2).
// It wraps fetch before Pyodide loads, so every engine fetch records whether its response came
// from the verified engine cache (the cache adds x-ss-sha256) or from the network or HTTP cache.

const ENGINES = new URL('./engines/', import.meta.url);
const PYODIDE = new URL('pyodide/314.0.7/', ENGINES).href;
const WHEEL = new URL('z3/5.3.1.0/z3_solver-5.3.1.0-py3-none-pyemscripten_2026_0_wasm32.whl', ENGINES).href;

const fetchLog = [];
const realFetch = self.fetch.bind(self);
self.fetch = async (input, init) => {
  const res = await realFetch(input, init);
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  fetchLog.push({
    path: new URL(url, self.location.href).pathname,
    status: res.status,
    from: res.headers.get('x-ss-sha256') ? 'engine-cache' : 'not-engine-cache',
  });
  return res;
};

// The roadmap starter, as RUN-z3-starter-pyodide ran it, plus a witness check: the model is
// checked against the property, never matched by value (spine section 9.1, INS-z3).
const STARTER = `
import json
from z3 import *
a, b, amount = Ints('a b amount')
s = Solver()
s.set('rlimit', RLIMIT)
s.add(a >= 0, b >= 0, amount > 0)
s.add(a - amount < 0)
r1 = s.check()
m = s.model() if r1 == sat else None
prop = And(a >= 0, b >= 0, amount > 0, a - amount < 0)
witness_ok = m is not None and is_true(m.eval(prop, model_completion=True))
s.add(amount <= a)
r2 = s.check()
json.dumps({'version': get_version_string(), 'first': str(r1), 'model': str(m), 'second': str(r2),
            'witness_ok': witness_ok, 'line': f'{get_version_string()} {r1} {m} {r2}'})
`;

let py = null;
let readyMs = null;

async function load() {
  const t0 = performance.now();
  const { loadPyodide } = await import(PYODIDE + 'pyodide.mjs');
  py = await loadPyodide({ indexURL: PYODIDE });
  await py.loadPackage(WHEEL);
  readyMs = Math.round(performance.now() - t0);
}

async function probe() {
  return {
    origin: self.origin,
    localStorage: typeof self.localStorage,
    idbDatabases: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).map((d) => d.name) : 'unsupported',
    cacheNames: await caches.keys(),
  };
}

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.t === 'probe') { self.postMessage(await probe()); return; }
  if (m.t !== 'run') return;
  try {
    const cold = !py;
    if (cold) await load();
    const t1 = performance.now();
    const ns = py.globals.get('dict')();
    ns.set('RLIMIT', Number(m.rlimit) || 5000000);
    const out = JSON.parse(py.runPython(STARTER, { globals: ns }));
    ns.destroy();
    self.postMessage({
      verdict: [out.first, out.second],
      witness: out.model,
      witnessOk: out.witness_ok,
      line: out.line,
      stats: { cold, readyMs: cold ? readyMs : 0, runMs: Math.round(performance.now() - t1) },
      fetchLog: fetchLog.splice(0),
    });
  } catch (err) {
    self.postMessage({ error: 'engine-crashed', detail: String((err && err.stack) || err).slice(0, 800), fetchLog: fetchLog.splice(0) });
  }
};
