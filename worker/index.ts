import {validatePlane} from './validation';
import {getModel} from '../src/generation/catalog';
import type {Provider} from '../src/generation/catalog/types';
import {toRunpod} from '../src/generation/runpod-input';
import {createRunpodClient,parseRunpodId,runpodKey} from './runpod';
import {
  enqueueLocalJob, readHeartbeat, claimLocalJob, finishLocalJob,
  recordHeartbeat, verifyRequest, toLocalJob, uploadLocalMedia, LOCAL_PREFIX,
  renewLocalJobLease, attachPromptId, verifyJobUpload, isMediaKey, MAX_UPLOAD_BYTES,
  MAX_ATTEMPTS, signMediaFetch, verifyMediaSignature, MEDIA_ASSERTION_HEADER,
  MEDIA_ASSERTION_MAX_TTL_SECONDS, sha256Hex, ownerSegmentOf, keyBelongsToSubject,
  referenceKeysOf, isOwnedMediaKey, mediaAssertionFromUrl, signReferenceUrl,
  isSubjectSegment, isPrincipalSegment, isOwnerSegment,
} from './local-poll';
import { localStatusFor } from './local-status';
import { planWithAgent, validatePlanRequest, HELD_ROUTES, enhanceWithAgent, validateEnhanceRequest } from './planner';
import {toPlatform} from '../src/generation/to-platform';
import {createPlatformClient,PlatformError} from '../src/generation/platform';
import {parseCredentialInput} from '../src/generation/credentials';
import {BodyLimitError,readLimitedText} from './body';
import {
  identityConfigured, requirePrincipal, segmentFor, identityView,
  handleList, handleRead, handleUpload, handleDelete,
  libraryDenied, methodNotAllowed, jsonNoStore,
  registerRequest, partitionStatusIds, updateRegistryState, resolveOutputUrl, mirrorOnce,
  normalizeAllowlist, sessionMatchesPrincipal, buildSessionEnvelope,
} from './privacy';
import { privatizeHostedStatus, recordOwnerOutputs } from './privacy/hosted-output';
type Env={ASSETS:{fetch:(r:Request)=>Promise<Response>};SESSION_SECRET:string;HF_API_BASE_URL:string;LOCAL_BRIDGE_HMAC?:string;LOCAL_CLAIM_HOLD?:string;OWNER_ACCESS_KEY?:string;PLANNER_GO_API_KEY?:string;MEDIA:any;API_LIMITER?:{limit:(x:{key:string})=>Promise<{success:boolean}>};TEAM_DOMAIN?:string;ACCESS_AUD?:string;MIRROR_ALLOWLIST?:string;ADMIN_RECOVERY_SUBJECT?:string};
const COOKIES:Record<Provider,string>={higgsfield:'__Host-witchcraft-session',runpod:'__Host-witchcraft-runpod',local:'__Host-witchcraft-local'};
/* v0.02: owner sessions last 365d in both the cookie and encrypted envelope.
   Hosted credential envelopes retain their existing 24h lifetime. Rotation of
   OWNER_ACCESS_KEY still immediately invalidates every sealed owner copy. */
const SESSION_MAX_AGE=365*24*60*60;
function parseProvider(value:string|null):Provider{if(value===null)return 'higgsfield';if(value==='runpod'||value==='higgsfield'||value==='local')return value;throw new Error('Unknown generation provider.');}
const json=(value:unknown,status=200,headers:Record<string,string>={})=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const enc=new TextEncoder(),dec=new TextDecoder();
function b64(bytes:Uint8Array){let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s);}
function unb64(value:string){return Uint8Array.from(atob(value),c=>c.charCodeAt(0));}
async function cryptoKey(secret:string){if(!secret||secret.length<32)throw new Error('Secure sessions are not configured.');return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',enc.encode(secret)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
/** Seal any opaque credential. The local owner key is NOT a provider
    credential: it is never parsed as id:secret and never verified upstream.
    `principal` binds the sealed envelope to the VERIFIED Access principal (the
    `p_<32hex>` namespace) when one is present; the credential value is stored
    opaquely and is never returned or logged. */
export async function seal(apiKey:string,secret:string,provider:Provider='higgsfield',principalVerified?:string){const iv=crypto.getRandomValues(new Uint8Array(12)),body=enc.encode(JSON.stringify({apiKey,provider,expires:Date.now()+(provider==='local'?SESSION_MAX_AGE*1000:86400000),...(principalVerified?{principalHint:principalVerified}:{})}));const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},await cryptoKey(secret),body);return b64(iv)+'.'+b64(new Uint8Array(cipher));}
export async function unseal(value:string,secret:string,provider:Provider='higgsfield'):Promise<string|null>{try{const [iv,data]=value.split('.');if(!iv||!data)return null;const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv)},await cryptoKey(secret),unb64(data));const parsed=JSON.parse(dec.decode(plain));if(parsed.expires<=Date.now()||(parsed.provider??'higgsfield')!==provider)return null;
// A local owner credential is an opaque owner access key, not a provider
// key: it is never id:secret-parsed. It is compared to OWNER_ACCESS_KEY by
// ownerKeyFrom and is never used against a hosted provider.
if(provider==='local')return typeof parsed.apiKey==='string'?parsed.apiKey:null;
return provider==='runpod'?runpodKey(parsed.apiKey):parseCredentialInput(parsed).apiKey;}catch{return null;}}
/** Read the principal the sealed envelope was minted for, if any. Returns
    undefined for a legacy cookie that predates principal binding — the caller
    must then treat it as UNBOUND, never as a new customer's credential. */
export async function unsealPrincipal(value:string,secret:string,provider:Provider):Promise<string|undefined>{
 try{const [iv,data]=value.split('.');if(!iv||!data)return undefined;const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv)},await cryptoKey(secret),unb64(data));const parsed=JSON.parse(dec.decode(plain));if((parsed.provider??'higgsfield')!==provider)return undefined;return typeof parsed.principalHint==='string'&&/^p_[0-9a-f]{32}$/.test(parsed.principalHint)?parsed.principalHint:undefined;}catch{return undefined;}}
/** Local owner session: a sealed opaque value that must equal the configured
    owner access key. There is no provider verification and no id:secret form. */
async function ownerKeyFrom(request:Request,env:Env):Promise<string|null>{
 const COOKIE=COOKIES.local;
 const raw=(request.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
 if(!raw||!env.OWNER_ACCESS_KEY)return null;
 const opened=await unseal(raw,env.SESSION_SECRET,'local').catch(()=>null);
 if(!opened||opened!==env.OWNER_ACCESS_KEY)return null;
 // Sealed-cookie principal binding for the OWNER cookie too: an owner cookie
 // bound to a principal is honoured only for the SAME verified principal. A
 // legacy unbound owner cookie is never accepted as a new person's credential
 // once identity is configured. Owner GPU/planner remains a SEPARATE privilege
 // (it is not granted by login); binding only prevents cross-account reuse.
 if(identityConfigured(env)){
  const bound=await unsealPrincipal(raw,env.SESSION_SECRET,'local');
  const current=await verifiedPrincipalSegment(request,env);
  if(bound!==undefined&&bound!==current)return null;
 }
 return opened;
}
async function keyFrom(request:Request,env:Env,provider:Provider='higgsfield'){
 if(provider==='local')return ownerKeyFrom(request,env);
 const COOKIE=COOKIES[provider];
 const raw=(request.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
 if(!raw)return null;
 // Sealed-cookie principal binding: a cookie bound to a principal is honoured
 // only for THAT verified principal; a legacy unbound cookie is never accepted
 // as a new customer's credential once identity is configured. When identity is
 // unconfigured, legacy behaviour is unchanged (no regression).
 if(identityConfigured(env)){
  const bound=await unsealPrincipal(raw,env.SESSION_SECRET,provider);
  const current=await verifiedPrincipalSegment(request,env);
  if(bound===undefined||current===undefined||bound!==current)return null;
 }
 return unseal(raw,env.SESSION_SECRET,provider);
}
/** The `p_<32hex>` namespace of the VERIFIED Access principal on this request,
    or undefined when the identity layer is unconfigured or the token is absent/
    invalid. Never derived from a header/cookie/body the caller controls. */
async function verifiedPrincipalSegment(request:Request,env:Env):Promise<string|undefined>{
 if(!identityConfigured(env))return undefined;
 const auth=await requirePrincipal(request,env);
 return auth.ok?segmentFor(auth.principal):undefined;
}
/** True when a sealed provider cookie may be honoured for THIS request.
    - A cookie bound to a principal is honoured ONLY for the same verified
      principal (a shared browser switching Google accounts is refused).
    - A LEGACY cookie (no principalHint) is UNBOUND: when the identity layer is
      configured it is NOT accepted as a new customer's credential and must not
      be used to assign legacy shared-key media. When identity is unconfigured,
      legacy behaviour is preserved (no regression for the existing owner flow). */
async function sealedCookieAllowed(request:Request,env:Env,provider:Provider,rawCookie:string):Promise<boolean>{
 if(!identityConfigured(env))return true; // identity off: legacy behaviour unchanged
 const bound=await unsealPrincipal(rawCookie,env.SESSION_SECRET,provider);
 const current=await verifiedPrincipalSegment(request,env);
 if(bound===undefined)return false; // unbound legacy cookie: never a customer credential
 return current!==undefined&&bound===current;
}
/** Read + binding-check a sealed cookie for a provider. Returns the raw cookie
    value only when the principal binding (if any) matches the verified caller.
    Used by the legacy owner paths (/api/plan, /api/enhance, /api/generate local)
    so an unbound/mismatched legacy cookie cannot bypass account binding. */
function rawCookieFor(request:Request,provider:Provider):string{
 const COOKIE=COOKIES[provider];
 return (request.headers.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1)||'';
}
/** The VERIFIED `p_<principal32>` segment of the caller, or undefined. */
async function boundSegment(request:Request,env:Env):Promise<string|undefined>{
 return identityConfigured(env)?await verifiedPrincipalSegment(request,env):undefined;
}
/** Register ownership of a hosted request from a REAL provider request id, using
    the VERIFIED principal segment. Returns {ok:true} or an explicit failure so
    the caller can emit a recoverable receipt instead of a false success. */
async function registerOwned(env:Env,requestId:string,principalSegment:string,provider:Provider):Promise<{ok:boolean;reason?:string}>{
 if(!/^[a-z0-9:_-]{1,120}$/i.test(requestId))return {ok:false,reason:'bad_request_id'};
 try{await registerRequest(env.MEDIA,{requestId,subject:principalSegment,provider});return {ok:true};}
 catch(error){return {ok:false,reason:error instanceof Error?error.message:'registry_error'};}
}
/** A denial for /media is always 404, never 401: a probe must not learn whether
    an object exists. Every /media response — success or denial — is
    private,no-store so no shared cache can retain the response. */
function mediaNotFound(){return new Response('Not found',{status:404,headers:{'Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff'}});}
/** Every same-origin `/media/` reference carried by a submission body, at any
    depth, as the stored media keys they name. A hosted submission may point the
    provider at a reference URL, so a same-origin URL to ANOTHER subject's object
    must be caught before the provider is asked to fetch it — this walks the
    whole body (including graph/body arrays) rather than a fixed field list.

    URLs are parsed with the URL constructor and compared on the CANONICAL
    origin+pathname, so an encoded or relative form (`%2e%2e`, `./media/..`,
    a `?query`, a `#fragment`) cannot slip a foreign key past a raw substring
    test. A same-origin /media/ URL whose key is not a valid stored key shape is
    rejected (returns "invalid") rather than silently ignored, so a malformed
    reference cannot be forwarded either. */
function mediaReferenceKeys(value:unknown,origin:string):{keys:string[];invalid:boolean}{
 const keys:string[]=[];
 let invalid=false;
 const strings:string[]=[];
 const collect=(node:unknown)=>{
  if(typeof node==='string'){strings.push(node);return;}
  if(node===null||typeof node!=='object')return;
  if(Array.isArray(node)){for(const item of node)collect(item);return;}
  for(const child of Object.values(node as Record<string,unknown>))collect(child);
 };
 collect(value);
 for(const raw of strings){
  let parsed:URL;
  try{parsed=new URL(raw,origin);}catch{continue;}
  // A string that is not a URL at all is not a reference: skip silently.
  if(parsed.protocol!=='http:'&&parsed.protocol!=='https:')continue;
  if(parsed.origin!==origin)continue;
  if(!parsed.pathname.startsWith('/media/'))continue;
  // The pathname is the CANONICAL, NOT-yet-decoded path, so a reference carries
  // the SAME slash the /media route expects: a normal stored key is
  // `<32hex>/<uuid>.<ext>` with exactly one interior slash. A RAW `includes('/')`
  // test here rejects that legitimate owned reference and was the regression:
  // only an encoded-separator fixture (%2F) ever passed. Correctness is decided
  // by decoding the key and requiring the canonical stored shape (isMediaKey),
  // so a `..` path-dot, a malformed percent escape, a third segment, a foreign
  // container path or a bad extension all fail closed.
  let key:string;
  try{key=decodeURIComponent(parsed.pathname.slice('/media/'.length));}catch{invalid=true;continue;}
  if(key.includes('..')||key.includes('\0')||!isMediaKey(key)){invalid=true;continue;}
  keys.push(key);
 }
 return {keys:[...new Set(keys)],invalid};
}
/** True when every same-origin media reference in the body is a VALID stored
    key owned by one of the caller's OWN verified subjects. A foreign,
    subjectless or malformed reference fails, so a URL cannot launder another
    session's object into a render. */
async function referencesAreOwned(value:unknown,origin:string,subjects:string[],env:Env):Promise<boolean>{
 const {keys,invalid}=mediaReferenceKeys(value,origin);
 if(invalid)return false;
 for(const key of keys){
  const obj=await env.MEDIA.get(key);
  const owner=String(obj?.customMetadata?.owner??key.split('/')[0]??'');
  if(!obj||!subjects.includes(owner))return false;
 }
 return true;
}
/** Rewrite every OWNED same-origin `/media/` reference in a submission body to
    carry a short-lived server-minted HMAC assertion, so a hosted provider can
    fetch it without a cookie. Returns ok:false when a same-origin reference
    exists but no bridge secret can sign it — the caller then marks hosted
    private references unsupported rather than forwarding a bare private URL.

    Only the string values that are same-origin /media/ URLs are rewritten; every
    other value is passed through untouched, so provider URLs and prompts are
    never altered. */
function signHostedReferences(value:unknown,origin:string,bridgeKey:string):{ok:boolean;value:unknown}{
 if(typeof value!=='object'||value===null)return {ok:true,value};
 let sawOwned=false;
 let signable=true;
 const clone=(node:unknown):unknown=>{
  if(typeof node==='string'){
   let parsed:URL;
   try{parsed=new URL(node,origin);}catch{return node;}
   if(parsed.origin!==origin||!parsed.pathname.startsWith('/media/'))return node;
   const key=decodeURIComponent(parsed.pathname.slice('/media/'.length));
   if(!isMediaKey(key))return node;
   sawOwned=true;
   if(!bridgeKey){signable=false;return node;}
   return signReferenceUrl(bridgeKey,node,origin);
  }
  if(Array.isArray(node))return node.map(clone);
  if(node===null||typeof node!=='object')return node;
  const out:Record<string,unknown>={};
  for(const [k,v] of Object.entries(node as Record<string,unknown>))out[k]=clone(v);
  return out;
 };
 const next=clone(value);
 return {ok:!(sawOwned&&!signable),value:next};
}
/** The authorization subjects of the CURRENT request, as the subject segments
    that prefix media the request may read.
      - IDENTITY ON: the ONLY customer subject is the VERIFIED Access principal
        (`p_<32hex>`). Credential hashes are deliberately NOT subjects: a shared
        provider key is a SPEND permission, not an ownership identity, so two
        people on one key must never read each other's objects. A verified
        principal is required for any subject at all — a mismatched/unbound
        cookie yields no reading subject (fail closed).
      - IDENTITY OFF: legacy behaviour is preserved — the owner session maps to
        sha256(OWNER_ACCESS_KEY), and each hosted provider session to
        sha256(apiKey). This legac  path is only reachable when the identity
        layer is unconfigured.
    A request with no verified subject has an empty set. Renaming the renderer
    owner is deliberately NOT a subject, because a renderer is not a person. */
async function mediaSubjects(request:Request,env:Env):Promise<string[]>{
 if(identityConfigured(env)){
  // Verified per-person principal is the ONLY ownership subject when identity
  // is ON. No credential hash is added alongside it.
  const seg=await verifiedPrincipalSegment(request,env);
  return seg?[seg]:[];
 }
 const subjects:string[]=[];
 const owner=await ownerKeyFrom(request,env);
 if(owner)subjects.push(ownerSegmentOf(await sha256Hex(owner)));
 for(const provider of ['higgsfield','runpod'] as const){
  const key=await keyFrom(request,env,provider);
  if(key)subjects.push(ownerSegmentOf(await sha256Hex(key)));
 }
 return [...new Set(subjects)];
}
const OWNER_RE=/^[A-Za-z0-9_-]{16,256}$/;
function isJobId(v:unknown):v is string{return typeof v==='string'&&/^[a-z0-9-]{1,64}$/i.test(v);}
export default {async fetch(request:Request,env:Env):Promise<Response>{
 const url=new URL(request.url),path=url.pathname;
 if(path.startsWith('/media/')){
  // (e) Every /media response — success, denial, malformed path/method — is
  // private,no-store. A 405 here uses the same no-store contract as a 404.
  if(request.method!=='GET'&&request.method!=='HEAD')return new Response('Method not allowed',{status:405,headers:{'Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff'}});
  let key:string;
  try{key=decodeURIComponent(path.slice(7));}catch{return mediaNotFound();}
  // Reject anything that is not exactly the stored two-segment schema. This
  // also kills `..`, NUL, encoded slashes (which decode into extra segments)
  // and a leading slash, before any storage or auth work.
  if(!isMediaKey(key)||key.includes('..')||key.includes('\0')||key.split('/').length!==2)return mediaNotFound();
  // 1) A session holding any verified current subject may read an object that
  //    belongs to ANY of its subjects. Merely authenticating is NOT enough to
  //    read every object: the object's owner segment must match a subject the
  //    caller actually holds.
  const subjects=await mediaSubjects(request,env);
  let allowed=subjects.some((subject)=>keyBelongsToSubject(key,subject));
  // 2) Otherwise a short-lived, method+key-bound assertion — from the bridge
  //    header, or (for a provider fetching a private reference) the signed
  //    query. No static public media secret exists; the assertion names this
  //    exact key and this exact method and expires. Both forms use the SAME
  //    verifier and there is no endpoint that mints an assertion on demand.
  if(!allowed){
   const headerAssertion=request.headers.get(MEDIA_ASSERTION_HEADER);
   const queryAssertion=mediaAssertionFromUrl(url);
   allowed=verifyMediaSignature(env.LOCAL_BRIDGE_HMAC||'',key,request.method,headerAssertion)
     ||verifyMediaSignature(env.LOCAL_BRIDGE_HMAC||'',key,request.method,queryAssertion);
  }
  // 3) Fail closed BEFORE storage access: a denied caller cannot tell a
  //    missing object from a forbidden one, and cannot trigger an R2 read.
  if(!allowed)return mediaNotFound();
  const obj=await env.MEDIA.get(key);
  if(!obj)return mediaNotFound();
  return new Response(request.method==='HEAD'?null:obj.body,{headers:{'Content-Type':obj.httpMetadata?.contentType||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'private,no-store','Vary':'Cookie'}});
 }
 if(!path.startsWith('/api/')&&!path.startsWith('/auth/')){const result=await env.ASSETS.fetch(request);const headers=new Headers(result.headers);headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','strict-origin-when-cross-origin');headers.set('X-Frame-Options','DENY');return new Response(result.body,{status:result.status,headers});}
 // --- AUTH ENTRY (login-only) -------------------------------------------
 // Handled BEFORE the /api/ tree and before ASSETS so an unauthenticated
 // visitor is sent into the Cloudflare Access login flow instead of a static
 // 404. LOGIN IS NOT PRIVILEGE: a successful login grants a verified principal
 // only — never the owner GPU/planner allowance (which is a separate cookie).
 // These routes are GET navigations; both answers are private,no-store.
 //
 // NOTE (deployment, not code): wrangler must route /auth/* to the Worker ahead
 // of static assets (`run_worker_first`). That config change is OUT OF SCOPE in
 // this phase; it is required before these routes take effect in production.
 if(path==='/auth/login'){
  if(request.method!=='GET')return new Response('Method not allowed',{status:405,headers:{'Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff'}});
  // Fixed, same-origin redirect target. The redirect is ALWAYS /studio — a
  // client-supplied `?next=`/`return=` is deliberately ignored so this can
  // never be an open redirect. Same-origin absolute URL only.
  const dest=url.origin+'/studio';
  return new Response(null,{status:302,headers:{'Location':dest,'Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff'}});
 }
 if(path==='/auth/logout'){
  // Logout MUST be a same-origin POST: a GET (which a cross-site subresource or
  // an <img>/top-level nav can trigger) must NOT clear sessions. This also gives
  // us a CSRF check without trusting a client-supplied redirect.
  if(request.method!=='POST')return new Response('Method not allowed',{status:405,headers:{'Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff'}});
  if(request.headers.get('origin')!==url.origin)return jsonNoStore({error:'Cross-origin request refused.'},403);
  // 1) Clear every provider/owner session cookie WE set. HttpOnly;Secure;
  //    SameSite=Strict; Path=/; a bounded Max-Age=0 expires each immediately.
  const clear=Object.values(COOKIES).map(c=>`${c}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
  const headers=new Headers({'Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff'});
  for(const c of clear)headers.append('Set-Cookie',c);
  // 2) END the Cloudflare Access identity too, not just our own cookies. The
  //    documented endpoint is the SAME-APPLICATION-DOMAIN
  //    `/cdn-cgi/access/logout` (Cloudflare One, Access session management): it
  //    deletes this application domain's Access app cookie immediately. The
  //    team-domain path only deletes the team-domain cookie and is NOT what ends
  //    the app session, so we use url.origin here when identity is configured.
  //    NO invented redirect_url/returnTo query parameter (no primary doc proves
  //    it) — the destination is the fixed same-origin /studio. A client-controlled
  //    `next`/`return` is never honoured (no open redirect). We do NOT set or
  //    clear the CF_Authorization cookie ourselves (never touch a cookie we did
  //    not set); the Access logout endpoint revokes it.
  const location = identityConfigured(env) ? (url.origin+'/cdn-cgi/access/logout') : (url.origin+'/studio');
  headers.set('Location',location);
  return new Response(null,{status:302,headers});
 }
 try{
 if(!['GET','POST','DELETE'].includes(request.method))return json({error:'Method not allowed'},405);
 // --- IDENTITY (frontend contract) --------------------------------------
 // Private,no-store, no-spend. Reports whether the identity layer is configured
 // and whether THIS request carries a VERIFIED principal. It never returns an
 // email, a raw JWT, a key, or a caller-supplied subject. Missing config stays
 // unauthenticated (fail closed); an absent/invalid token stays unauthenticated.
 // A GET has no Origin requirement (it is a read), so no CSRF branch is needed.
 if(path==='/api/identity'){
  if(request.method!=='GET')return json({error:'Method not allowed'},405);
  const view=await identityView(request,env);
  return new Response(JSON.stringify(view),{status:200,headers:{'Content-Type':'application/json','Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff'}});
 }
 // --- PER-PERSON PRIVATE LIBRARY ----------------------------------------
 // New private surface. FAIL CLOSED when the identity layer is unconfigured
 // (503), absent/invalid token (401). Public pages/presets/world are untouched:
 // this branch only claims /api/library*. Reads are authorised by the VERIFIED
 // principal namespace (p_<principal32>/); legacy shared-key objects are never
 // assigned to a customer and are denied to a scoped caller.
 if(path==='/api/library'||path.startsWith('/api/library/')){
  const method=request.method;
  // Only the KNOWN personal-library sub-routes exist. Anything else under
  // /api/library/ (e.g. a speculative /api/library/mirror) is an unknown path:
  // it is denied uniformly BEFORE auth, so it is not a routable surface and a
  // probe learns nothing from a status difference.
  const restForShape=path.slice('/api/library'.length);
  const knownShape=path==='/api/library'||restForShape.startsWith('/object/')||restForShape==='/upload';
  if(!knownShape)return libraryDenied();
  if(!['GET','HEAD','POST','DELETE'].includes(method))return methodNotAllowed();
  const auth=await requirePrincipal(request,env);
  if(!auth.ok)return auth.response;
  const segment=segmentFor(auth.principal);
  if(method==='POST'||method==='DELETE'){
   if(request.headers.get('origin')!==url.origin)return jsonNoStore({error:'Cross-origin write refused.'},403);
  }
  try{
   if(path==='/api/library')return await handleList(env.MEDIA,segment,url,method);
   const rest=path.slice('/api/library/'.length);
   if(rest.startsWith('object/')){
    let key:string;
    try{key=decodeURIComponent(rest.slice('object/'.length));}catch{return libraryDenied();}
    if(method==='GET'||method==='HEAD')return await handleRead(env.MEDIA,key,segment,method);
    if(method==='DELETE')return await handleDelete(env.MEDIA,key,segment);
    return methodNotAllowed();
   }
   if(rest==='upload'){
    if(method!=='POST')return methodNotAllowed();
    return await handleUpload(env.MEDIA,segment,request);
   }
   return libraryDenied();
  }catch{return libraryDenied();}
 }
 // --- HOSTED STATUS: ownership gate BEFORE any upstream call -------------
 // A read-only ownership check. There is deliberately NO public ownership-register
 // route and NO public mirror-URL route (both answer 404 as unknown paths).
 if(path==='/api/hosted/status'){
  if(request.method!=='POST')return methodNotAllowed();
  const auth=await requirePrincipal(request,env);
  if(!auth.ok)return auth.response;
  if(request.headers.get('origin')!==url.origin)return jsonNoStore({error:'Cross-origin request refused.'},403);
  const segment=segmentFor(auth.principal);
  let body:any;try{body=await request.json();}catch{return jsonNoStore({error:'Invalid request.'},400);}
  const ids=Array.isArray(body?.requestIds)?body.requestIds.slice(0,16):null;
  if(!ids||ids.some((x:unknown)=>typeof x!=='string'))return jsonNoStore({error:'Invalid request IDs.'},400);
  const decisions=await partitionStatusIds(env.MEDIA,ids,segment);
  return jsonNoStore({results:decisions.map(d=>d.allowed?{requestId:d.requestId,state:(d.row?.state as string)??'submitted'}:{requestId:d.requestId,error:'Not found'})});
 }

 // --- PC BRIDGE (machine transport) -------------------------------------
 // These run BEFORE any cookie or Origin logic. A machine call has no cookie
 // and no Origin header; it authenticates with its own HMAC over the exact raw
 // body. The body is read exactly once here and never re-read.
 if(path.startsWith('/api/local/')){
  if(!env.LOCAL_BRIDGE_HMAC||!env.OWNER_ACCESS_KEY)return json({error:'The local renderer is not configured.'},503);
  const action=path.slice('/api/local/'.length);
  const isUpload=action==='upload';
  const limit=isUpload?Math.ceil(MAX_UPLOAD_BYTES*1.4):1048576;
  let raw:string;
  try{raw=await readLimitedText(request,limit);}catch(error){if(error instanceof BodyLimitError)return json({error:'Rendered file is too large.'},413);throw error;}
  if(!verifyRequest(env.LOCAL_BRIDGE_HMAC,request.headers,raw))return json({error:'Bridge authentication failed.'},401);
  let body:any;try{body=raw?JSON.parse(raw):{};}catch{return json({error:'Invalid request.'},400);}
  const owner=String(body.owner||'').slice(0,64);
  if(!/^[a-z0-9_-]{1,64}$/i.test(owner))return json({error:'Invalid renderer owner id.'},400);

  if(action==='heartbeat'){await recordHeartbeat(env.MEDIA,owner,{online:body.online!==false,comfy:String(body.comfy||'').slice(0,120),busy:!!body.busy,elapsedSeconds:Number(body.elapsedSeconds)||0});return json({ok:true,leaseMs:20*60*1000});}
  if(action==='status')return json(await readHeartbeat(env.MEDIA));
  if(action==='claim'){
   // DRAIN HOLD (optional, source-only): when LOCAL_CLAIM_HOLD is EXACTLY the
   // string 'true', the PC is told the queue is draining and NO job is handed
   // out, so a safe reload can happen once in-flight leases lapse. Default
   // (undefined) is unchanged. This is checked AFTER the HMAC gate above, so a
   // caller that cannot authenticate never reaches it.
   if(env.LOCAL_CLAIM_HOLD==='true')return json({job:null,draining:true});
   // A job already submitted to ComfyUI is returned with its prompt id so the
   // PC re-attaches rather than rendering it a second time.
   const job=await claimLocalJob(env.MEDIA,owner);
   if(!job)return json({job:null});
   return json({job,owner});
  }
  if(action==='renew'){
   if(!isJobId(body.id))return json({error:'Invalid job id.'},400);
   const job=await renewLocalJobLease(env.MEDIA,body.id,owner);
   if(!job)return json({error:'Job lease is not held by this renderer.'},409);
   return json({ok:true,leaseUntil:job.leaseUntil});
  }
  if(action==='progress'||action==='upload'||action==='complete'){
   // A lease token is mandatory on every mutating call, and the job must be
   // held by this renderer with a live lease. Without all three the caller
   // cannot mutate the job at all.
   if(!isJobId(body.id))return json({error:'Invalid job id.'},400);
   if(!body.leaseToken)return json({error:'Lease token required.'},400);
   const held=await env.MEDIA.get('local/job/'+body.id+'.json');
   if(!held)return json({error:'Unknown job.'},404);
   let heldJob:any;try{heldJob=JSON.parse(await held.text());}catch{return json({error:'Unreadable job.'},400);}
   if(heldJob.owner!==owner)return json({error:'Job lease is not held by this renderer.'},409);
   if(heldJob.leaseToken!==body.leaseToken)return json({error:'Lease token does not match this renderer.'},409);
   if(typeof heldJob.leaseUntil!=='number'||heldJob.leaseUntil<=Date.now())return json({error:'Job lease has expired.'},409);

   if(action==='progress'){
    // progress is only accepted when the PC actually observed a percentage.
    const hasProgress=typeof body.progress==='number'&&isFinite(body.progress);
    const running=await finishLocalJob(env.MEDIA,body.id,{
      state:'running',
      ...(hasProgress?{progress:Math.max(0,Math.min(1,body.progress))}:{}),
      ...(body.promptId?{promptId:String(body.promptId).slice(0,64)}:{}),
    },owner);
    if(!running)return json({error:'Job lease changed while reporting progress.'},409);
    return json({ok:true,leaseUntil:running.leaseUntil});
   }

   if(action==='upload'){
    const name=String(body.name||'').split(/[\\/]/).pop()||'render.png';
    if(!/^[A-Za-z0-9._-]{1,80}$/.test(name))return json({error:'Invalid file name.'},400);
    const declared=String(body.type||'');
    const isVideo=/\.(mp4|webm)$/i.test(name);
    const isImage=/\.(png|jpe?g)$/i.test(name);
    if(!isVideo&&!isImage)return json({error:'Unsupported render type.'},400);
    const type=isVideo?(/\.webm$/i.test(name)?'video/webm':'video/mp4'):(/\.jpe?g$/i.test(name)?'image/jpeg':'image/png');
    if(declared&&declared!==type)return json({error:'Declared type does not match the file.'},400);
    const b64raw=String(body.bytes||'');
    if(!/^[A-Za-z0-9+/]*={0,2}$/.test(b64raw))return json({error:'Invalid upload payload.'},400);
    let bytes:Uint8Array;
    try{bytes=unb64(b64raw);}catch{return json({error:'Invalid upload payload.'},400);}
    if(!bytes.byteLength)return json({error:'Empty upload.'},400);
    if(bytes.byteLength>MAX_UPLOAD_BYTES)return json({error:'Rendered file is too large.'},413);
    // Content sniff: the declared extension must match the real magic bytes.
    if(!matchesMagic(bytes,isVideo))return json({error:'File content does not match its type.'},400);
    // (b) The output's authorization subject is the STORED job subject — set
    // from the verified session at enqueue — never the renderer lease and never
    // a client-supplied value. It is a verified per-person principal segment
    // (`p_<32hex>`) when identity is ON, or a legacy sha256 owner segment when
    // OFF — BOTH are accepted here. A subjectless legacy job is refused rather
    // than silently published under a guessable segment.
    const storedSubject=typeof heldJob.subject==='string'?heldJob.subject:'';
    if(!isSubjectSegment(storedSubject))return json({error:'This render has no authorization subject on record.'},409);
    const view=await uploadLocalMedia(env.MEDIA,body.id,{type,bytes:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer},url.origin,storedSubject);
    return json({key:view.key,media:view,receipt:{job:body.id,key:view.key,kind:view.kind,bytes:view.bytes,contentType:view.contentType}});
   }

   // action === 'complete'
   const state=String(body.state||'');
   if(state==='completed'){
    // The client sends owned-upload RECEIPTS, not media URLs. Each key must be
    // an object this site stored for THIS job. Nothing is re-uploaded.
    const receipts=Array.isArray(body.receipts)?body.receipts:[];
    if(!receipts.length)return json({error:'No usable media was returned.'},400);
    const media=[];
    for(const item of receipts){
     const found=await verifyJobUpload(env.MEDIA,body.id,(item as any)?.key);
     if(!found)continue;
     media.push({...found,url:url.origin+'/media/'+found.key});
    }
    if(!media.length)return json({error:'No usable media was returned.'},400);
    const done=await finishLocalJob(env.MEDIA,body.id,{state:'completed',media,...(body.promptId?{promptId:String(body.promptId).slice(0,64)}:{})},owner);
    if(!done)return json({error:'Job lease changed while completing.'},409);
    return json({ok:true,media});
   }
   if(state==='failed'){
    const done=await finishLocalJob(env.MEDIA,body.id,{state:'failed',error:String(body.error||'render failed').slice(0,300)},owner);
    if(!done)return json({error:'Job lease changed while failing.'},409);
    return json({ok:true});
   }
   const done=await finishLocalJob(env.MEDIA,body.id,{state:'requeue',error:String(body.error||'').slice(0,300)},owner);
   if(!done)return json({error:'Job lease changed while requeueing.'},409);
   return json({ok:true,requeued:true,maxAttempts:MAX_ATTEMPTS});
  }
  return json({error:'Not found'},404);
 }
 // --- BROWSER ROUTES -----------------------------------------------------
 // Same-origin CSRF defence applies to browser POSTs. A cross-origin browser
 // POST cannot spend the owner GPU or the planner allowance.
 if(request.method!=='GET'&&request.headers.get('origin')!==url.origin)return json({error:'Use the studio on this domain to submit requests.'},403);
 if(env.API_LIMITER&&!(await env.API_LIMITER.limit({key:request.headers.get('CF-Connecting-IP')||'unknown'})).success)return json({error:'Please wait a moment before trying again.'},429);
 const queryProvider=parseProvider(url.searchParams.get('provider'));
 const provider:Provider=path==='/api/generate'?'runpod':queryProvider;
 const apiKey=await keyFrom(request,env,provider);const COOKIE=COOKIES[provider];
 if(path==='/api/credentials'){
  if(request.method==='GET')return json({configured:!!apiKey,provider});
  if(request.method==='DELETE')return json({ok:true},200,{'Set-Cookie':COOKIE+'=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0'});
  if(Number(request.headers.get('content-length')||0)>4096)return json({error:'Key input is too large.'},413);
  const raw=await readLimitedText(request,4096);const input=JSON.parse(raw);
  let newKey:string;
  if(provider==='local'){
   // OWNER LOGIN. Accepts a generated private owner access key only. No
   // id:secret parsing, no upstream verification, no arbitrary BYO key.
   if(!env.OWNER_ACCESS_KEY)return json({error:'The local renderer is not configured.'},503);
   const candidate=String(input.ownerKey??input.apiKey??input.api_key??'').trim();
   if(!OWNER_RE.test(candidate))return json({error:'That is not a studio owner key.'},400);
   if(candidate!==env.OWNER_ACCESS_KEY)return json({error:'That owner key is not recognised.'},403);
   newKey=candidate;
  }else{
   newKey=provider==='runpod'?runpodKey(input.apiKey??input.api_key):parseCredentialInput(input).apiKey;
   if(newKey.length>2048||/[\r\n]/.test(newKey))throw new Error('Invalid key.');
   if(provider==='runpod')await createRunpodClient(newKey).verify();
   else{
    const verify=await fetch(env.HF_API_BASE_URL+'/requests/00000000-0000-4000-8000-000000000000/status',{headers:{Authorization:'Key '+newKey},signal:AbortSignal.timeout(15000)});
    if(verify.status===401||verify.status===403)return json({error:'The generation provider did not accept this key.'},400);
    if(verify.status!==404&&!verify.ok)return json({error:'The generation provider could not verify your key. Try again later.'},502);
   }
  }
  // Bind the sealed credential cookie to the VERIFIED Access principal so a
  // later session that presents a different principal (a shared browser that
  // switched Google accounts) is refused. When identity is unconfigured, no
  // binding is written and legacy behaviour is unchanged.
  const boundPrincipal=(provider==='local')?undefined:(env?await verifiedPrincipalSegment(request,env):undefined);
  const sealed=await seal(newKey,env.SESSION_SECRET,provider,boundPrincipal);
  /* The owner envelope and cookie share SESSION_MAX_AGE. Existing envelopes
     keep their original expiry until the next successful sign-in. Cookie flags
     and owner-key checks remain enforced; a longer lifetime also means a longer
     exposure window if a cookie is stolen. No credential rotation occurs here. */
  return json({ok:true},200,{'Set-Cookie':COOKIE+'='+sealed+'; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age='+SESSION_MAX_AGE});
 }
 if(path==='/api/local-state'){
  if(!env.LOCAL_BRIDGE_HMAC)return json({configured:false,connected:false,renderer:{online:false,ageMs:Infinity}},200);
  const connected=!!(await ownerKeyFrom(request,env));
  return json({configured:true,connected,renderer:await readHeartbeat(env.MEDIA)});
 }
 // A local render belongs to the studio owner, so the local owner session is a
 // valid status credential. Hosted-provider sessions are unchanged, and an
 // anonymous caller still gets 401.
 //
 // IDENTITY ON: a VERIFIED Access principal is ALSO a valid status credential,
 // because the per-person subject stored on a local job is that principal (not
 // a credential): an account with no provider key must still be able to poll its
 // OWN local render. The per-id authorization below still enforces that the
 // caller may only see jobs whose stored subject matches their principal.
 if(path==='/api/status'){
  const hasCredential=!!apiKey||!!await keyFrom(request,env,'higgsfield')||!!await keyFrom(request,env,'runpod')||!!await ownerKeyFrom(request,env);
  const hasPrincipal=identityConfigured(env)?!!await verifiedPrincipalSegment(request,env):false;
  if(!hasCredential&&!hasPrincipal)return json({error:'Connect a generation account to create.'},401);
 }
 if(path==='/api/upload'&&request.method==='POST'){
  /* v0.02: a LOCAL preset's start/reference frames must be uploadable by the
     owner without also configuring a hosted provider key. The renderer
     credential and the blob-store credential are different privileges, so a
     missing hosted key is only fatal when no credential of any kind is
     present. Previously ANY model sent its own provider, so selecting a local
     preset produced a silent 401 with no attach control able to explain it. */
  if(!apiKey&&!(await ownerKeyFrom(request,env)))return json({error:'Sign in as the studio owner to attach a file.'},401);
  /* v0.02 REAL FIX: a browser fetch() with a FormData body sends NO
     content-length header (the length is only known once the stream is
     encoded). The old check treated a MISSING header as zero and answered
     413 "Choose a file smaller than 20 MB" for EVERY upload, whatever its real
     size - which is why no file could ever be attached. A missing header now
     means "unknown", and the real limit is enforced on the bytes actually
     read, below. A declared length that IS present is still checked early. */
  const declared=Number(request.headers.get('content-length')||0);
  if(declared&&declared>21*1024*1024)return json({error:'Choose a file smaller than 20 MB.'},413);
  const form=await request.formData(),file=form.get('file');if(!(file instanceof File)||file.size>20*1024*1024)throw new Error('Choose a file smaller than 20 MB.');
  const exts:Record<string,string>={'image/jpeg':'jpg','image/png':'png','image/webp':'webp','video/mp4':'mp4','video/webm':'webm','audio/mpeg':'mp3','audio/wav':'wav','audio/ogg':'ogg'};
  const ext=exts[file.type];if(!ext)throw new Error('Use JPEG, PNG, WebP, MP4, WebM, MP3, WAV or OGG.');
  // The owner segment is the SAME subject the /media route authorizes against.
  // When identity is configured the AUTHORITATIVE customer subject is the
  // VERIFIED Access principal segment (`p_<32hex>`) — NEVER the credential
  // hash, so two people sharing one provider key still get separate namespaces.
  // When identity is unconfigured the legacy credential-hash segment is kept.
  const uploadSeg=identityConfigured(env)?await verifiedPrincipalSegment(request,env):undefined;
  if(identityConfigured(env)&&!uploadSeg)return json({error:'Sign in to upload to your account.'},401);
  /* v0.02: an owner-authorised upload has no hosted provider key, so the
     namespace seed falls back to the studio owner key rather than hashing a
     nullable credential. Two owners can never share a blob namespace because
     the owner key is a single studio secret, not a per-customer credential. */
  const namespaceSeed=apiKey??(await ownerKeyFrom(request,env))??'witchcraft-studio';
  const owner=uploadSeg??ownerSegmentOf(await sha256Hex(namespaceSeed));
  const key=owner+'/'+crypto.randomUUID()+'.'+ext;await env.MEDIA.put(key,file.stream(),{httpMetadata:{contentType:file.type},customMetadata:{createdAt:new Date().toISOString(),owner}});
  return json({url:url.origin+'/media/'+key});
 }
 if(request.method!=='POST')return json({error:'Method not allowed'},405);
 const raw=await readLimitedText(request,131072);const value=JSON.parse(raw);
 if(path==='/api/plan'){
  // The planner spends the owner's own route allowance, so it requires the
  // local owner session. An anonymous caller cannot spend it.
  const owner=await ownerKeyFrom(request,env);
  if(!owner)return json({error:'Connect the studio owner to use prompt planning.'},401);
  // Legacy-cookie bypass gate: when identity is configured, an unbound or
  // mismatched owner cookie cannot reach the planner allowance.
  if(identityConfigured(env)){
   const rawLocal=rawCookieFor(request,'local');
   if(!await sealedCookieAllowed(request,env,'local',rawLocal))return json({error:'This owner session is not bound to your account.'},403);
   if(!await boundSegment(request,env))return json({error:'Sign in to use prompt planning.'},401);
  }
  const plan=validatePlanRequest(value);
  const outcome=await planWithAgent(plan,env.PLANNER_GO_API_KEY??'');
  if(!outcome.ok)return json({ok:false,route:outcome.route,reason:outcome.reason},200);
  return json({ok:true,route:outcome.route,plan:outcome.plan,held:HELD_ROUTES,note:'Planning improves your prompt and shot list. Rendering happens on the studio GPU.'});
 }
 if(path==='/api/enhance'){
  // The enhancer shares the planner's owner-scoped allowance and CSRF/rate
  // limits already applied above. An anonymous caller cannot spend it.
  const owner=await ownerKeyFrom(request,env);
  if(!owner)return json({error:'Connect the studio owner to enhance prompts.'},401);
  // Legacy-cookie bypass gate (same rule as /api/plan).
  if(identityConfigured(env)){
   const rawLocal=rawCookieFor(request,'local');
   if(!await sealedCookieAllowed(request,env,'local',rawLocal))return json({error:'This owner session is not bound to your account.'},403);
   if(!await boundSegment(request,env))return json({error:'Sign in to enhance prompts.'},401);
  }
  let body:{prompt:string;surface:'image'|'video';model?:string;mode:'standard'|'extra';preset?:string;duration?:number;constraints?:string};
  try{body=validateEnhanceRequest(value);}catch(error){return json({ok:false,reason:error instanceof Error?error.message:'Invalid enhancement request.'},400);}
  const outcome=await enhanceWithAgent(body,env.PLANNER_GO_API_KEY??'');
  if(!outcome.ok)return json({ok:false,reason:outcome.reason},200);
  return json({ok:true,prompt:outcome.prompt,originalPrompt:outcome.originalPrompt,changes:outcome.changes,source:outcome.source});
 }
 if(path==='/api/generate'){
  // Authentication first, and deliberately independent of the payload: an
  // unauthenticated caller must not learn whether its model or body is valid,
  // and must not be able to make this handler do work before it is refused.
  const sessions=await Promise.all([
   keyFrom(request,env,'higgsfield'),
   keyFrom(request,env,'runpod'),
   ownerKeyFrom(request,env),
  ]);
  if(!sessions.some(Boolean))return json({error:'Connect a generation account to create.'},401);
  const selected=getModel(String(value?.model??'')).provider??'higgsfield';
  if(selected==='local'){
   // Owner-only submit. A local render spends the owner's own GPU, so an
   // anonymous or arbitrary-key caller is refused.
   const owner=await ownerKeyFrom(request,env);
   if(!owner)return json({error:'Connect the studio owner to use the local renderer.'},401);
   if(!env.LOCAL_BRIDGE_HMAC)return json({error:'The local studio renderer is not configured.'},503);
   // (b) stamp the VERIFIED owner subject before enqueue, and (c) refuse a
   // reference to a same-origin object owned by a different subject.
   // When identity is configured, the VERIFIED Access principal is the account
   // binding for this request; a legacy unbound cookie cannot stand in for it.
   const localBound=await boundSegment(request,env);
   if(identityConfigured(env)){
    const rawLocal=rawCookieFor(request,'local');
    if(rawLocal&&!(await sealedCookieAllowed(request,env,'local',rawLocal)))return json({error:'This owner session is not bound to your account.'},403);
    if(!localBound)return json({error:'Sign in to use the local renderer.'},401);
   }
   const subject=localBound&&/^p_[0-9a-f]{32}$/.test(localBound)?localBound:ownerSegmentOf(await sha256Hex(owner));
   const draft=toLocalJob(value,url.origin,subject);
   for(const refKey of referenceKeysOf(draft)){
    const refObj=await env.MEDIA.get(refKey);
    const refOwner=String(refObj?.customMetadata?.owner??refKey.split('/')[0]??'');
    if(!refObj||refOwner!==subject)return json({error:'Reference media must be your own upload in this studio.'},403);
   }
   const job=await enqueueLocalJob(env.MEDIA,draft);
   return json({requestId:LOCAL_PREFIX+job.id,status:'queued'});
  }
  const key=await keyFrom(request,env,selected);
  if(!key)return json({error:`Connect your ${selected} account to use this model.`},401);
  const plane=validatePlane(value);
  // (c) A hosted render may reference same-origin media; refuse a reference to
  // an object owned by a DIFFERENT verified subject before the provider is
  // asked to fetch it. Same-origin is not ownership.
  const subjects=await mediaSubjects(request,env);
  if(!await referencesAreOwned(value,url.origin,subjects,env))return json({error:'Reference media must be your own upload in this studio.'},403);
  // (c-2) A hosted provider fetches a reference URL itself and sends no cookie,
  // so an owned same-origin reference is rewritten to carry a short-lived,
  // method+key-bound HMAC assertion minted ONLY here from the bridge secret.
  // With no bridge secret, an owned same-origin reference is marked unsupported
  // rather than forwarded as a bare private URL.
  const signed=signHostedReferences(value,url.origin,env.LOCAL_BRIDGE_HMAC||'');
  if(!signed.ok)return json({error:'This studio cannot yet pass private references to that provider.'},501);
  const plane2=validatePlane(signed.value);
  // Resolve the caller's VERIFIED principal ONCE, up front, so ownership
  // registration covers EVERY hosted provider (higgsfield AND runpod) — never
  // only the higgsfield branch.
  const submitPrincipal = identityConfigured(env) ? await verifiedPrincipalSegment(request, env) : undefined;
  if(selected==='runpod'){
   const mapped=toRunpod(plane2);
   const rpResult:any=await createRunpodClient(key).submit(mapped.endpoint,mapped.input);
   // Register ownership from the REAL provider request id the submit returned.
   // A registration failure after an ACTUAL submit is an explicit recoverable
   // failure receipt — never a claim of a tracked successful job.
   if(submitPrincipal){
    const rpId=String(rpResult?.id??rpResult?.requestId??rpResult?.request_id??'');
    const reg=await registerOwned(env,rpId,submitPrincipal,selected);
    if(!reg.ok)return json({error:'Ownership could not be recorded for this request.',code:'ownership_registration_failed',requestId:rpId,provider:selected,recoverable:true},502);
   }
   return json(rpResult);
  }
  const mapped=toPlatform(plane2);const result:any=await createPlatformClient({apiKey:key,baseUrl:env.HF_API_BASE_URL}).submit(mapped.path,mapped.body);
  // (d) Stamp OWNERSHIP from the VERIFIED Access principal, using ONLY the real
  // provider request id the upstream submit just returned. This is trusted
  // server code: there is no public register route, so a caller can never assert
  // an ownership id for a request it did not submit.
  if(submitPrincipal){
   const submitId=String(result?.requestId??result?.request_id??'');
   const reg=await registerOwned(env,submitId,submitPrincipal,selected);
   // A real submit happened but ownership could not be recorded: return an
   // explicit recoverable failure receipt (with the provider request id) so the
   // render is not falsely reported as trackable, and the operator can recover.
   if(!reg.ok)return json({error:'Ownership could not be recorded for this request.',code:'ownership_registration_failed',requestId:submitId,provider:selected,recoverable:true},502);
  }
  return json(result);
 }
 if(path==='/api/status'){
  const ids=value.requestIds;
  if(!Array.isArray(ids)||ids.length<1||ids.length>16||ids.some(x=>typeof x!=='string'||(!x.startsWith('rp:')&&!x.startsWith(LOCAL_PREFIX)&&!/^[a-z0-9-]{1,100}$/i.test(x))))throw new Error('Invalid request IDs.');
  for(const id of ids)if(id.startsWith('rp:'))parseRunpodId(id);
  // (d-2) OWNERSHIP GATE BEFORE ANY UPSTREAM CALL: when the caller carries a
  // VERIFIED Access principal, EVERY hosted id — including RunPod `rp:` ids — is
  // checked against the registry; a foreign/unknown id is refused before the
  // provider is asked. There is no unowned status/query path. Local `lc:` ids
  // keep their existing owner-scoped handling.
  let hostedRefused:Record<string,string>={};
  const statusSegment=identityConfigured(env)?await verifiedPrincipalSegment(request,env):undefined;
  if(identityConfigured(env)){
   const hosted=ids.filter((id:string)=>!id.startsWith(LOCAL_PREFIX));
   if(hosted.length&&statusSegment){
    const decisions=await partitionStatusIds(env.MEDIA,hosted,statusSegment);
    for(const d of decisions)if(!d.allowed)hostedRefused[d.requestId]='Not found';
   }else if(hosted.length){
    // Identity is configured but no VERIFIED principal: every hosted id is
    // refused before any upstream call (no anonymous status oracle).
    for(const id of hosted)hostedRefused[id]='Not found';
   }
  }
  // A local job is owner-scoped: its receipts must not be readable by a
  // non-owner session. The owner subject is resolved once, up front. When
  // identity is configured the AUTHORITATIVE subject is the VERIFIED Access
  // principal segment (`p_<32hex>`) — the same one stamped at enqueue — never a
  // credential hash. When OFF the legacy owner-key hash is kept.
  const localOwner = ids.some(id=>id.startsWith(LOCAL_PREFIX))
    ? (identityConfigured(env)
        ? (await verifiedPrincipalSegment(request,env)) ?? '\u0000missing'
        : ownerSegmentOf(await sha256Hex((await ownerKeyFrom(request,env))||'\u0000missing')))
    : '';
  // SEQUENTIAL status execution (never Promise.all): each hosted id may run the
  // frozen mirror helper, which buffers ~2x the object size; running up to 16
  // ids concurrently would multiply resident buffers inside a 128 MiB isolate.
  // An individual helper call being serial does NOT make the batch serial — the
  // batch itself must be awaited one id at a time. Peak concurrent upstream
  // fetches is therefore bounded at 1.
  const results:Array<{requestId:string;status?:unknown;error?:string}>=[];
  for(const requestId of ids){
   // A hosted id refused by the ownership gate is answered uniformly WITHOUT any
   // upstream call, so a foreign caller cannot make the provider disclose it.
   if(hostedRefused[requestId]){results.push({requestId,error:'Not found'});continue;}
   try{
    const selected:Provider=requestId.startsWith('rp:')?'runpod':requestId.startsWith(LOCAL_PREFIX)?'local':'higgsfield';
    // LOCAL READ (ownership, not spend): a verified principal that OWNS the job
    // may read its own status WITHOUT the owner/spend cookie — reading is not
    // spending. When identity is OFF the legacy owner-session rule is unchanged.
    // The subject match inside localStatusFor is the real authorization.
    if(selected==='local'&&identityConfigured(env)&&localOwner&&localOwner!=='\u0000missing'){
     const status=await localStatusFor(env.MEDIA,requestId,localOwner);
     results.push({requestId,status});
     continue;
    }
    if(selected==='local'&&!(await ownerKeyFrom(request,env)))throw new Error('Connect the studio owner to check this job.');
    const key=await keyFrom(request,env,selected);
    if(!key)throw new Error(`Reconnect your ${selected==='local'?'studio owner':selected+' account'} to check this job.`);
    if(selected==='local'){
     const status=await localStatusFor(env.MEDIA,requestId,localOwner);
     results.push({requestId,status});
     continue;
    }
    const raw=await (selected==='runpod'?createRunpodClient(key):createPlatformClient({apiKey:key,baseUrl:env.HF_API_BASE_URL})).status(requestId) as any;
    // OWNED-MEDIA FINALIZER (frozen helper), SEQUENTIAL per id. When identity is
    // ON the response is ALWAYS sanitized: a raw provider capability URL must
    // NEVER reach a client on ANY failure path (no outputs, record failure,
    // helper exception, invalid principal, missing allowlist).
    if(identityConfigured(env)){
     if(!statusSegment||!isPrincipalSegment(statusSegment)){
      // Identity on but no verified principal: refuse BEFORE displaying media.
      results.push({requestId,status:sanitizeFallback(raw,'unsupported')});
      continue;
     }
     try{
      const outs:Array<{url:string;contentType?:string}>=[];
      if(Array.isArray(raw?.images))for(const im of raw.images)if(im&&typeof im.url==='string')outs.push({url:im.url,contentType:typeof im.contentType==='string'?im.contentType:undefined});
      if(raw?.video&&typeof raw.video.url==='string')outs.push({url:raw.video.url,contentType:typeof raw.video.contentType==='string'?raw.video.contentType:undefined});
      if(!outs.length){
       // No media slots recorded: nothing to leak, but still sanitized shape.
       results.push({requestId,status:sanitizeFallback(raw,'unavailable')});
       continue;
      }
      const rec=await recordOwnerOutputs(env,statusSegment,requestId,outs);
      if(!rec.ok){
       // Registration failed: NEVER fall through to raw. Explicit unavailable.
       results.push({requestId,status:sanitizeFallback(raw,'unavailable')});
       continue;
      }
      const safe=await privatizeHostedStatus(env,statusSegment,requestId,raw,{fetchImpl:env.MEDIA?.fetchImpl});
      results.push({requestId,status:safe});
     }catch{
      // Any helper throw: explicit unavailable, never raw.
      results.push({requestId,status:sanitizeFallback(raw,'unavailable')});
     }
     continue;
    }
    results.push({requestId,status:raw});
   }catch(error){results.push({requestId,error:safeErrorText(error)});}
  }
  return json(results);
 }
 return json({error:'Not found'},404);
 }catch(error){if(error instanceof BodyLimitError)return json({error:error.message},413);if(error instanceof PlatformError)return json({error:error.message},error.status>=500?502:400);return json({error:error instanceof Error?error.message:'The request could not be completed.'},400);}
}};

/** A sanitized status object for an identity-ON path that could not produce
    private media handles. It carries ONLY the immutable non-URL envelope plus an
    explicit outputState. It NEVER includes `images`/`video` with a provider URL,
    and it strips any provider URL that may sit in an error string. */
function sanitizeFallback(
  raw:{status?:unknown;requestId?:unknown;error?:unknown;images?:unknown;video?:unknown}|undefined,
  outputState:'unsupported'|'unavailable',
):{status:unknown;requestId:unknown;outputState:string;error?:string}{
  const status = raw && typeof raw==='object' && 'status' in raw ? (raw as {status:unknown}).status : undefined;
  const requestId = raw && typeof raw==='object' && 'requestId' in raw ? (raw as {requestId:unknown}).requestId : undefined;
  const out:{status:unknown;requestId:unknown;outputState:string;error?:string}={status,requestId,outputState};
  const err = raw && typeof raw==='object' ? (raw as {error?:unknown}).error : undefined;
  if(typeof err==='string'&&err){const clean=redactUrls(err);if(clean)out.error=clean;}
  return out;
}
/** Strip any URL-looking token from a string so an error can never carry a
    provider capability URL out to a client. */
function redactUrls(text:string):string{
  return text.replace(/https?:\/\/[^\s"'<>]+/gi,'[redacted]').slice(0,300);
}
/** Safe error text for a status failure: a short message with URLs redacted. */
function safeErrorText(error:unknown):string{
  const raw=error instanceof Error?error.message:'This request status could not be retrieved.';
  return redactUrls(raw);
}
/** Magic-byte check so an .mp4 name cannot carry arbitrary bytes. */
function matchesMagic(bytes:Uint8Array,isVideo:boolean):boolean{
 const hex=(n:number)=>bytes[n]??0;
 if(isVideo){
  // ISO BMFF: ....ftyp
  if(bytes.length<12||String.fromCharCode(hex(4),hex(5),hex(6),hex(7))!=='ftyp')return false;
  if(hex(8)===0x6d&&hex(9)===0x70&&hex(10)===0x34&&hex(11)===0x32)return true;// mp42
  if(hex(8)===0x69&&hex(9)===0x73&&hex(10)===0x6f&&hex(11)===0x6d)return true;// isom
  if(hex(8)===0x77&&hex(9)===0x65&&hex(10)===0x62&&hex(11)===0x6d)return true;// webm
  return String.fromCharCode(hex(0),hex(1),hex(2),hex(3))==='\x1a\x45\xdf\xa3';// EBML fallback
 }
 if(bytes.length>=8&&hex(0)===0x89&&hex(1)===0x50&&hex(2)===0x4e&&hex(3)===0x47&&hex(4)===0x0d&&hex(5)===0x0a&&hex(6)===0x1a&&hex(7)===0x0a)return true;
 if(bytes.length>=3&&hex(0)===0xff&&hex(1)===0xd8&&hex(2)===0xff)return true;
 return false;
}
export {attachPromptId};
