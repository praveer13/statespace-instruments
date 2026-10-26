const B="ss-engines-v1",P=self.fetch.bind(self),D=e=>[...new Uint8Array(e)].map(s=>s.toString(16).padStart(2,"0")).join(""),M={wasm:"application/wasm",mjs:"text/javascript",js:"text/javascript",json:"application/json",zip:"application/zip",whl:"application/zip"},b=e=>M[e.slice(e.lastIndexOf(".")+1)]??"application/octet-stream";function H(e,s,a){const t=new Map;for(const r of s.assets)t.set(new URL(r.path,e).href,r);const p=new Map,l=new Map;let i=Number.NEGATIVE_INFINITY;const n=(r=!1)=>{const d=performance.now();if(!r&&d-i<250)return;i=d;let u=0;for(const E of s.assets)u+=Math.round(Math.min(1,(l.get(E.path)??0)/E.bytes)*E.wire);a(u,s.firstLoadBytes)};async function o(r,d){let u=null;try{u=await caches.open(B);const L=await u.match(r);if(L!==void 0&&L.headers.get("x-ss-sha256")===d.sha256){const h=await L.arrayBuffer();return l.set(d.path,d.bytes),n(),h}}catch{u=null}const E=await P(r,{credentials:"omit"});if(!E.ok||E.body===null)throw new Error(`engine asset ${d.path}: HTTP ${E.status}`);const N=E.body.getReader(),O=[];let I=0;for(;;){const{done:L,value:h}=await N.read();if(L)break;O.push(h),I+=h.byteLength,l.set(d.path,I),n()}const f=new Uint8Array(I);let w=0;for(const L of O)f.set(L,w),w+=L.byteLength;const U=D(await crypto.subtle.digest("SHA-256",f));if(U!==d.sha256)throw new Error(`engine asset ${d.path}: SHA-256 ${U} does not match the manifest`);if(u!==null)try{await u.put(r,new Response(f,{headers:{"content-type":b(d.path),"x-ss-sha256":d.sha256}}))}catch{}return f.buffer}const c=(r,d)=>{let u=p.get(r);return u===void 0&&(u=o(r,d),p.set(r,u)),u};return{url:r=>new URL(r,e).href,async loadAll(){n(!0),await Promise.all([...t].map(([r,d])=>c(r,d))),n(!0)},installFetch(){const r=async d=>{const u=new URL(typeof d=="string"?d:d instanceof URL?d.href:d.url,self.location.href).href,E=t.get(u);if(E===void 0)throw new TypeError(`the instrument origin loads only manifest assets; refused ${u}`);const N=await c(u,E);return new Response(N.slice(0),{status:200,headers:{"content-type":b(E.path)}})};self.fetch=r}}}const y={textInputBytes:256*1024},W=new TextEncoder,k=e=>W.encode(JSON.stringify(e)??"").byteLength,x=["S7.L4-world-no-read-policies","S7.L4-world-all-policies"];function V(e){if(e===null||typeof e!="object"||Array.isArray(e))return{code:"invalid-input",detail:"input must be {code: string, world?: string}"};const s=e,a=Object.keys(s);return typeof s.code!="string"||a.some(t=>t!=="code"&&t!=="world")?{code:"invalid-input",detail:"input must be {code: string, world?: string}"}:s.world!==void 0&&(typeof s.world!="string"||!x.includes(s.world))?{code:"invalid-input",detail:`input.world must be one of ${x.join(", ")}`}:k(s.code)>y.textInputBytes?{code:"too-large",detail:`input above ${y.textInputBytes} bytes`}:null}const q=/[A-Za-z_\u0080-￿]/,_=/[A-Za-z0-9_\u0080-￿]/;function j(e){let s=0;for(;s<e.length;){const a=e[s];if(a===" "||a==="	"||a===`
`||a==="\r"||a==="\f")s++;else if(a==="-"&&e[s+1]==="-"){const t=e.indexOf(`
`,s);s=t<0?e.length:t+1}else if(a==="/"&&e[s+1]==="*"){let t=1;for(s+=2;s<e.length&&t>0;)e[s]==="/"&&e[s+1]==="*"?(t++,s+=2):e[s]==="*"&&e[s+1]==="/"?(t--,s+=2):s++}else return!0}return!1}function K(e,s,a){let t=s;for(;t<a;){const p=e[t];if(p===" "||p==="	"||p===`
`||p==="\r"||p==="\f")t++;else if(p==="-"&&e[t+1]==="-"){const l=e.indexOf(`
`,t);t=l<0||l>a?a:l+1}else if(p==="/"&&e[t+1]==="*"){let l=1;for(t+=2;t<a&&l>0;)e[t]==="/"&&e[t+1]==="*"?(l++,t+=2):e[t]==="*"&&e[t+1]==="/"?(l--,t+=2):t++}else return t}return a}function z(e){const s=[];let a=0,t=0;const p=e.length,l=i=>{const n=e.slice(a,i);if(j(n)){const o=K(e,a,i);let c=1;for(let r=0;r<o;r++)e.charCodeAt(r)===10&&c++;s.push({sql:e.slice(o,i).trimEnd(),line:c})}};for(;t<p;){const i=e[t];if(i==="-"&&e[t+1]==="-"){const n=e.indexOf(`
`,t);t=n<0?p:n+1}else if(i==="/"&&e[t+1]==="*"){let n=1;for(t+=2;t<p&&n>0;)e[t]==="/"&&e[t+1]==="*"?(n++,t+=2):e[t]==="*"&&e[t+1]==="/"?(n--,t+=2):t++}else if(i==="'"){const n=t>0?e[t-1]:"",o=(n==="E"||n==="e")&&(t<2||!_.test(e[t-2]));for(t++;t<p;)if(o&&e[t]==="\\")t+=2;else if(e[t]==="'")if(e[t+1]==="'")t+=2;else{t++;break}else t++}else if(i==='"')for(t++;t<p;)if(e[t]==='"')if(e[t+1]==='"')t+=2;else{t++;break}else t++;else if(i==="$"&&(t===0||!_.test(e[t-1]))){let n=t+1;if(n<p&&q.test(e[n]))for(n++;n<p&&_.test(e[n]);)n++;if(e[n]==="$"){const o=e.slice(t,n+1),c=e.indexOf(o,n+1);t=c<0?p:c+o.length}else t++}else i===";"?(l(t),t++,a=t):t++}return l(p),s}const J=200,Z=new Set([20,21,23,26,700,701,1700]),Q=e=>Z.has(e),X=e=>e.replace(/\r?\n/g,"\\n");function ee(e,s,a){const t=s.map(n=>n.map(o=>o===null?"":X(o))),p=e.map((n,o)=>Math.max(n.name.length,...t.map(c=>(c[o]??"").length))),l=(n,o)=>{const c=Math.floor((o-n.length)/2);return" ".repeat(c)+n+" ".repeat(o-n.length-c)},i=[e.map((n,o)=>` ${l(n.name,p[o])} `).join("|")];i.push(p.map(n=>"-".repeat(n+2)).join("+"));for(const n of t)i.push(e.map((o,c)=>{const r=n[c]??"";return` ${o.numeric?r.padStart(p[c]):r.padEnd(p[c])} `}).join("|").replace(/ +$/,""));return a>s.length&&i.push(`… ${a-s.length} more rows not shown`),i.push(`(${a} ${a===1?"row":"rows"})`,""),i}function v(e,s){const a=[`${e}${s.severity}:  ${s.code}: ${s.message}`];return s.detail!==void 0&&a.push(`DETAIL:  ${s.detail}`),s.hint!==void 0&&a.push(`HINT:  ${s.hint}`),s.where!==void 0&&a.push(`CONTEXT:  ${s.where}`),a}function te(e){const s=[];for(const a of e.notices)for(const t of v(`<cell>:${e.line}: `,a))s.push({stream:"stderr",text:t});if(e.error!==null){for(const a of v(`<cell>:${e.line}: `,e.error))s.push({stream:"stderr",text:a});return s}if(e.columns!==null&&e.rows!==null){for(const a of ee(e.columns,e.rows,e.rowCount))s.push({stream:"stdout",text:a});e.tag!==null&&!/^(SELECT|SHOW|FETCH|EXPLAIN|VALUES|TABLE)\b/.test(e.tag)&&s.push({stream:"stdout",text:e.tag})}else e.tag!==null&&s.push({stream:"stdout",text:e.tag});return s}const se=6e4;function G(e){return{severity:String(e.severity??"ERROR"),code:String(e.code??""),message:String(e.message??""),...e.detail?{detail:String(e.detail)}:{},...e.hint?{hint:String(e.hint)}:{},...e.where?{where:String(e.where)}:{}}}class ae{db;protocol;dirty=!1;constructor(s,a){this.db=s,this.protocol=a}async statement(s,a){const t=await this.db.execProtocol(this.protocol.serialize.query(s),{throwOnError:!1});let p=null;const l=[];let i=0,n=null,o=null;const c=[];let r="I";for(const u of t.messages){const E=u;switch(E.name){case"rowDescription":p=(E.fields??[]).map(N=>({name:String(N.name??"?"),numeric:Q(Number(N.dataTypeID))}));break;case"dataRow":i++,l.length<J&&l.push((E.fields??[]).map(N=>N==null?null:String(N)));break;case"commandComplete":n=String(E.text??"");break;case"error":o=G(E);break;case"notice":c.push(G(E));break;case"readyForQuery":r=E.status==="T"||E.status==="E"?E.status:"I";break}}const d=s.split(`
`,1)[0].slice(0,160);return{line:a,head:d,tag:o===null?n:null,columns:o===null?p:null,rows:o===null&&p!==null?l:null,rowCount:i,error:o,notices:c,tx:r}}async reset(){this.db.isInTransaction()&&await this.statement("ROLLBACK",0);for(const i of["SET SESSION AUTHORIZATION postgres","RESET ROLE","DISCARD ALL"])await this.statement(i,0);const s=await this.statement("SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'",0);for(const[i]of s.rows??[])i!==null&&await this.statement(`DROP SCHEMA "${i.replace(/"/g,'""')}" CASCADE`,0);const t=((await this.statement("SELECT rolname FROM pg_roles WHERE rolname <> 'postgres' AND rolname NOT LIKE 'pg\\_%'",0)).rows??[]).map(([i])=>`"${String(i).replace(/"/g,'""')}"`);if(t.length>0){await this.statement(`DROP OWNED BY ${t.join(", ")} CASCADE`,0);for(const i of t)await this.statement(`DROP ROLE ${i}`,0)}for(const i of["CREATE SCHEMA public AUTHORIZATION pg_database_owner","GRANT USAGE ON SCHEMA public TO PUBLIC","DISCARD ALL"])await this.statement(i,0);const p=await this.statement("SELECT current_user, session_user, (SELECT count(*) FROM pg_roles WHERE rolname <> 'postgres' AND rolname NOT LIKE 'pg\\_%'), (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public')",0),l=p.rows?.[0];return l===void 0||l[0]!=="postgres"||l[1]!=="postgres"||l[2]!=="0"||l[3]!=="0"?`the session did not reset cleanly (${JSON.stringify(l??p.error)})`:null}async run(s,a,t,p){if(this.dirty){const E=await this.reset();if(E!==null)throw Object.assign(new Error(E),{code:"engine-crashed"})}this.dirty=!0;const l=[],i=E=>{l.push(E),p(E)};a!==null&&(await this.db.exec(a.sql),await this.statement("RESET ROLE",0),i({stream:"stderr",text:`-- loaded ${a.id} first, as the recorded run did`}));const n=[];for(const E of z(s)){const N=await this.statement(E.sql,E.line);n.push(N);for(const O of te(N))i(O)}const o=this.db.isInTransaction();o&&(await this.statement("ROLLBACK",0),i({stream:"stderr",text:"-- the cell ended inside a transaction block; it was rolled back, as psql does on exit"}));let c=n,r=0;const d=E=>JSON.stringify(E).length;for(;c.length>0&&d(c)>se;)c=c.slice(0,-1),r++;const u=n.map(E=>E.error!==null?`${E.error.severity} ${E.error.code}`:E.tag??"");return{witness:{pg:1,version:t,world:a?.id??null,steps:c,rolledBack:o,stepsCut:r},lines:l,verdict:u}}}var ne=`-- S7.L4 template world (W0), generated from scripts/spikes/W0-S08/rls-spec.mjs; mode: no-read-policies
CREATE ROLE app_owner NOLOGIN;
CREATE ROLE app_users NOLOGIN;
CREATE ROLE dana NOLOGIN IN ROLE app_users;
CREATE ROLE frank NOLOGIN IN ROLE app_users;
CREATE ROLE gia NOLOGIN IN ROLE app_users;
CREATE ROLE hal NOLOGIN IN ROLE app_users;
CREATE ROLE eli NOLOGIN IN ROLE app_users;
CREATE ROLE ivy NOLOGIN IN ROLE app_users;
CREATE ROLE jo NOLOGIN IN ROLE app_users;
CREATE ROLE kim NOLOGIN IN ROLE app_users;
CREATE ROLE rls_bypass NOLOGIN BYPASSRLS IN ROLE app_users;
CREATE SCHEMA app AUTHORIZATION app_owner;
GRANT USAGE ON SCHEMA app TO app_users;
SET ROLE app_owner;
CREATE TABLE app.teams (id int PRIMARY KEY, name text NOT NULL, tenant text NOT NULL);
CREATE TABLE app.subteams (child_id int NOT NULL REFERENCES app.teams (id), parent_id int NOT NULL REFERENCES app.teams (id));
CREATE TABLE app.memberships (user_name text NOT NULL, team_id int NOT NULL REFERENCES app.teams (id), role text NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')), PRIMARY KEY (user_name, team_id));
CREATE TABLE app.documents (id text PRIMARY KEY, slug text NOT NULL UNIQUE, team_id int NOT NULL REFERENCES app.teams (id), title text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '', internal_notes text NOT NULL DEFAULT '', shared_team_ids int[] NOT NULL DEFAULT '{}');
CREATE TABLE app.shares (doc_id text NOT NULL REFERENCES app.documents (id), user_name text NOT NULL, revoked boolean NOT NULL DEFAULT false);
CREATE FUNCTION app.user_teams(u text) RETURNS int[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $f$
     WITH RECURSIVE t(team_id) AS (
       SELECT m.team_id FROM app.memberships m WHERE m.user_name = u
       UNION
       SELECT s.parent_id FROM app.subteams s JOIN t ON s.child_id = t.team_id)
     SELECT coalesce(array_agg(team_id ORDER BY team_id), '{}'::int[]) FROM t $f$;
CREATE FUNCTION app.editor_teams(u text) RETURNS int[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $f$
     SELECT coalesce(array_agg(m.team_id ORDER BY m.team_id), '{}'::int[]) FROM app.memberships m WHERE m.user_name = u AND m.role <> 'viewer' $f$;
CREATE TABLE app.notes (id int PRIMARY KEY, body text NOT NULL);
CREATE TABLE app.vault (id int PRIMARY KEY, secret text NOT NULL);
INSERT INTO app.notes VALUES (1, 'n1'), (2, 'n2');
INSERT INTO app.vault VALUES (1, 's1'), (2, 's2');
GRANT SELECT, INSERT, UPDATE ON app.documents TO app_users;
GRANT SELECT ON app.shares, app.notes, app.vault TO app_users;
ALTER TABLE app.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.vault ENABLE ROW LEVEL SECURITY;
RESET ROLE;
TRUNCATE app.shares, app.documents, app.memberships, app.subteams, app.teams;
INSERT INTO app.teams VALUES (1, 'Payments', 'Acme'), (2, 'Growth', 'Acme'), (3, 'Legal', 'Birch'), (4, 'Risk', 'Acme');
INSERT INTO app.subteams VALUES (4, 1);
INSERT INTO app.memberships VALUES ('dana', 1, 'editor'), ('frank', 2, 'viewer'), ('gia', 3, 'admin'), ('hal', 3, 'viewer'), ('eli', 4, 'viewer');
INSERT INTO app.documents (id, slug, team_id, title, shared_team_ids) VALUES ('contract', 'contract', 3, 'contract title', '{}'), ('layoffs-memo', 'layoffs-memo', 3, 'layoffs-memo title', '{}'), ('q3-plan', 'q3-plan', 1, 'q3-plan title', '{}'), ('roadmap', 'roadmap', 2, 'roadmap title', '{1}');
INSERT INTO app.shares VALUES ('contract', 'dana', false), ('roadmap', 'gia', true);
CREATE POLICY edit_team ON app.documents FOR UPDATE USING (team_id = ANY (app.editor_teams(current_setting('app.user', true)))) WITH CHECK (team_id = ANY (app.editor_teams(current_setting('app.user', true))));
CREATE POLICY insert_team ON app.documents FOR INSERT WITH CHECK (team_id = ANY (app.user_teams(current_setting('app.user', true))));
CREATE POLICY notes_read ON app.notes FOR SELECT TO app_users USING (true);
`,re=`-- S7.L4 template world (W0), generated from scripts/spikes/W0-S08/rls-spec.mjs; mode: all-policies
CREATE ROLE app_owner NOLOGIN;
CREATE ROLE app_users NOLOGIN;
CREATE ROLE dana NOLOGIN IN ROLE app_users;
CREATE ROLE frank NOLOGIN IN ROLE app_users;
CREATE ROLE gia NOLOGIN IN ROLE app_users;
CREATE ROLE hal NOLOGIN IN ROLE app_users;
CREATE ROLE eli NOLOGIN IN ROLE app_users;
CREATE ROLE ivy NOLOGIN IN ROLE app_users;
CREATE ROLE jo NOLOGIN IN ROLE app_users;
CREATE ROLE kim NOLOGIN IN ROLE app_users;
CREATE ROLE rls_bypass NOLOGIN BYPASSRLS IN ROLE app_users;
CREATE SCHEMA app AUTHORIZATION app_owner;
GRANT USAGE ON SCHEMA app TO app_users;
SET ROLE app_owner;
CREATE TABLE app.teams (id int PRIMARY KEY, name text NOT NULL, tenant text NOT NULL);
CREATE TABLE app.subteams (child_id int NOT NULL REFERENCES app.teams (id), parent_id int NOT NULL REFERENCES app.teams (id));
CREATE TABLE app.memberships (user_name text NOT NULL, team_id int NOT NULL REFERENCES app.teams (id), role text NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')), PRIMARY KEY (user_name, team_id));
CREATE TABLE app.documents (id text PRIMARY KEY, slug text NOT NULL UNIQUE, team_id int NOT NULL REFERENCES app.teams (id), title text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '', internal_notes text NOT NULL DEFAULT '', shared_team_ids int[] NOT NULL DEFAULT '{}');
CREATE TABLE app.shares (doc_id text NOT NULL REFERENCES app.documents (id), user_name text NOT NULL, revoked boolean NOT NULL DEFAULT false);
CREATE FUNCTION app.user_teams(u text) RETURNS int[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $f$
     WITH RECURSIVE t(team_id) AS (
       SELECT m.team_id FROM app.memberships m WHERE m.user_name = u
       UNION
       SELECT s.parent_id FROM app.subteams s JOIN t ON s.child_id = t.team_id)
     SELECT coalesce(array_agg(team_id ORDER BY team_id), '{}'::int[]) FROM t $f$;
CREATE FUNCTION app.editor_teams(u text) RETURNS int[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, app AS $f$
     SELECT coalesce(array_agg(m.team_id ORDER BY m.team_id), '{}'::int[]) FROM app.memberships m WHERE m.user_name = u AND m.role <> 'viewer' $f$;
CREATE TABLE app.notes (id int PRIMARY KEY, body text NOT NULL);
CREATE TABLE app.vault (id int PRIMARY KEY, secret text NOT NULL);
INSERT INTO app.notes VALUES (1, 'n1'), (2, 'n2');
INSERT INTO app.vault VALUES (1, 's1'), (2, 's2');
GRANT SELECT, INSERT, UPDATE ON app.documents TO app_users;
GRANT SELECT ON app.shares, app.notes, app.vault TO app_users;
ALTER TABLE app.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.vault ENABLE ROW LEVEL SECURITY;
RESET ROLE;
TRUNCATE app.shares, app.documents, app.memberships, app.subteams, app.teams;
INSERT INTO app.teams VALUES (1, 'Payments', 'Acme'), (2, 'Growth', 'Acme'), (3, 'Legal', 'Birch'), (4, 'Risk', 'Acme');
INSERT INTO app.subteams VALUES (4, 1);
INSERT INTO app.memberships VALUES ('dana', 1, 'editor'), ('frank', 2, 'viewer'), ('gia', 3, 'admin'), ('hal', 3, 'viewer'), ('eli', 4, 'viewer');
INSERT INTO app.documents (id, slug, team_id, title, shared_team_ids) VALUES ('contract', 'contract', 3, 'contract title', '{}'), ('layoffs-memo', 'layoffs-memo', 3, 'layoffs-memo title', '{}'), ('q3-plan', 'q3-plan', 1, 'q3-plan title', '{}'), ('roadmap', 'roadmap', 2, 'roadmap title', '{1}');
INSERT INTO app.shares VALUES ('contract', 'dana', false), ('roadmap', 'gia', true);
CREATE POLICY read_team ON app.documents FOR SELECT USING (team_id = ANY (app.user_teams(current_setting('app.user', true))));
CREATE POLICY read_shared ON app.documents FOR SELECT USING (EXISTS (SELECT 1 FROM app.shares s WHERE s.doc_id = documents.id AND s.user_name = current_setting('app.user', true) AND NOT s.revoked));
CREATE POLICY read_team_shared ON app.documents FOR SELECT USING (shared_team_ids && app.user_teams(current_setting('app.user', true)));
CREATE POLICY edit_team ON app.documents FOR UPDATE USING (team_id = ANY (app.editor_teams(current_setting('app.user', true)))) WITH CHECK (team_id = ANY (app.editor_teams(current_setting('app.user', true))));
CREATE POLICY insert_team ON app.documents FOR INSERT WITH CHECK (team_id = ANY (app.user_teams(current_setting('app.user', true))));
CREATE POLICY notes_read ON app.notes FOR SELECT TO app_users USING (true);
`;const ie={"S7.L4-world-no-read-policies":{id:"S7.L4-world-no-read-policies",source:"runs/inputs/S7/RUN-pg-rls-semantics/world-no-read-policies.sql",sha256:"82bbec5cc7762c0acec024f73a419fa27dfeb8dec56af4958700e0cdf7c867e9",sql:ne},"S7.L4-world-all-policies":{id:"S7.L4-world-all-policies",source:"runs/inputs/S7/RUN-pg-rls-owner/world-all-policies.sql",sha256:"0ed3d43ff8e641b45763711cd0f308577052b9d78806a96b2a02358693bda975",sql:re}},F="0.5.11",oe="PGlite in memory, one connection, wasm32",m=e=>self.postMessage(e);let A=null,Y="",T=null,R=null,g=0,C="",S="";async function $(e){T===null&&(R===null&&(R=(async()=>{if(A===null)throw new Error("the worker has no manifest entry");const s=performance.now(),a=H(Y,A,(r,d)=>m({t:"progress",id:e,phase:"download",loaded:r,total:d}));await a.loadAll(),a.installFetch(),m({t:"progress",id:e,phase:"init"});const t=r=>{const d=A?.assets.find(u=>u.path.endsWith(`/${r}`));if(d===void 0)throw new Error(`the manifest lacks ${r}`);return a.url(d.path)},[p,l,i]=await Promise.all([fetch(t("pglite.wasm")).then(r=>r.arrayBuffer()).then(r=>WebAssembly.compile(r)),fetch(t("initdb.wasm")).then(r=>r.arrayBuffer()).then(r=>WebAssembly.compile(r)),fetch(t("pglite.data")).then(r=>r.blob())]),n=await import(t("index.js")),o=await n.PGlite.create({wasmModule:p,initdbWasmModule:l,fsBundle:i});S=String((await o.query("select version()")).rows[0]?.version??"");const c=/^PostgreSQL (\S+) \(PGlite (\S+)\)/.exec(S);if(c===null||c[2]!==F)throw Object.assign(new Error(`the engine reports "${S.slice(0,120)}"; this build pins PGlite ${F}`),{code:"version-mismatch"});C=`${c[2]} (PostgreSQL ${c[1]})`,T=new ae(o,n.protocol),g=Math.round(performance.now()-s)})(),R.catch(()=>{R=null})),await R)}async function pe(e,s){const a=V(s);if(a!==null){m({t:"fail",id:e,code:a.code,detail:a.detail,fatal:!1});return}const{code:t,world:p}=s,l=T===null;try{await $(e)}catch(n){const o=n;m({t:"fail",id:e,code:o.code==="version-mismatch"?"version-mismatch":"engine-crashed",detail:String(o.message??n),fatal:!0});return}m({t:"progress",id:e,phase:"run"});const i=performance.now();try{const n=p===void 0?null:ie[p]??null,o=await T.run(t,n,S,r=>m({t:"out",id:e,line:r})),c={verdict:o.verdict,witness:JSON.stringify(o.witness),output:o.lines,error:null,stats:{cold:l,readyMs:l?g:0,runMs:Math.round(performance.now()-i)},printed:C,runtime:oe};m({t:"done",id:e,reply:c})}catch(n){T=null,m({t:"fail",id:e,code:"engine-crashed",detail:String(n?.message??n),fatal:!0})}}self.onmessage=e=>{const s=e.data;s.t==="init"?(A=s.manifest,Y=s.base):s.t==="warm"?$(s.id).then(()=>m({t:"warmed",id:s.id,readyMs:g,printed:C}),a=>m({t:"fail",id:s.id,code:"engine-crashed",detail:String(a?.message??a),fatal:!0})):s.t==="run"&&pe(s.id,s.input)};
