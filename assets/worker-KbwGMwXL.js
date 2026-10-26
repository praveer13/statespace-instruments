const C="ss-engines-v1",q=self.fetch.bind(self),B=n=>[...new Uint8Array(n)].map(r=>r.toString(16).padStart(2,"0")).join(""),M={wasm:"application/wasm",mjs:"text/javascript",js:"text/javascript",json:"application/json",zip:"application/zip",whl:"application/zip"},F=n=>M[n.slice(n.lastIndexOf(".")+1)]??"application/octet-stream";function $(n,r,i){const d=new Map;for(const s of r.assets)d.set(new URL(s.path,n).href,s);const f=new Map,g=new Map;let h=Number.NEGATIVE_INFINITY;const o=(s=!1)=>{const t=performance.now();if(!s&&t-h<250)return;h=t;let e=0;for(const a of r.assets)e+=Math.round(Math.min(1,(g.get(a.path)??0)/a.bytes)*a.wire);i(e,r.firstLoadBytes)};async function l(s,t){let e=null;try{e=await caches.open(C);const c=await e.match(s);if(c!==void 0&&c.headers.get("x-ss-sha256")===t.sha256){const k=await c.arrayBuffer();return g.set(t.path,t.bytes),o(),k}}catch{e=null}const a=await q(s,{credentials:"omit"});if(!a.ok||a.body===null)throw new Error(`engine asset ${t.path}: HTTP ${a.status}`);const m=a.body.getReader(),j=[];let D=0;for(;;){const{done:c,value:k}=await m.read();if(c)break;j.push(k),D+=k.byteLength,g.set(t.path,D),o()}const w=new Uint8Array(D);let T=0;for(const c of j)w.set(c,T),T+=c.byteLength;const A=B(await crypto.subtle.digest("SHA-256",w));if(A!==t.sha256)throw new Error(`engine asset ${t.path}: SHA-256 ${A} does not match the manifest`);if(e!==null)try{await e.put(s,new Response(w,{headers:{"content-type":F(t.path),"x-ss-sha256":t.sha256}}))}catch{}return w.buffer}const p=(s,t)=>{let e=f.get(s);return e===void 0&&(e=l(s,t),f.set(s,e)),e};return{url:s=>new URL(s,n).href,async loadAll(){o(!0),await Promise.all([...d].map(([s,t])=>p(s,t))),o(!0)},installFetch(){const s=async t=>{const e=new URL(typeof t=="string"?t:t instanceof URL?t.href:t.url,self.location.href).href,a=d.get(e);if(a===void 0)throw new TypeError(`the instrument origin loads only manifest assets; refused ${e}`);const m=await p(e,a);return new Response(m.slice(0),{status:200,headers:{"content-type":F(a.path)}})};self.fetch=s}}}var O=`"""W0-S03 prototype of the INS-datalog adapter.

It reads the Souffle subset that Stage 7 uses, checks it the way Souffle does (declarations,
arity, types, grounding, stratification), and evaluates it two ways:

  * eval_fixedpoint: Z3's Fixedpoint engine (engine='datalog'), the candidate tab engine;
  * eval_reference:  a naive stratified evaluator, an independent second semantics.

derive() rebuilds a minimal-height derivation for every derived tuple from final relations, and
validate() checks each step of those derivations as an instance of a rule.

The same file runs natively and under Pyodide. Supported fragment (anything else raises
DatalogError with kind 'unsupported'):

    .decl name(col: symbol|number, ...)     .input name     .output name
    rules      head :- literal, literal, ... .        facts   name(constant, ...).
    literal    atom | !atom | term = term | term != term
    term       variable | _ | "string" | integer
    comments   // ... and /* ... */   (Souffle has no % comments)
"""

import hashlib
import json
import re
import time


class DatalogError(Exception):
    """kind: syntax | unsupported | undeclared | arity | type | ungrounded | not-stratified | facts | engine"""

    def __init__(self, kind, message):
        super().__init__(kind + ': ' + message)
        self.kind = kind
        self.message = message


# --------------------------------------------------------------------------- syntax

_TOKEN = re.compile(
    r'''
    (?P<skip>(?:\\s+|//[^\\n]*|/\\*.*?\\*/)+)
  | (?P<directive>\\.[A-Za-z_][A-Za-z_0-9]*)
  | (?P<string>"(?:[^"\\\\\\n]|\\\\.)*")
  | (?P<number>-?[0-9]+)
  | (?P<ident>[A-Za-z_?][A-Za-z_0-9?]*)
  | (?P<op>:-|!=|<=|>=|[(),.:=!<>;+\\-*/%{}\\[\\]|])
''',
    re.X | re.S,
)

_ESCAPES = {'n': '\\n', 't': '\\t', '"': '"', '\\\\': '\\\\'}
_ARITHMETIC = ('+', '-', '*', '/', '%')
_AGGREGATES = ('count', 'sum', 'min', 'max', 'mean')

# A term is ('v', name) | ('_',) | ('n', int) | ('s', str); an atom is (relation, [term]);
# a literal is ('pos', atom) | ('neg', atom) | ('cmp', op, term, term).


class Rule:
    def __init__(self, head, body, line):
        self.head = head
        self.body = body
        self.line = line


class Program:
    def __init__(self):
        self.decls = {}  # relation -> [(column, type)]
        self.inputs = []
        self.outputs = []
        self.rules = []
        self.facts = []  # (relation, tuple), written in the program text
        self.strata = []  # lists of relations, dependencies first; set by check()

    def idb(self):
        return {r.head[0] for r in self.rules}


def _tokens(text):
    pos, line, out = 0, 1, []
    while pos < len(text):
        m = _TOKEN.match(text, pos)
        if not m:
            raise DatalogError('syntax', 'unexpected character %r at line %d' % (text[pos], line))
        if m.lastgroup != 'skip':
            out.append((m.lastgroup, m.group(), line))
        line += m.group().count('\\n')
        pos = m.end()
    out.append(('eof', '', line))
    return out


class _Parser:
    def __init__(self, text):
        self.toks = _tokens(text)
        self.i = 0

    def peek(self, k=0):
        return self.toks[min(self.i + k, len(self.toks) - 1)]

    def take(self, kind=None, value=None):
        t = self.toks[self.i]
        if (kind and t[0] != kind) or (value is not None and t[1] != value):
            raise DatalogError('syntax', 'expected %s, found %r at line %d' % (value or kind, t[1], t[2]))
        self.i += 1
        return t

    def term(self):
        t = self.take()
        if t[0] == 'string':
            return ('s', re.sub(r'\\\\(.)', lambda m: _ESCAPES.get(m.group(1), m.group(1)), t[1][1:-1]))
        if t[0] == 'number':
            return ('n', int(t[1]))
        if t[0] == 'ident':
            return ('_',) if t[1] == '_' else ('v', t[1])
        raise DatalogError('syntax', 'unexpected %r at line %d' % (t[1], t[2]))

    def atom(self):
        name = self.take('ident')[1]
        self.take('op', '(')
        args = []
        if self.peek()[1] != ')':
            args.append(self.term())
            while self.peek()[1] == ',':
                self.take()
                args.append(self.term())
        self.take('op', ')')
        return (name, args)

    def literal(self):
        t = self.peek()
        if t[1] == '!' and self.peek(1)[0] == 'ident':
            self.take()
            return ('neg', self.atom())
        if t[0] == 'ident' and self.peek(1)[1] == '(':
            return ('pos', self.atom())
        if t[1] in ('(', ';'):
            raise DatalogError('unsupported', 'disjunction or parenthesised body at line %d' % t[2])
        left = self.term()
        op = self.take('op')[1]
        if op in _ARITHMETIC:
            raise DatalogError('unsupported', 'arithmetic at line %d' % t[2])
        if op not in ('=', '!='):
            raise DatalogError('unsupported', 'comparison %s at line %d' % (op, t[2]))
        right = self.term()
        after = self.peek()
        if right[0] == 'v' and right[1] in _AGGREGATES and (after[1] == ':' or after[0] == 'ident'):
            raise DatalogError('unsupported', 'aggregate %s at line %d' % (right[1], t[2]))
        if after[1] in _ARITHMETIC:
            raise DatalogError('unsupported', 'arithmetic at line %d' % t[2])
        return ('cmp', op, left, right)

    def decl(self, line):
        name = self.take('ident')[1]
        self.take('op', '(')
        cols = []
        while self.peek()[1] != ')':
            col = self.take('ident')[1]
            self.take('op', ':')
            ty = self.take('ident')[1]
            if ty not in ('symbol', 'number'):
                raise DatalogError('unsupported', 'column type %s at line %d' % (ty, line))
            cols.append((col, ty))
            if self.peek()[1] == ',':
                self.take()
        self.take('op', ')')
        if self.peek()[0] == 'ident':
            raise DatalogError('unsupported', 'relation qualifier %s at line %d' % (self.peek()[1], line))
        return name, cols

    def program(self):
        prog = Program()
        while self.peek()[0] != 'eof':
            t = self.peek()
            if t[0] == 'directive':
                self.take()
                if t[1] == '.decl':
                    name, cols = self.decl(t[2])
                    if name in prog.decls:
                        raise DatalogError('syntax', 'relation %s declared twice (line %d)' % (name, t[2]))
                    prog.decls[name] = cols
                elif t[1] in ('.input', '.output'):
                    name = self.take('ident')[1]
                    if self.peek()[1] == '(':
                        raise DatalogError('unsupported', 'options on %s at line %d' % (t[1], t[2]))
                    (prog.inputs if t[1] == '.input' else prog.outputs).append(name)
                else:
                    raise DatalogError('unsupported', 'directive %s at line %d' % (t[1], t[2]))
                continue
            if t[0] != 'ident':
                raise DatalogError('syntax', 'unexpected %r at line %d' % (t[1], t[2]))
            head = self.atom()
            if self.peek()[1] == ':-':
                self.take()
                body = [self.literal()]
                while self.peek()[1] == ',':
                    self.take()
                    body.append(self.literal())
                if self.peek()[1] == ';':
                    raise DatalogError('unsupported', 'disjunction at line %d' % self.peek()[2])
                self.take('op', '.')
                prog.rules.append(Rule(head, body, t[2]))
            else:
                self.take('op', '.')
                if any(a[0] not in ('n', 's') for a in head[1]):
                    raise DatalogError('syntax', 'fact %s has a non-constant argument (line %d)' % (head[0], t[2]))
                prog.facts.append((head[0], tuple(a[1] for a in head[1])))
        return prog


def parse(text):
    return _Parser(text).program()


# --------------------------------------------------------------------------- static checks


def _vars(terms):
    return [t[1] for t in terms if t[0] == 'v']


def check(prog):
    """Souffle's front-end checks for the supported fragment. Fills prog.strata."""

    def decl(name, where):
        if name not in prog.decls:
            raise DatalogError('undeclared', 'relation %s is not declared (%s)' % (name, where))
        return prog.decls[name]

    for name in prog.inputs + prog.outputs:
        decl(name, 'directive')
    for rel, vals in prog.facts:
        cols = decl(rel, 'fact')
        if len(vals) != len(cols):
            raise DatalogError('arity', 'fact %s has %d arguments, expected %d' % (rel, len(vals), len(cols)))
        for v, (_, ty) in zip(vals, cols):
            if (ty == 'number') != isinstance(v, int):
                raise DatalogError('type', 'fact %s: %r does not fit a %s column' % (rel, v, ty))

    for rule in prog.rules:
        where = 'line %d' % rule.line
        atoms = [rule.head] + [lit[1] for lit in rule.body if lit[0] in ('pos', 'neg')]
        vtype = {}
        for rel, args in atoms:
            cols = decl(rel, where)
            if len(args) != len(cols):
                raise DatalogError('arity', 'relation %s: expected %d arguments, got %d (%s)' % (rel, len(cols), len(args), where))
            for a, (_, ty) in zip(args, cols):
                if a[0] == 'v':
                    if vtype.setdefault(a[1], ty) != ty:
                        raise DatalogError('type', 'variable %s is both symbol and number (%s)' % (a[1], where))
                elif (a[0] == 'n' and ty != 'number') or (a[0] == 's' and ty != 'symbol'):
                    raise DatalogError('type', 'constant %r does not fit a %s column of %s (%s)' % (a[1], ty, rel, where))
        if any(a[0] == '_' for a in rule.head[1]):
            raise DatalogError('ungrounded', 'wildcard in the head of a rule (%s)' % where)

        grounded = set()
        for lit in rule.body:
            if lit[0] == 'pos':
                grounded.update(_vars(lit[1][1]))
        needed = set(_vars(rule.head[1]))
        for lit in rule.body:
            if lit[0] == 'neg':
                needed.update(_vars(lit[1][1]))
            elif lit[0] == 'cmp':
                if any(s[0] == '_' for s in lit[2:]):
                    raise DatalogError('ungrounded', 'wildcard in a comparison (%s)' % where)
                needed.update(_vars(lit[2:]))
        for v in sorted(needed - grounded):
            if _equality_grounds(rule, v, grounded):
                raise DatalogError('unsupported', 'variable %s is grounded only by an equality (%s)' % (v, where))
            raise DatalogError('ungrounded', 'ungrounded variable %s (%s)' % (v, where))
        for lit in rule.body:
            if lit[0] == 'cmp':
                kinds = set()
                for s in lit[2:]:
                    kinds.add({'n': 'number', 's': 'symbol'}.get(s[0]) or vtype.get(s[1]))
                if len(kinds) > 1:
                    raise DatalogError('type', 'comparison between symbol and number (%s)' % where)
                if all(s[0] != 'v' for s in lit[2:]):
                    raise DatalogError('unsupported', 'comparison of two constants (%s)' % where)

    prog.strata = stratify(prog)


def _equality_grounds(rule, v, grounded):
    for lit in rule.body:
        if lit[0] == 'cmp' and lit[1] == '=':
            for x, y in ((lit[2], lit[3]), (lit[3], lit[2])):
                if x == ('v', v) and (y[0] in ('n', 's') or (y[0] == 'v' and y[1] in grounded)):
                    return True
    return False


def stratify(prog):
    """Strongly connected components of the dependency graph; a negative edge inside one is an error."""
    rels = list(prog.decls)
    edges = {r: set() for r in rels}  # body relation -> head relations that depend on it
    negative = []
    for rule in prog.rules:
        for lit in rule.body:
            if lit[0] in ('pos', 'neg'):
                edges[lit[1][0]].add(rule.head[0])
                if lit[0] == 'neg':
                    negative.append((lit[1][0], rule.head[0]))
    index, low, on, stack, comp, order = {}, {}, set(), [], {}, []

    def strong(v):
        index[v] = low[v] = len(index)
        stack.append(v)
        on.add(v)
        for w in sorted(edges[v]):
            if w not in index:
                strong(w)
                low[v] = min(low[v], low[w])
            elif w in on:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            members = []
            while True:
                w = stack.pop()
                on.discard(w)
                members.append(w)
                if w == v:
                    break
            for w in members:
                comp[w] = len(order)
            order.append(sorted(members))

    for r in rels:
        if r not in index:
            strong(r)
    for src, dst in negative:
        if comp[src] == comp[dst]:
            raise DatalogError('not-stratified', 'negation inside the recursive group {%s}' % ', '.join(order[comp[src]]))
    return list(reversed(order))  # Tarjan emits the dependents first


# --------------------------------------------------------------------------- facts


def load_facts(prog, texts):
    """texts: relation -> contents of its .facts file (tab separated). Returns relation -> set of tuples.

    Read as Souffle reads them: a blank line is a tuple of one empty symbol in a one-column relation and
    an error otherwise, a carriage return before the newline is dropped, and a missing .facts file for an
    input relation is an error. Souffle ignores columns past the last one; the adapter rejects them.
    """
    edb = {r: set() for r in prog.decls}
    for rel in prog.inputs:
        if rel not in texts:
            raise DatalogError('facts', 'no %s.facts for input relation %s' % (rel, rel))
        cols = prog.decls[rel]
        rows = texts[rel].split('\\n')
        if rows[-1] == '':
            rows.pop()
        for n, line in enumerate(rows, 1):
            parts = line.rstrip('\\r').split('\\t')
            if len(parts) != len(cols):
                raise DatalogError('facts', '%s.facts line %d has %d columns, expected %d' % (rel, n, len(parts), len(cols)))
            row = []
            for p, (_, ty) in zip(parts, cols):
                if ty == 'symbol':
                    row.append(p)
                else:
                    try:
                        row.append(int(p))
                    except ValueError:
                        raise DatalogError('facts', '%s.facts line %d: %r is not a number' % (rel, n, p))
            edb[rel].add(tuple(row))
    for rel, vals in prog.facts:
        edb[rel].add(vals)
    return edb


# --------------------------------------------------------------------------- reference evaluator


def _unify(args, tup, env):
    """env extended so that args match tup, or None."""
    env = dict(env)
    for a, v in zip(args, tup):
        if a[0] == '_':
            continue
        if a[0] == 'v':
            if env.setdefault(a[1], v) != v:
                return None
        elif a[1] != v:
            return None
    return env


def _value(t, env):
    return env[t[1]] if t[0] == 'v' else t[1]


def _matches(rule, rels):
    """Every (env, premises) satisfying the rule body over rels; premises are the positive tuples used."""
    out = []

    def go(k, env, premises):
        if k == len(rule.body):
            out.append((env, premises))
            return
        lit = rule.body[k]
        if lit[0] == 'pos':
            rel, args = lit[1]
            for tup in sorted(rels.get(rel, ())):
                e = _unify(args, tup, env)
                if e is not None:
                    go(k + 1, e, premises + [(rel, tup)])
        elif lit[0] == 'neg':
            rel, args = lit[1]
            if not any(_unify(args, tup, env) is not None for tup in rels.get(rel, ())):
                go(k + 1, env, premises)
        else:
            _, op, a, b = lit
            if (_value(a, env) == _value(b, env)) == (op == '='):
                go(k + 1, env, premises)

    go(0, {}, [])
    return out


def _head(rule, env):
    return tuple(_value(a, env) for a in rule.head[1])


def eval_reference(prog, edb):
    """All relations (EDB and derived) by naive evaluation, one stratum at a time."""
    rels = {r: set(edb.get(r, ())) for r in prog.decls}
    by_head = {}
    for rule in prog.rules:
        by_head.setdefault(rule.head[0], []).append(rule)
    for stratum in prog.strata:
        rules = [r for rel in stratum for r in by_head.get(rel, [])]
        changed = bool(rules)
        while changed:
            changed = False
            for rule in rules:
                for env, _ in _matches(rule, rels):
                    t = _head(rule, env)
                    if t not in rels[rule.head[0]]:
                        rels[rule.head[0]].add(t)
                        changed = True
    return rels


# --------------------------------------------------------------------------- Z3 Fixedpoint


def eval_fixedpoint(prog, edb, params=None):
    """All relations: EDB-only ones from the facts, every other relation read back from Fixedpoint."""
    import z3

    consts = set()
    for tuples in edb.values():
        for t in tuples:
            consts.update(t)
    for rule in prog.rules:
        for _, args in [rule.head] + [lit[1] for lit in rule.body if lit[0] in ('pos', 'neg')]:
            consts.update(a[1] for a in args if a[0] in ('n', 's'))
        for lit in rule.body:
            if lit[0] == 'cmp':
                consts.update(s[1] for s in lit[2:] if s[0] in ('n', 's'))
    values = sorted(consts, key=lambda v: (isinstance(v, int), v))
    ident = {v: i for i, v in enumerate(values)}
    width = max(1, (len(values) - 1).bit_length())
    dom = z3.BitVecSort(width)
    boolean = z3.BoolSort()

    def const(v):
        return z3.BitVecVal(ident[v], width)

    fp = z3.Fixedpoint()
    fp.set(engine='datalog')
    for key, val in (params or {}).items():
        fp.set(key, val)
    funcs = {}
    for rel, cols in prog.decls.items():
        funcs[rel] = z3.Function('rel_' + rel, *([dom] * len(cols)), boolean)
        fp.register_relation(funcs[rel])

    counter = [0]

    def fresh():
        counter[0] += 1
        v = z3.Const('v%d' % counter[0], dom)
        fp.declare_var(v)
        return v

    projections = {}

    def projection(rel, keep):
        # Souffle's !r(x, _) holds when no tuple of r agrees with x on the kept columns. Z3 would
        # read the wildcard as an existential over the whole domain, so project the kept columns.
        if (rel, keep) not in projections:
            name = '%s__proj_%s' % (rel, ''.join(str(k) for k in keep))
            funcs[name] = z3.Function('rel_' + name, *([dom] * len(keep)), boolean)
            fp.register_relation(funcs[name])
            vs = [fresh() for _ in prog.decls[rel]]
            fp.rule(funcs[name](*[vs[k] for k in keep]), [funcs[rel](*vs)])
            projections[(rel, keep)] = name
        return funcs[projections[(rel, keep)]]

    for rule in prog.rules:
        env = {}

        def zterm(t):
            if t[0] == 'v':
                if t[1] not in env:
                    env[t[1]] = fresh()
                return env[t[1]]
            if t[0] == '_':
                return fresh()
            return const(t[1])

        head = funcs[rule.head[0]](*[zterm(a) for a in rule.head[1]])
        body = []
        for lit in rule.body:
            if lit[0] == 'pos':
                body.append(funcs[lit[1][0]](*[zterm(a) for a in lit[1][1]]))
            elif lit[0] == 'neg':
                rel, args = lit[1]
                keep = tuple(k for k, a in enumerate(args) if a[0] != '_')
                if len(keep) == len(args):
                    body.append(z3.Not(funcs[rel](*[zterm(a) for a in args])))
                else:
                    body.append(z3.Not(projection(rel, keep)(*[zterm(args[k]) for k in keep])))
            else:
                eq = zterm(lit[2]) == zterm(lit[3])
                body.append(eq if lit[1] == '=' else z3.Not(eq))
        fp.rule(head, body)
    for rel, tuples in edb.items():
        for t in sorted(tuples):
            fp.fact(funcs[rel](*[const(v) for v in t]))

    rels = {r: set(edb.get(r, ())) for r in prog.decls}
    for rel in sorted(prog.idb() | set(prog.outputs)):
        cols = prog.decls[rel]
        xs = [z3.Const('q%d' % k, dom) for k in range(len(cols))]
        goal = funcs[rel](*xs)
        res = fp.query(z3.Exists(xs, goal) if xs else goal)
        if res == z3.sat:
            rels[rel] = _decode(fp.get_answer(), len(cols), values)
        elif res == z3.unsat:
            rels[rel] = set()
        else:
            raise DatalogError('engine', 'Fixedpoint returned %s: %s' % (res, fp.reason_unknown()))
    return rels


def _decode(ans, arity, values):
    """Rows of a relation from the answer formula: Or(And(Var(0) == a, Var(1) == b), ...)."""
    import z3

    if arity == 0:
        return {()} if z3.is_true(ans) else set()
    rows = set()
    for cube in ans.children() if z3.is_or(ans) else [ans]:
        row = [None] * arity
        for e in cube.children() if z3.is_and(cube) else [cube]:
            if not z3.is_eq(e):
                raise DatalogError('engine', 'unexpected answer shape: %s' % e)
            a, b = e.children()
            if z3.is_var(b):
                a, b = b, a
            if not z3.is_var(a) or not z3.is_bv_value(b):
                raise DatalogError('engine', 'unexpected answer shape: %s' % e)
            row[z3.get_var_index(a)] = b.as_long()
        if None in row:
            raise DatalogError('engine', 'a column is unconstrained in the answer: %s' % cube)
        if any(i >= len(values) for i in row):
            raise DatalogError('engine', 'the answer names a value outside the program: %s' % cube)
        rows.add(tuple(values[i] for i in row))
    return rows


# --------------------------------------------------------------------------- derivations


def derive(prog, edb, rels):
    """Minimal derivation heights from the final relations (every relation, EDB included).

    height(EDB tuple) = 0 and height(t) = 1 + the largest height among the positive premises of the
    best rule instance; negated atoms and comparisons are leaves, as in Souffle's proof trees.
    Returns (height, best, contested): height[(rel, tuple)], best[(rel, tuple)] = (rule index,
    premises) for derived tuples, and how many derived tuples have rule instances of different heights.
    """
    insts = []
    for k, rule in enumerate(prog.rules):
        for env, premises in _matches(rule, rels):
            insts.append((rule.head[0], _head(rule, env), k, tuple(premises)))
    height = {(rel, t): 0 for rel, ts in edb.items() for t in ts}
    best = {}
    changed = True
    while changed:
        changed = False
        for head, tup, k, premises in insts:
            if all(p in height for p in premises):
                h = 1 + max((height[p] for p in premises), default=0)
                if (head, tup) not in height or h < height[(head, tup)]:
                    height[(head, tup)] = h
                    best[(head, tup)] = (k, premises)
                    changed = True
    options = {}
    for head, tup, k, premises in insts:
        if (head, tup) in best:
            options.setdefault((head, tup), set()).add(1 + max((height[p] for p in premises), default=0))
    return height, best, sum(1 for v in options.values() if len(v) > 1)


def _is_instance(rule, rel, tup, premises, rels):
    """Is (rel, tup) the head of this rule under a substitution that makes \`premises\` its positive
    atoms, its negated atoms absent from rels and its comparisons true?"""
    if rule.head[0] != rel:
        return False
    env = _unify(rule.head[1], tup, {})
    pos = [lit[1] for lit in rule.body if lit[0] == 'pos']
    if env is None or len(pos) != len(premises):
        return False
    for (prel, pargs), (qrel, qtup) in zip(pos, premises):
        if prel != qrel or qtup not in rels[qrel]:
            return False
        env = _unify(pargs, qtup, env)
        if env is None:
            return False
    for lit in rule.body:
        if lit[0] == 'neg':
            if any(_unify(lit[1][1], x, env) is not None for x in rels[lit[1][0]]):
                return False
        elif lit[0] == 'cmp':
            if (_value(lit[2], env) == _value(lit[3], env)) != (lit[1] == '='):
                return False
    return True


def validate(prog, rels, height, best):
    """Check each reconstructed step as an instance of its rule. Returns (checked, failures)."""
    failures = []
    for (rel, tup), (k, premises) in best.items():
        good = _is_instance(prog.rules[k], rel, tup, premises, rels)
        good = good and height[(rel, tup)] == 1 + max((height[p] for p in premises), default=0)
        if not good:
            failures.append('%s%r by rule %d' % (rel, tup, k))
    return len(best), failures


def firing(prog, rels):
    """Per rule: how many distinct head tuples the rule alone derives over the final relations."""
    return [len({_head(rule, env) for env, _ in _matches(rule, rels)}) for rule in prog.rules]


# --------------------------------------------------------------------------- canonical form


def lines(tuples):
    """Sorted tab-joined tuples; a relation's identity is the SHA-256 of these lines, each plus a newline."""
    return sorted('\\t'.join(str(v) for v in t) for t in tuples)


def digest(tuples):
    text = ''.join(l + '\\n' for l in lines(tuples))
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


# --------------------------------------------------------------------------- harness entry point


def run_case(case_json):
    """One case in, one JSON reply out.

    case: {id, program, facts: {relation: tsv}, engines: [fixedpoint|reference], derive: [engine],
           lines: bool, params: {fixedpoint parameter: value}}
    """
    case = json.loads(case_json)
    reply = {'id': case['id']}
    t0 = time.perf_counter()
    try:
        prog = parse(case['program'])
        check(prog)
        edb = load_facts(prog, case.get('facts', {}))
        reply['parse_check_ms'] = (time.perf_counter() - t0) * 1000
        for engine in case.get('engines', ['fixedpoint']):
            t = time.perf_counter()
            if engine == 'fixedpoint':
                rels = eval_fixedpoint(prog, edb, case.get('params'))
            elif engine == 'reference':
                rels = eval_reference(prog, edb)
            else:
                raise DatalogError('engine', 'unknown engine %s' % engine)
            reply[engine + '_ms'] = (time.perf_counter() - t) * 1000
            reply[engine] = {}
            for rel in prog.outputs:
                reply[engine][rel] = {'tuples': len(rels[rel]), 'sha256': digest(rels[rel])}
                if case.get('lines'):
                    reply[engine][rel]['lines'] = lines(rels[rel])
            if engine in case.get('derive', []):
                t = time.perf_counter()
                height, best, contested = derive(prog, edb, rels)
                checked, failures = validate(prog, rels, height, best)
                reply.setdefault('derive', {})[engine] = {
                    'ms': (time.perf_counter() - t) * 1000,
                    'heights': {
                        rel + '\\t' + '\\t'.join(str(v) for v in tup): h
                        for (rel, tup), h in sorted(height.items(), key=lambda kv: str(kv[0]))
                        if (rel, tup) in best and rel in prog.outputs
                    },
                    'checked': checked,
                    'failures': failures,
                    'contested': contested,
                    'firing': firing(prog, rels),
                }
        reply['ok'] = True
    except DatalogError as e:
        reply['ok'] = False
        reply['error'] = {'kind': e.kind, 'message': e.message}
    return json.dumps(reply)
`,W=`"""INS-datalog in the tab: one cell's program through the W0-S03 adapter (ss_datalog.py, a verbatim copy of
scripts/spikes/W0-S03/ss_datalog.py) and Z3's Fixedpoint.

The adapter checks the program the way Souffle's front end does, Fixedpoint computes the relations, and the
adapter rebuilds a minimal-height derivation for every derived tuple from those relations. This module prints
each .output relation the way \`souffle -D-\` does (a rule of dashes, the name, the column names, a rule of
equals signs, the tuples, a closing rule), in Souffle's order (symbols by first appearance, numbers by value),
and returns a JSON witness the site renders as ruled tables.

Facts live in the program text: a cell has no facts files, so an .input relation is refused.
"""

import hashlib
import json

import ss_datalog as D

# Section 5.6's witness cap is 64 KiB; past this the witness keeps no per-tuple derivations, then none at all.
_WITNESS_CAP = 60_000

# The adapter's fragment (W0-S03 decision 3): anything else is "run this on the Bench".
_BENCH = 'The tab runs the adapter\\'s fragment only (W0-S03 decision 3); run this program on the Bench, where Souffle runs.'


def _symbol_order(text):
    order = {}
    for kind, tok, _ in D._tokens(text):
        if kind == 'string':
            s = D.re.sub(r'\\\\(.)', lambda m: D._ESCAPES.get(m.group(1), m.group(1)), tok[1:-1])
            order.setdefault(s, len(order))
    return order


def _key(order):
    return lambda t: tuple((0, v, 0) if isinstance(v, int) else (1, order.get(v, len(order)), v) for v in t)


def _digest(tuples):
    return hashlib.sha256(''.join(l + '\\n' for l in D.lines(tuples)).encode('utf-8')).hexdigest()


def run(text):
    try:
        prog = D.parse(text)
        D.check(prog)
        if prog.inputs:
            raise D.DatalogError('facts', 'a cell has no .facts files; write the facts of %s in the program' % ', '.join(prog.inputs))
        if not prog.outputs:
            raise D.DatalogError('syntax', 'the program has no .output relation, so there is nothing to print')
        edb = D.load_facts(prog, {})
        rels = D.eval_fixedpoint(prog, edb)
        height, best, _ = D.derive(prog, edb, rels)
        _, failures = D.validate(prog, rels, height, best)
    except D.DatalogError as e:
        msg = '%s: %s' % (e.kind, e.message)
        if e.kind == 'unsupported':
            msg += '\\n' + _BENCH
        return json.dumps({'ok': False, 'error': msg})

    order = _symbol_order(text)
    out = []
    for rel in prog.outputs:
        cols = prog.decls[rel]
        rows = sorted(rels[rel], key=_key(order))
        print('-' * 15)
        print(rel)
        print('\\t'.join(c for c, _ in cols))
        print('=' * 15)
        for t in rows:
            print('\\t'.join(str(v) for v in t))
        print('=' * 15)
        why = []
        for t in rows:
            b = best.get((rel, t))
            # rule numbers as the program counts them: the k-th rule whose head is this relation, from 1
            if b is None:
                why.append(None)
            else:
                k = b[0]
                n = sum(1 for r in prog.rules[: k + 1] if r.head[0] == rel)
                why.append([n, prog.rules[k].line, height[(rel, t)]])
        out.append({
            'name': rel,
            'cols': [[c, ty] for c, ty in cols],
            'rows': [list(t) for t in rows],
            'why': why,
            'tuples': len(rows),
            'sha256': _digest(rows),
        })
    res = {'ok': True, 'relations': out, 'checked': len(best), 'failures': failures}
    if len(json.dumps(res)) > _WITNESS_CAP:
        for r in out:
            r['why'] = None
        res['cut'] = 'derivations'
    if len(json.dumps(res)) > _WITNESS_CAP:
        res = {'ok': True, 'relations': [{k: r[k] for k in ('name', 'cols', 'tuples', 'sha256')} for r in out], 'cut': 'rows'}
    return json.dumps(res)
`;const P="5.3.1",H="Fixedpoint (engine=datalog) via the W0-S03 adapter; Pyodide 314.0.7, z3_solver 5.3.1.0",u=n=>self.postMessage(n);let y=null,I="",x=null,v=null,N=0,b="",E=null,z=[];const _="/ss-datalog",L=`
import sys
if ${JSON.stringify(_)} not in sys.path:
    sys.path.insert(0, ${JSON.stringify(_)})
import z3, ss_datalog, tab
z3.get_version_string()
`;function S(n,r){if(E===null)return;const i={stream:n,text:r};z.push(i),u({t:"out",id:E,line:i})}async function R(n){x===null&&(v===null&&(v=(async()=>{if(y===null)throw new Error("the worker has no manifest entry");const r=performance.now(),i=$(I,y,(l,p)=>u({t:"progress",id:n,phase:"download",loaded:l,total:p}));await i.loadAll(),i.installFetch(),u({t:"progress",id:n,phase:"init"});const d=y.assets.find(l=>l.path.endsWith("/pyodide.mjs"))?.path,f=y.assets.find(l=>l.path.endsWith(".whl"))?.path;if(d===void 0||f===void 0)throw new Error("the manifest lacks pyodide.mjs or the Z3 wheel");const g=i.url(d.slice(0,d.lastIndexOf("/")+1)),o=await(await import(i.url(d))).loadPyodide({indexURL:g,packages:[]});if(await o.loadPackage(i.url(f),{messageCallback:()=>{},errorCallback:l=>S("stderr",l)}),o.FS.mkdirTree(_),o.FS.writeFile(`${_}/ss_datalog.py`,O),o.FS.writeFile(`${_}/tab.py`,W),o.setStdout({batched:l=>S("stdout",l)}),o.setStderr({batched:l=>S("stderr",l)}),b=String(o.runPython(L)),b!==P)throw Object.assign(new Error(`the wheel reports Z3 ${b}; this build pins ${P}`),{code:"version-mismatch"});x=o,N=Math.round(performance.now()-r)})(),v.catch(()=>{v=null})),await v)}async function U(n,r){const i=r?.code;if(typeof i!="string"){u({t:"fail",id:n,code:"invalid-input",detail:"input.code must be a string of Datalog",fatal:!1});return}const d=x===null;try{await R(n)}catch(e){const a=e;u({t:"fail",id:n,code:a.code==="version-mismatch"?"version-mismatch":"engine-crashed",detail:String(a.message??e),fatal:!0});return}const f=x;E=n,z=[],u({t:"progress",id:n,phase:"run"});const g=performance.now();let h=null,o=null,l=[];const p=f.globals.get("dict")();try{p.set("_ss_program",i),f.runPython(`import tab as _ss_tab
_ss_reply = _ss_tab.run(_ss_program)`,{globals:p,filename:"<datalog>"});const e=String(p.get("_ss_reply")),a=JSON.parse(e);a.ok?(o=e,l=(a.relations??[]).map(m=>`${m.name}: ${m.tuples} ${m.tuples===1?"tuple":"tuples"}`)):h=a.error??"the adapter refused the program"}catch(e){h=String(e instanceof Error?e.message:e).trim()}finally{try{f.runPython(`import sys
sys.stdout.flush()
sys.stderr.flush()`)}catch{}p.destroy()}const s=Math.round(performance.now()-g);E=null,u({t:"done",id:n,reply:{verdict:l,witness:o,output:z,error:h,stats:{cold:d,readyMs:d?N:0,runMs:s},printed:b,runtime:H}})}self.onmessage=n=>{const r=n.data;r.t==="init"?(y=r.manifest,I=r.base):r.t==="warm"?R(r.id).then(()=>u({t:"warmed",id:r.id,readyMs:N,printed:b}),i=>u({t:"fail",id:r.id,code:"engine-crashed",detail:String(i?.message??i),fatal:!0})):r.t==="run"&&U(r.id,r.input)};
