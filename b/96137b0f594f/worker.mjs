// W0-S02 Pyodide-Z3 module worker on the instrument origin (ARCHITECTURE.md section 6.2).
// Adapted from scripts/spikes/W0-S01/site/instruments/b/BUILD/worker.mjs: the same engine layout and
// the same fetch wrapper, plus per-phase timings, the solver cases of the spine's W0-S02 row, a CPU
// yardstick that runs before the engine loads, and memory readings. Spike code, not product code.
//
// Messages in:  {t:'ping'} {t:'init'} {t:'cpu'} {t:'case', name, args} {t:'mem'}
// Messages out: {t:'ready', ...phases} | {t:'cpu', ...} | {t:'case', ...} | {t:'mem', ...} | {t:'error', ...}

import { PY } from './cases.mjs';

const ENGINES = new URL('./engines/', import.meta.url);
const PYODIDE = new URL('pyodide/314.0.7/', ENGINES).href;
const WHEEL = new URL('z3/5.3.1.0/z3_solver-5.3.1.0-py3-none-pyemscripten_2026_0_wasm32.whl', ENGINES).href;

const now = () => performance.now();
const startedAt = now(); // ms since this worker's time origin: spawn cost shows as the first message's delay

// Every engine fetch is logged with where its bytes came from: the verified engine cache adds x-ss-sha256.
const fetchLog = [];
const realFetch = self.fetch.bind(self);
self.fetch = async (input, init) => {
  const t = now();
  const res = await realFetch(input, init);
  const url = typeof input === 'string' ? input : (input && input.url) || String(input);
  fetchLog.push({
    path: new URL(url, self.location.href).pathname.split('/').slice(-1)[0],
    status: res.status,
    from: res.headers.get('x-ss-sha256') ? 'engine-cache' : 'not-engine-cache',
    headers_ms: Math.round(now() - t),
  });
  return res;
};

// ---- CPU yardstick ----------------------------------------------------------------------------
// A fixed integer workload in JavaScript and in WebAssembly, run before the engine loads, so that a
// run on a phone can be put next to a run on a throttled or unthrottled desktop. The wasm module is a
// hand-assembled loop (xorshift32 steps), called repeatedly so the engine's tier-up has happened by the
// timed calls. Same workload as the JS loop.
const WASM_LOOP = new Uint8Array([
  // assembled and checked by yardstick-wasm.mjs (node yardstick-wasm.mjs --check)
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f,
  0x03, 0x02, 0x01, 0x00, 0x07, 0x05, 0x01, 0x01, 0x66, 0x00, 0x00, 0x0a, 0x4e, 0x01, 0x4c, 0x01,
  0x03, 0x7f, 0x41, 0x95, 0x9a, 0xef, 0x3a, 0x21, 0x01, 0x02, 0x40, 0x03, 0x40, 0x20, 0x03, 0x20,
  0x00, 0x4f, 0x0d, 0x01, 0x20, 0x01, 0x20, 0x01, 0x41, 0x0d, 0x74, 0x73, 0x21, 0x01, 0x20, 0x01,
  0x20, 0x01, 0x41, 0x11, 0x76, 0x73, 0x21, 0x01, 0x20, 0x01, 0x20, 0x01, 0x41, 0x05, 0x74, 0x73,
  0x21, 0x01, 0x20, 0x02, 0x20, 0x01, 0x41, 0xff, 0x01, 0x71, 0x6a, 0x21, 0x02, 0x20, 0x03, 0x41,
  0x01, 0x6a, 0x21, 0x03, 0x0c, 0x00, 0x0b, 0x0b, 0x20, 0x02, 0x0b,
]);

function jsLoop(n) {
  let x = 123456789 | 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    s = (s + (x & 255)) | 0;
  }
  return s;
}
const median = (a) => { const b = [...a].sort((p, q) => p - q); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };

async function cpuYardstick(quick = false) {
  const out = { js_iterations: 100_000_000, wasm_iterations_per_call: 3_000_000, wasm_calls: 30, quick };
  jsLoop(1_000_000); // warm-up, so the loop is compiled before it is timed
  const js = [];
  for (let k = 0; k < 3; k++) { const t = now(); const sink = jsLoop(out.js_iterations); js.push(now() - t); out.js_sink = sink; }
  out.js_ms = js.map((v) => Math.round(v * 10) / 10);
  out.js_median_ms = Math.round(median(js) * 10) / 10;
  if (quick) return out; // the end-of-session check for thermal drift needs only the JavaScript loop
  try {
    // WebAssembly.instantiate(bytes) is tried first, guarded by a timer, and its outcome is recorded: in Playwright's
    // WebKit it did not settle in some runs once Pyodide had loaded in the same worker, so the timed loop below
    // uses the synchronous constructors, which cannot wait on that queue.
    const t0 = now();
    const guard = new Promise((r) => setTimeout(() => r('timeout'), 5000));
    const settled = await Promise.race([WebAssembly.instantiate(WASM_LOOP).then(() => 'settled', (e) => `rejected: ${e.name}`), guard]);
    out.wasm_async_instantiate = settled === 'timeout' ? { settled: false, waited_ms: 5000 } : { settled: settled === 'settled', ms: r1(now() - t0), outcome: settled };
    const f = new WebAssembly.Instance(new WebAssembly.Module(WASM_LOOP)).exports.f;
    const calls = [];
    for (let k = 0; k < out.wasm_calls; k++) { const t = now(); out.wasm_sink = f(out.wasm_iterations_per_call); calls.push(now() - t); }
    const tail = calls.slice(10); // after the first calls, which may run in the baseline tier
    out.wasm_first_call_ms = Math.round(calls[0] * 10) / 10;
    out.wasm_tail_median_ms = Math.round(median(tail) * 100) / 100;
    out.wasm_total_tail_ms = Math.round(tail.reduce((a, b) => a + b, 0) * 10) / 10;
  } catch (err) {
    out.wasm_error = `${err.name}: ${String(err.message).slice(0, 160)}`;
  }
  return out;
}

// ---- engine load, in phases ------------------------------------------------------------------
let py = null;
let phases = null;
const heap = () => (py && py._module && py._module.HEAPU8 ? py._module.HEAPU8.length : null);
const jsHeap = () => (typeof performance.memory === 'object' && performance.memory
  ? { used: performance.memory.usedJSHeapSize, total: performance.memory.totalJSHeapSize, limit: performance.memory.jsHeapSizeLimit } : null);
const r1 = (v) => Math.round(v * 10) / 10;

async function init() {
  if (py) return { already: true, phases };
  const p = { spawn_ms: r1(startedAt) };
  fetchLog.length = 0;
  const t0 = now();
  const { loadPyodide } = await import(PYODIDE + 'pyodide.mjs');
  const t1 = now();
  py = await loadPyodide({ indexURL: PYODIDE });
  const t2 = now();
  p.heap_after_pyodide = heap();
  await py.loadPackage(WHEEL);
  const t3 = now();
  p.heap_after_wheel = heap();
  py.runPython('import z3');
  const t4 = now();
  p.heap_after_import_z3 = heap();
  p.import_ms = r1(t1 - t0);
  p.load_pyodide_ms = r1(t2 - t1);
  p.load_wheel_ms = r1(t3 - t2);
  p.import_z3_ms = r1(t4 - t3);
  p.ready_ms = r1(t3 - t0); // W0-S01's definition: import, loadPyodide, loadPackage
  p.ready_with_z3_ms = r1(t4 - t0);
  p.z3_version = py.runPython('z3.get_version_string()');
  p.js_heap = jsHeap();
  p.fetches = fetchLog.splice(0);
  phases = p;
  return { already: false, phases: p };
}

// ---- the cases (cases.mjs) -----------------------------------------------------------------------

function runCase(name, args = {}) {
  const src = PY[name];
  if (!src) throw new Error(`unknown case ${name}`);
  const ns = py.globals.get('dict')();
  ns.set('RLIMIT', Number(args.rlimit) || 5000000);
  ns.set('TIMEOUT_MS', Number(args.timeoutMs) || 2000);
  const t = now();
  try {
    py.runPython(src, { globals: ns });
    const out = JSON.parse(ns.get('out'));
    return { name, args, call_ms: r1(now() - t), ...out, heap: heap() };
  } finally {
    ns.destroy();
  }
}

self.onmessage = async (e) => {
  const m = e.data || {};
  const reply = (r) => self.postMessage({ id: m.id, ...r });
  try {
    if (m.t === 'ping') { reply({ t: 'pong', worker_ms: r1(now()) }); return; }
    if (m.t === 'cpu') { reply({ t: 'cpu', ...(await cpuYardstick(m.quick === true)) }); return; }
    if (m.t === 'init') { reply({ t: 'ready', ...(await init()) }); return; }
    if (m.t === 'mem') { reply({ t: 'mem', heap: heap(), js_heap: jsHeap(), device_memory_gib: self.navigator ? self.navigator.deviceMemory ?? null : null }); return; }
    if (m.t === 'case') {
      if (!py) await init();
      reply({ t: 'case', ...runCase(m.name, m.args) });
      return;
    }
    reply({ t: 'error', code: 'bad-message', detail: `unknown t: ${m.t}` });
  } catch (err) {
    reply({ t: 'error', code: 'engine-crashed', detail: String((err && err.stack) || err).slice(0, 800), fetches: fetchLog.splice(0) });
  }
};
