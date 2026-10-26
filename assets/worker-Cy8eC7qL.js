const D="ss-engines-v1",L=self.fetch.bind(self),U=e=>[...new Uint8Array(e)].map(s=>s.toString(16).padStart(2,"0")).join(""),Z={wasm:"application/wasm",mjs:"text/javascript",js:"text/javascript",json:"application/json",zip:"application/zip",whl:"application/zip"},M=e=>Z[e.slice(e.lastIndexOf(".")+1)]??"application/octet-stream";function F(e,s,a){const o=new Map;for(const r of s.assets)o.set(new URL(r.path,e).href,r);const i=new Map,c=new Map;let h=Number.NEGATIVE_INFINITY;const l=(r=!1)=>{const n=performance.now();if(!r&&n-h<250)return;h=n;let t=0;for(const d of s.assets)t+=Math.round(Math.min(1,(c.get(d.path)??0)/d.bytes)*d.wire);a(t,s.firstLoadBytes)};async function m(r,n){let t=null;try{t=await caches.open(D);const u=await t.match(r);if(u!==void 0&&u.headers.get("x-ss-sha256")===n.sha256){const k=await u.arrayBuffer();return c.set(n.path,n.bytes),l(),k}}catch{t=null}const d=await L(r,{credentials:"omit"});if(!d.ok||d.body===null)throw new Error(`engine asset ${n.path}: HTTP ${d.status}`);const x=d.body.getReader(),S=[];let N=0;for(;;){const{done:u,value:k}=await x.read();if(u)break;S.push(k),N+=k.byteLength,c.set(n.path,N),l()}const g=new Uint8Array(N);let A=0;for(const u of S)g.set(u,A),A+=u.byteLength;const R=U(await crypto.subtle.digest("SHA-256",g));if(R!==n.sha256)throw new Error(`engine asset ${n.path}: SHA-256 ${R} does not match the manifest`);if(t!==null)try{await t.put(r,new Response(g,{headers:{"content-type":M(n.path),"x-ss-sha256":n.sha256}}))}catch{}return g.buffer}const f=(r,n)=>{let t=i.get(r);return t===void 0&&(t=m(r,n),i.set(r,t)),t};return{url:r=>new URL(r,e).href,async loadAll(){l(!0),await Promise.all([...o].map(([r,n])=>f(r,n))),l(!0)},installFetch(){const r=async n=>{const t=new URL(typeof n=="string"?n:n instanceof URL?n.href:n.url,self.location.href).href,d=o.get(t);if(d===void 0)throw new TypeError(`the instrument origin loads only manifest assets; refused ${t}`);const x=await f(t,d);return new Response(x.slice(0),{status:200,headers:{"content-type":M(d.path)}})};self.fetch=r}}}var O=`# The Derivation Board's checker (INS-derivation, docs/DESIGN.md section 6.8): it reads a derivation written in the
# plain-text notation the S4 lessons use and asks Z3 one validity query per step. It runs inside the derivation
# worker's Pyodide with the z3_solver wheel; \`check_board(text, rlimit)\` returns the board as JSON.
#
# The notation, one line each (Unicode or ASCII):
#   command [Name[, words]:] stmt; stmt; ...     stmt: x := e | f := f[a |-> e] | requires g | assert g | assume g
#   post [Name =] formula                        the postcondition; \`post\` and Name refer to it
#   claim formula                                a proposed precondition; \`claim\` refers to it
#   given g; g; ...                              assumptions every query keeps ("f and t are among x, y, z" too)
#   N  [caption:] formula [ = formula ...]  [rule: words]
# A numbered line whose parts are joined by "  =  " (two spaces each side) is a chain: each part must be equivalent
# to the one before, and a line that starts with "=" continues the previous line. A line that is one formula with a
# top-level => or <=> is checked for validity. Any other line states a formula for later lines to cite as \`line N\`.
# wp(C, Q) is computed here by substitution (capture-free: Z3 binds quantified variables by position), so a
# hand-written step is checked against the real weakest precondition; \`wp(a := a - x; ..., Q)\` names the rest of the
# command from that statement on. Every free name is an integer; a name used as f(x) or f[a |-> v] is a function
# from integers to integers (a Z3 array).

import json
import re

import z3

# ---------------------------------------------------------------- tokens

_SYMBOLS = [
    ('<=>', 'IFF'), ('|->', 'MAPS'), (':=', 'ASSIGN'), ('=>', 'IMPLIES'), ('->', 'ARROW'), ('<=', '<='), ('>=', '>='),
    ('!=', '!='), ('/\\\\', 'and'), ('\\\\/', 'or'), ('&&', 'and'), ('||', 'or'), ('...', 'ELLIPSIS'),
    ('≤', '<='), ('≥', '>='), ('≠', '!='), ('∧', 'and'), ('∨', 'or'), ('¬', 'not'), ('→', 'ARROW'), ('⇒', 'IMPLIES'),
    ('⇔', 'IFF'), ('↔', 'IFF'), ('↦', 'MAPS'), ('∀', 'forall'), ('∃', 'exists'), ('−', '-'), ('·', '*'), ('×', '*'),
    ('…', 'ELLIPSIS'), ('(', '('), (')', ')'), ('[', '['), (']', ']'), (',', ','), ('.', '.'), (';', ';'), ('+', '+'),
    ('-', '-'), ('*', '*'), ('<', '<'), ('>', '>'), ('=', '='), ('!', 'not'), (':', ':'),
]
_WORDS = {'and': 'and', 'or': 'or', 'not': 'not', 'forall': 'forall', 'exists': 'exists', 'true': 'true', 'false': 'false'}
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_']*′*")
_NUM = re.compile(r'[0-9]+')


class ReadError(Exception):
    pass


def tokenize(s):
    out = []
    i = 0
    while i < len(s):
        c = s[i]
        if c.isspace():
            i += 1
            continue
        m = _NUM.match(s, i)
        if m:
            out.append(('NUM', m.group()))
            i = m.end()
            continue
        m = _IDENT.match(s, i)
        if m:
            w = m.group()
            out.append((_WORDS.get(w, 'ID'), w))
            i = m.end()
            continue
        for sym, kind in _SYMBOLS:
            if s.startswith(sym, i):
                out.append((kind, sym))
                i += len(sym)
                break
        else:
            raise ReadError('cannot read %r' % c)
    return out


# ---------------------------------------------------------------- the board's names

INT = z3.IntSort()
FUN = z3.ArraySort(z3.IntSort(), z3.IntSort())


class Board:
    def __init__(self):
        self.funs = set()
        self.commands = {}  # name -> list of stmts
        self.command_order = []
        self.post = None
        self.post_names = set()
        self.claim = None
        self.givens = []
        self.lines = {}  # number -> formula

    def var(self, name, bound):
        if name in bound:
            return bound[name]
        if name in self.funs:
            return z3.Array(name, INT, INT)
        return z3.Int(name)


# ---------------------------------------------------------------- the parser


class Parser:
    def __init__(self, board, toks):
        self.b = board
        self.t = toks
        self.i = 0
        self.refs = set()  # line numbers this formula cites
        self.top = None  # the top-level connective, for "is this line a check"

    def peek(self, k=0):
        j = self.i + k
        return self.t[j][0] if j < len(self.t) else 'EOF'

    def text(self, k=0):
        j = self.i + k
        return self.t[j][1] if j < len(self.t) else ''

    def eat(self, kind):
        if self.peek() != kind:
            raise ReadError('expected %s, found %s' % (kind, self.text() or 'the end'))
        self.i += 1
        return self.t[self.i - 1][1]

    def done(self):
        if self.i != len(self.t):
            raise ReadError('unexpected %s' % self.text())

    # formula := imp (IFF imp)*
    def formula(self, bound):
        left = self.imp(bound)
        top = self.top
        while self.peek() == 'IFF':
            self.i += 1
            right = self.imp(bound)
            left = left == right
            top = 'iff'
        self.top = top
        return left

    def imp(self, bound):
        left = self.disj(bound)
        if self.peek() in ('IMPLIES', 'ARROW'):
            meta = self.peek() == 'IMPLIES'
            self.i += 1
            right = self.imp(bound)
            self.top = 'implies' if meta else 'arrow'
            return z3.Implies(_bool(left), _bool(right))
        self.top = None
        return left

    def disj(self, bound):
        xs = [self.conj(bound)]
        while self.peek() == 'or':
            self.i += 1
            xs.append(self.conj(bound))
        return xs[0] if len(xs) == 1 else z3.Or(*[_bool(x) for x in xs])

    def conj(self, bound):
        xs = [self.neg(bound)]
        while self.peek() == 'and':
            self.i += 1
            xs.append(self.neg(bound))
        return xs[0] if len(xs) == 1 else z3.And(*[_bool(x) for x in xs])

    def neg(self, bound):
        if self.peek() == 'not':
            self.i += 1
            return z3.Not(_bool(self.neg(bound)))
        if self.peek() in ('forall', 'exists'):
            q = self.peek()
            self.i += 1
            names = [self.eat('ID')]
            while self.peek() == ',':
                self.i += 1
                names.append(self.eat('ID'))
            inner = dict(bound)
            vs = []
            for n in names:
                v = z3.Int(n)
                inner[n] = v
                vs.append(v)
            guard = None
            if self.peek() == '!=':  # ∀j ≠ k. body
                self.i += 1
                guard = vs[-1] != _int(self.sum(bound))
            self.eat('.')
            body = _bool(self.formula(inner))
            self.top = None
            if q == 'forall':
                return z3.ForAll(vs, body if guard is None else z3.Implies(guard, body))
            return z3.Exists(vs, body if guard is None else z3.And(guard, body))
        return self.cmp(bound)

    def cmp(self, bound):
        left = self.sum(bound)
        out = []
        while self.peek() in ('<=', '>=', '<', '>', '=', '!='):
            op = self.peek()
            self.i += 1
            right = self.sum(bound)
            out.append({'<=': lambda a, b: a <= b, '>=': lambda a, b: a >= b, '<': lambda a, b: a < b, '>': lambda a, b: a > b,
                        '=': lambda a, b: a == b, '!=': lambda a, b: a != b}[op](left, right))
            left = right
        if not out:
            return left
        return out[0] if len(out) == 1 else z3.And(*out)

    def sum(self, bound):
        left = self.prod(bound)
        while self.peek() in ('+', '-'):
            op = self.peek()
            self.i += 1
            right = self.prod(bound)
            left = _int(left) + _int(right) if op == '+' else _int(left) - _int(right)
        return left

    def prod(self, bound):
        left = self.unary(bound)
        while self.peek() == '*':
            self.i += 1
            left = _int(left) * _int(self.unary(bound))
        return left

    def unary(self, bound):
        if self.peek() == '-':
            self.i += 1
            return -_int(self.unary(bound))
        return self.postfix(bound)

    def postfix(self, bound):
        e = self.atom(bound)
        while self.peek() in ('(', '['):
            if self.peek() == '(':
                if not z3.is_array(e):
                    raise ReadError('%s is not a function' % e)
                self.i += 1
                arg = _int(self.sum(bound))
                self.eat(')')
                e = z3.Select(e, arg)
            else:
                self.i += 1
                if z3.is_array(e) and not (self.peek() == 'ID' and self.text() in self.b.funs and self.peek(1) == 'MAPS'):
                    at = _int(self.sum(bound))
                    self.eat('MAPS')
                    v = _int(self.sum(bound))
                    self.eat(']')
                    e = z3.Store(e, at, v)
                else:  # substitution: (formula)[x ↦ e]
                    name = self.eat('ID')
                    self.eat('MAPS')
                    v = self.sum(bound)
                    self.eat(']')
                    e = z3.substitute(e, (self.b.var(name, {}), v))
        return e

    def atom(self, bound):
        k = self.peek()
        if k == 'NUM':
            return z3.IntVal(int(self.eat('NUM')))
        if k == 'true':
            self.i += 1
            return z3.BoolVal(True)
        if k == 'false':
            self.i += 1
            return z3.BoolVal(False)
        if k == '(':
            self.i += 1
            e = self.formula(bound)
            self.eat(')')
            self.top = None
            return e
        if k == 'ID':
            name = self.eat('ID')
            if name == 'line' and self.peek() == 'NUM':
                n = int(self.eat('NUM'))
                if n not in self.b.lines:
                    raise ReadError('line %d has no formula above this line' % n)
                self.refs.add(n)
                return self.b.lines[n]
            if name == 'wp' and self.peek() == '(':
                self.i += 1
                stmts = self.stmts(bound)
                self.eat(',')
                q = _bool(self.formula(bound))
                self.eat(')')
                self.top = None
                return wp(self.b, stmts, q)
            if name not in bound:
                if name in ('post', 'Post') or name in self.b.post_names:
                    if self.b.post is None:
                        raise ReadError('no post line above')
                    return self.b.post
                if name == 'claim':
                    if self.b.claim is None:
                        raise ReadError('no claim line above')
                    return self.b.claim
            return self.b.var(name, bound)
        raise ReadError('unexpected %s' % (self.text() or 'the end'))

    # ------------------------------------------------ commands

    def stmts(self, bound):
        out = [self.stmt(bound)]
        while self.peek() == ';':
            self.i += 1
            out.append(self.stmt(bound))
        # \`s; …\` names the rest of a command on the board, from the statement that matches s.
        if any(s[0] in ('rest', 'pattern') for s in out):
            return resolve_rest(self.b, out)
        return out

    def stmt(self, bound):
        start = self.i
        k, w = self.peek(), self.text()
        if k == 'ELLIPSIS':
            self.i += 1
            return ('rest',)
        if k == 'ID' and w in ('requires', 'assert', 'assume'):
            self.i += 1
            if self.peek() == 'ELLIPSIS':
                self.i += 1
                return ('pattern', w)
            g = _bool(self.formula(bound))
            return (w, g, _src(self.t[start:self.i]))
        if k == 'ID' and self.peek(1) == 'ASSIGN':
            name = self.eat('ID')
            self.eat('ASSIGN')
            e = self.sum(bound)
            return ('assign', self.b.var(name, {}), e, _src(self.t[start:self.i]))
        if k == 'ID' and w in self.b.commands:
            self.i += 1
            return ('call', w)
        raise ReadError('cannot read a command at %s' % (w or 'the end'))


def _src(toks):
    # by token kind, so \`a − amount\` and \`a - amount\` name the same statement
    return ' '.join(t[1] if t[0] in ('ID', 'NUM') else t[0] for t in toks)


def _bool(e):
    if not z3.is_bool(e):
        raise ReadError('%s is not a formula' % e)
    return e


def _int(e):
    if z3.is_bool(e) or z3.is_array(e):
        raise ReadError('%s is not a number' % e)
    return e


def resolve_rest(b, pattern):
    head = pattern[0]
    for name in b.command_order:
        body = b.commands[name]
        for i, s in enumerate(body):
            if head[0] == 'pattern' and s[0] == head[1]:
                return body[i:]
            if head[0] == s[0] and head[-1] == s[-1]:
                return body[i:]
    raise ReadError('no command on the board has that statement')


def wp(b, stmts, q):
    """wp(stmts, q) by substitution; \`requires g\` reads as the reject reading (a rejected command leaves the state)."""
    out = q
    for s in reversed(expand(b, stmts)):
        if s[0] == 'assign':
            out = z3.substitute(out, (s[1], s[2]))
        elif s[0] == 'requires':
            out = z3.And(z3.Implies(s[1], out), z3.Implies(z3.Not(s[1]), q))
        elif s[0] == 'assert':
            out = z3.And(s[1], out)
        elif s[0] == 'assume':
            out = z3.Implies(s[1], out)
    return out


def expand(b, stmts):
    out = []
    for s in stmts:
        if s[0] == 'call':
            out.extend(expand(b, b.commands[s[1]]))
        else:
            out.append(s)
    return out


# ---------------------------------------------------------------- reading the board

_HEADER = re.compile(r'^\\s*(command|post|claim|given)\\b\\s*(.*)$', re.I)
_STEP = re.compile(r'^\\s*(\\d+)[.)]?\\s+(.*)$')
_CHAIN = re.compile(r'\\s{2,}(?:=|≡)\\s{2,}')
_AMONG = re.compile(r'^\\s*(.+?)\\s+(?:is|are)\\s+among\\s+(.+?)\\s*$')


def parse_formula(b, text):
    p = Parser(b, tokenize(text))
    e = p.formula({})
    p.done()
    return _bool(e), p


def parse_loose(b, text):
    """A formula, after a caption set off by two or more spaces ("naive      ∀k. ..."); None when it is prose."""
    rest = text.strip()
    while rest != '':
        try:
            e, p = parse_formula(b, rest)
            return rest, e, p
        except (ReadError, z3.Z3Exception):
            pass
        parts = re.split(r'\\s{2,}', rest, maxsplit=1)
        rest = parts[1] if len(parts) > 1 else ''
    return None


def caption_split(body):
    """Split "caption:  formula" at a colon that is not part of := and sits outside brackets."""
    depth = 0
    for i, c in enumerate(body):
        if c in '([':
            depth += 1
        elif c in ')]':
            depth -= 1
        elif c == ':' and depth == 0 and body[i + 1:i + 2] != '=' and body[i + 1:].strip() != '':
            return body[:i].strip(), body[i + 1:].strip()
    return None, body


def read_header(b, kind, rest, notes):
    kind = kind.lower()
    if kind == 'command':
        label, body = caption_split(rest)
        p = Parser(b, tokenize(body))
        stmts = p.stmts({})
        p.done()
        name = re.match(r'\\s*([A-Za-z_][A-Za-z0-9_]*)', label).group(1) if label else 'command%d' % (len(b.commands) + 1)
        b.commands[name] = stmts
        b.command_order.append(name)
        return {'kind': 'command', 'name': name, 'text': rest.strip()}
    if kind == 'post':
        m = re.match(r'^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.+)$', rest)
        if m:
            try:
                e, _ = parse_formula(b, m.group(2))
                b.post, name = e, m.group(1)
                b.post_names.add(name)
                return {'kind': 'post', 'name': name, 'text': rest.strip()}
            except (ReadError, z3.Z3Exception):
                pass
        b.post, _ = parse_formula(b, rest)
        return {'kind': 'post', 'text': rest.strip()}
    if kind == 'claim':
        b.claim, _ = parse_formula(b, rest)
        return {'kind': 'claim', 'text': rest.strip()}
    read = []
    for part in [x for x in re.split(r'\\s*;\\s*', rest) if x.strip()]:
        m = _AMONG.match(part)
        try:
            if m:
                who = [x.strip() for x in re.split(r'\\s*,\\s*|\\s+and\\s+', m.group(1)) if x.strip()]
                among = [x.strip() for x in re.split(r'\\s*,\\s*|\\s+and\\s+|\\s+or\\s+', m.group(2)) if x.strip()]
                g = z3.And(*[z3.Or(*[b.var(w, {}) == b.var(a, {}) for a in among]) for w in who])
            else:
                g, _ = parse_formula(b, part)
            b.givens.append(g)
            read.append(part)
        except (ReadError, z3.Z3Exception) as e:
            notes.append('given "%s" was not read: %s' % (part, e))
    return {'kind': 'given', 'text': rest.strip(), 'read': read}


def scan_functions(b, text):
    for m in re.finditer(r"([A-Za-z_][A-Za-z0-9_']*)\\s*[(\\[]", text):
        if m.group(1) not in ('wp', 'line') and not m.group(1)[0].isupper():
            b.funs.add(m.group(1))


# ---------------------------------------------------------------- Z3


def free_consts(e):
    """The free names of e, and the free names it uses as a function's argument (the state shows f at those)."""
    seen, out, idx, todo = set(), [], [], [e]
    while todo:
        x = todo.pop()
        if x.get_id() in seen:
            continue
        seen.add(x.get_id())
        if z3.is_const(x) and x.decl().kind() == z3.Z3_OP_UNINTERPRETED:
            out.append(x)
        elif z3.is_quantifier(x):
            todo.append(x.body())
        else:
            if z3.is_select(x) and z3.is_const(x.arg(1)) and x.arg(1).decl().kind() == z3.Z3_OP_UNINTERPRETED:
                idx.append(x.arg(1))
            todo.extend(x.children())
    key = lambda c: str(c)
    return sorted(out, key=key), sorted({c.get_id(): c for c in idx}.values(), key=key)


def show_array(m, a, ints):
    v = m.eval(a, model_completion=True)
    pts, dflt = [], None
    if z3.is_as_array(v):
        fi = m[z3.get_as_array_func(v)]
        pts = [(str(k), str(val)) for k, val in fi.as_list()[:-1]]
        dflt = str(fi.else_value())
    else:
        while z3.is_store(v):
            pts.append((str(v.arg(1)), str(v.arg(2))))
            v = v.arg(0)
        dflt = str(v.arg(0)) if z3.is_K(v) else None
    out = ['%s(%s) = %s' % (a, c, m.eval(z3.Select(a, c), model_completion=True)) for c in ints]
    table = ', '.join('%s ↦ %s' % p for p in reversed(pts))
    if dflt is not None:
        table = (table + ', ' if table else '') + 'otherwise %s' % dflt
    if table:
        out.append('%s: %s' % (a, table))
    return out


def query(claim, givens, rlimit):
    """A state where \`claim\` fails under the givens: unsat makes the claim valid."""
    s = z3.Solver()
    s.set('rlimit', rlimit)
    for g in givens:
        s.add(g)
    s.add(z3.Not(claim))
    r = s.check()
    raw = str(r)
    state = None
    if r == z3.sat:
        m = s.model()
        consts, idx = free_consts(z3.And(claim, *givens) if givens else claim)
        state = ['%s = %s' % (c, m.eval(c, model_completion=True)) for c in consts if c.sort() == INT]
        for a in [c for c in consts if c.sort() == FUN]:
            state.extend(show_array(m, a, idx))
    return raw, state


# ---------------------------------------------------------------- the board


def check_board(text, rlimit):
    b = Board()
    scan_functions(b, text)
    header, steps, notes = [], [], []
    tainted = set()
    last = None  # the previous step's value, for a line that starts with "="
    last_n = None
    for raw_line in text.split('\\n'):
        line = raw_line.rstrip()
        if line.strip() == '' or line.lstrip().startswith(('#', '--')):
            continue
        h = _HEADER.match(line)
        if h:
            try:
                header.append(read_header(b, h.group(1), h.group(2), notes))
            except (ReadError, z3.Z3Exception) as e:
                header.append({'kind': h.group(1).lower(), 'text': h.group(2).strip(), 'error': str(e)})
            continue
        m = _STEP.match(line)
        if not m:
            notes.append('not a numbered step, left unread: %s' % line.strip())
            continue
        n = int(m.group(1))
        body = m.group(2)
        rule = None
        r = re.search(r'\\s+rule:\\s*(.*)$', body)
        if r:
            rule = r.group(1).strip()
            body = body[:r.start()]
        caption, body = caption_split(body)
        step = {'n': n, 'text': m.group(2).strip(), 'caption': caption, 'rule': rule, 'checks': [], 'rests_on': []}
        stripped = body.strip()
        if stripped[:1] in ('=', '≡') and not stripped.startswith('=>'):
            parts = [''] + _CHAIN.split(stripped[1:].strip())  # continues the line above
        else:
            parts = _CHAIN.split(stripped)
        try:
            read = []
            refs = set()
            for i, part in enumerate(parts):
                if part.strip() == '':
                    if i == 0:
                        if last is None:
                            raise ReadError('this line continues a line above, and there is none')
                        read.append(('line %d' % last_n, last))
                        refs.add(last_n)
                    continue
                got = parse_loose(b, part)
                if got is None:
                    read.append((part.strip(), None))
                else:
                    read.append((got[0], got[1]))
                    refs |= got[2].refs
                    if len(parts) == 1:
                        step['top'] = got[2].top
            step['rests_on'] = sorted(refs)
            formulas = [x for x in read if x[1] is not None]
            if not formulas:
                try:  # the reason the first part does not read
                    parse_formula(b, read[0][0])
                except (ReadError, z3.Z3Exception) as e:
                    raise ReadError('no formula on this line could be read: %s' % e)
                raise ReadError('no formula on this line could be read')
            value = formulas[-1][1]
            if len(read) >= 2:
                for (ta, a), (tb, bb) in zip(read, read[1:]):
                    if a is None or bb is None:
                        step['checks'].append({'q': 'prose: "%s" is not a formula, so this link is not checked' % (ta if a is None else tb), 'raw': None})
                        continue
                    raw_r, state = query(a == bb, b.givens, rlimit)
                    step['checks'].append({'q': 'a state where %s and %s disagree' % (ta, tb), 'raw': raw_r, 'state': state})
            if caption is not None and len(formulas) == 1 and len(read) == 1:
                cap = parse_loose(b, caption)
                if cap is not None and cap[0] == caption.strip():
                    raw_r, state = query(cap[1] == value, b.givens, rlimit)
                    step['checks'].append({'q': 'a state where the caption and the formula disagree', 'raw': raw_r, 'state': state})
                    refs |= cap[2].refs
                    step['rests_on'] = sorted(refs)
            if len(read) == 1 and step.get('top') in ('implies', 'iff') or (rule is not None and re.search(r'consequence|equivalence|implication', rule)):
                raw_r, state = query(value, b.givens, rlimit)
                step['checks'].append({'q': 'a state where the %s fails' % ('equivalence' if step.get('top') == 'iff' else 'implication'), 'raw': raw_r, 'state': state})
            b.lines[n] = value
            step['formula'] = str(value) if len(str(value)) < 400 else None
            raws = [c['raw'] for c in step['checks'] if c['raw'] is not None]
            if not raws:
                step['result'] = 'stated'
            elif 'sat' in raws:
                step['result'] = 'not-valid'
            elif 'unknown' in raws:
                step['result'] = 'unknown'
            else:
                step['result'] = 'valid'
            last, last_n = value, n
        except (ReadError, z3.Z3Exception) as e:
            step['result'] = 'unread'
            step['error'] = str(e)
            last, last_n = None, None
        # A line that rests on a line that did not follow (directly or through others) is downstream of it; if it
        # fails too, it is a follow-on and is not counted again (DESIGN.md section 6.8).
        bad = [d for d in step['rests_on'] if d in tainted]
        step['follow_on'] = bad if step['result'] in ('not-valid', 'unknown') and bad else []
        step['after_failed'] = bad
        if step['result'] in ('not-valid', 'unread') or bad:
            tainted.add(n)
        steps.append(step)
    counted = [s['n'] for s in steps if s['result'] == 'not-valid' and not s['follow_on']]
    return json.dumps({'board': 1, 'z3': z3.get_version_string(), 'rlimit': rlimit, 'header': header, 'steps': steps,
                       'notes': notes, 'not_valid': counted}, ensure_ascii=False)
`;const j="5.3.1",$="Pyodide 314.0.7, z3_solver 5.3.1.0, derivation board 1",C=5e6,p=e=>self.postMessage(e);let w=null,P="",z=null,q=null,b=null,E=0,_="",y=null,I=[];function v(e,s){if(y===null)return;const a={stream:e,text:s};I.push(a),p({t:"out",id:y,line:a})}async function T(e){z===null&&(b===null&&(b=(async()=>{if(w===null)throw new Error("the worker has no manifest entry");const s=performance.now(),a=F(P,w,(f,r)=>p({t:"progress",id:e,phase:"download",loaded:f,total:r}));await a.loadAll(),a.installFetch(),p({t:"progress",id:e,phase:"init"});const o=w.assets.find(f=>f.path.endsWith("/pyodide.mjs"))?.path,i=w.assets.find(f=>f.path.endsWith(".whl"))?.path;if(o===void 0||i===void 0)throw new Error("the manifest lacks pyodide.mjs or the Z3 wheel");const c=a.url(o.slice(0,o.lastIndexOf("/")+1)),l=await(await import(a.url(o))).loadPyodide({indexURL:c,packages:[]});await l.loadPackage(a.url(i),{messageCallback:()=>{},errorCallback:f=>v("stderr",f)}),l.setStdout({batched:f=>v("stdout",f)}),l.setStderr({batched:f=>v("stderr",f)});const m=l.globals.get("dict")();if(l.runPython(O,{globals:m,filename:"derivation.py"}),q=m.get("check_board"),_=String(l.runPython(`import z3
z3.get_version_string()`)),_!==j)throw Object.assign(new Error(`the wheel reports Z3 ${_}; this build pins ${j}`),{code:"version-mismatch"});z=l,E=Math.round(performance.now()-s)})(),b.catch(()=>{b=null})),await b)}const H={valid:"valid","not-valid":"not valid",unknown:"unknown at the rlimit",stated:"stated, not checked",unread:"not read"};function B(e){const s=e.checks.map(i=>i.raw).filter(i=>i!==null),a=e.checks.find(i=>i.raw==="sat")?.state,o=[`line ${e.n}:`,s.length>0?`${s.join(", ")} →`:"",H[e.result]];return a!=null&&a.length>0&&o.push(`[${a.join(", ")}]`),e.follow_on.length>0&&o.push(`(follow-on of line ${e.follow_on.join(", ")})`),e.error!==void 0&&o.push(`(${e.error})`),o.filter(i=>i!=="").join(" ")}async function G(e,s,a){const o=s?.code;if(typeof o!="string"){p({t:"fail",id:e,code:"invalid-input",detail:"input.code must be the derivation as text",fatal:!1});return}const i=z===null;try{await T(e)}catch(n){const t=n;p({t:"fail",id:e,code:t.code==="version-mismatch"?"version-mismatch":"engine-crashed",detail:String(t.message??n),fatal:!0});return}y=e,I=[],p({t:"progress",id:e,phase:"run"});const c=performance.now();let h=null,l=null,m=[];try{l=String(q(o,Math.floor(a)));const n=JSON.parse(l);for(const t of n.steps)v("stdout",B(t));m=n.steps.filter(t=>t.checks.some(d=>d.raw!==null)).map(t=>`line ${t.n}: ${t.checks.map(d=>d.raw??"-").join(" ")}`)}catch(n){h=String(n instanceof Error?n.message:n).trim()}const f=Math.round(performance.now()-c);y=null,p({t:"done",id:e,reply:{verdict:m,witness:l,output:I,error:h,stats:{cold:i,readyMs:i?E:0,runMs:f},printed:_,runtime:$}})}self.onmessage=e=>{const s=e.data;s.t==="init"?(w=s.manifest,P=s.base):s.t==="warm"?T(s.id).then(()=>p({t:"warmed",id:s.id,readyMs:E,printed:_}),a=>p({t:"fail",id:s.id,code:"engine-crashed",detail:String(a?.message??a),fatal:!0})):s.t==="run"&&G(s.id,s.input,s.budget.rlimit??C)};
