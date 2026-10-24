// W0-S02 solver cases, as Python source that leaves a JSON string in `out`. RLIMIT, TIMEOUT_MS come from the
// caller. A separate module so the same text runs in the worker and in the Node check of the container run.
// Spike code, not product code.

export const PY = {
  // The roadmap starter, as RUN-z3-starter-pyodide ran it, with a witness check: the model is checked
  // against the property and never matched by value (spine section 9.1, INS-z3).
  starter: `
import json, time
from z3 import *
a, b, amount = Ints('a b amount')
s = Solver()
s.set('rlimit', RLIMIT)
s.add(a >= 0, b >= 0, amount > 0)
s.add(a - amount < 0)
t = time.perf_counter(); r1 = s.check(); d1 = time.perf_counter() - t
m = s.model() if r1 == sat else None
prop = And(a >= 0, b >= 0, amount > 0, a - amount < 0)
witness_ok = m is not None and is_true(m.eval(prop, model_completion=True))
s.add(amount <= a)
t = time.perf_counter(); r2 = s.check(); d2 = time.perf_counter() - t
out = json.dumps({'version': get_version_string(), 'first': str(r1), 'second': str(r2), 'witness_ok': witness_ok,
                  'line': f'{get_version_string()} {r1} {m} {r2}', 'solve_ms': [round(d1 * 1000, 2), round(d2 * 1000, 2)]})
`,
  // rlimit timing, nonlinear integer arithmetic: the query of RUN-z3-budget-pyodide (cubes: no search ends it).
  'rlimit-nia': `
import json, time, z3
x, y, z = z3.Ints('x y z')
s = z3.Solver(); s.set('rlimit', RLIMIT)
s.add(x > 2, y > 2, z > 2, x * x * x + y * y * y == z * z * z)
t = time.perf_counter(); r = s.check(); d = time.perf_counter() - t
out = json.dumps({'verdict': str(r), 'reason': s.reason_unknown() if r == z3.unknown else '', 'solve_ms': round(d * 1000, 2)})
`,
  // rlimit timing, bit-vectors: factoring a 62-bit semiprime by bit-blasting a 64-bit multiplier.
  'rlimit-bv': `
import json, time, z3
x, y = z3.BitVecs('x y', 64)
s = z3.Solver(); s.set('rlimit', RLIMIT)
s.add(z3.UGT(x, 1), z3.UGT(y, 1), z3.ULE(x, 0xFFFFFFFF), z3.ULE(y, 0xFFFFFFFF), x * y == 4611685975477714963)
t = time.perf_counter(); r = s.check(); d = time.perf_counter() - t
out = json.dumps({'verdict': str(r), 'reason': s.reason_unknown() if r == z3.unknown else '', 'solve_ms': round(d * 1000, 2)})
`,
  // The timeout case of RUN-z3-budget-pyodide: under Node it never returned. The host's watchdog is the stop.
  timeout: `
import json, time, z3
x, y, z = z3.Ints('x y z')
s = z3.Solver(); s.set('timeout', TIMEOUT_MS)
s.add(x > 2, y > 2, z > 2, x * x * x + y * y * y == z * z * z)
t = time.perf_counter(); r = s.check(); d = time.perf_counter() - t
out = json.dumps({'verdict': str(r), 'reason': s.reason_unknown() if r == z3.unknown else '', 'solve_ms': round(d * 1000, 2)})
`,
  // The unknown case of RUN-z3-unknown-pow.
  unknown: `
import json, time, z3
x, y = z3.Ints('x y')
s = z3.Solver(); s.set('rlimit', RLIMIT); s.add(x ** y == 8, y > 1)
t = time.perf_counter(); r = s.check(); d = time.perf_counter() - t
out = json.dumps({'verdict': str(r), 'reason': s.reason_unknown() if r == z3.unknown else '', 'solve_ms': round(d * 1000, 3)})
`,
  // The recipient wrap of RUN-z3-bv64-pyodide: a witness is checked against the property, never matched by value.
  'bv64-wrap': `
import json, time, z3
B, M = z3.BitVecs('B M', 64)
s = z3.Solver(); s.set('rlimit', RLIMIT)
prop = z3.And(B >= 0, M > 0, B + M < 0)
s.add(prop)
t = time.perf_counter(); r = s.check(); d = time.perf_counter() - t
ok = False
if r == z3.sat:
    ok = z3.is_true(s.model().eval(prop, model_completion=True))
out = json.dumps({'verdict': str(r), 'witness_ok': ok, 'solve_ms': round(d * 1000, 3)})
`,
  // Fixedpoint with stratified negation, the case of RUN-z3-fixedpoint.
  fixedpoint: `
import json, time, z3
t = time.perf_counter()
fp = z3.Fixedpoint(); fp.set(engine='datalog')
U = z3.BitVecSort(8)
member = z3.Function('member', U, U, z3.BoolSort()); shared = z3.Function('shared', U, U, z3.BoolSort())
revoked = z3.Function('revoked', U, U, z3.BoolSort()); canread = z3.Function('canread', U, U, z3.BoolSort())
for f in (member, shared, revoked, canread): fp.register_relation(f)
u, d = z3.BitVecs('u d', 8); fp.declare_var(u, d)
fp.rule(canread(u, d), [member(u, d)])
fp.rule(canread(u, d), [shared(u, d), z3.Not(revoked(u, d))])
fp.fact(member(z3.BitVecVal(1, 8), z3.BitVecVal(3, 8))); fp.fact(shared(z3.BitVecVal(1, 8), z3.BitVecVal(4, 8))); fp.fact(revoked(z3.BitVecVal(1, 8), z3.BitVecVal(4, 8)))
q13 = str(fp.query(canread(z3.BitVecVal(1, 8), z3.BitVecVal(3, 8))))
q14 = str(fp.query(canread(z3.BitVecVal(1, 8), z3.BitVecVal(4, 8))))
out = json.dumps({'canread_1_3': q13, 'canread_1_4': q14, 'solve_ms': round((time.perf_counter() - t) * 1000, 2)})
`,
};
