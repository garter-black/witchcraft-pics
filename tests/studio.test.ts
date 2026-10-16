import {test} from 'node:test';import assert from 'node:assert/strict';
import {MODELS,parseSettings} from '../src/generation/catalog';
import {toPlatform} from '../src/generation/to-platform';
import {validatePlane,publicReference} from '../worker/validation';
import {seal,unseal} from '../worker/index';
import worker from '../worker/index';
import {STATIONS} from '../src/witchcraft/districts';
import {PRESET_IDS} from '../worker/local-poll';
import * as T from 'three';
import {disposeObject} from '../src/witchcraft/dispose-world';
import {BodyLimitError,readLimitedText} from '../worker/body';
test('every non-RunPod model has one distinct spatial station and a mapped route',()=>{const mapped=MODELS.filter(m=>m.provider!=='runpod');assert.ok(mapped.length>=38,'the original 38 models are still present');assert.equal(STATIONS.length,MODELS.length);assert.equal(new Set(STATIONS.map(s=>s.model.id)).size,MODELS.length);for(const m of mapped){const p={model:m.id,prompt:{text:'test'},media:{},settings:parseSettings(m,{})};// A hosted model must map to a platform route. A local studio model must instead
// resolve to a reviewed local preset: it has no platform path by design, so
// asserting a platform route for it would assert something false.
if(m.provider==='local')assert.ok(PRESET_IDS[m.id],m.id+' must resolve to a reviewed local preset');
else assert.match(toPlatform(p).path,/^[a-z0-9][a-z0-9./-]*$/i);}});
test('Anima display name keeps original provider route',()=>{const m=MODELS.find(m=>m.id==='soul-2')!;assert.equal(m.label,'Witchcraft Anima');assert.equal(toPlatform({model:m.id,prompt:{text:'test'},media:{},settings:parseSettings(m,{})}).path,'higgsfield-ai/soul/v2/standard');});
test('reject unsupported roles and non-public reference URLs',()=>{assert.throws(()=>validatePlane({model:'soul-2',prompt:{text:'x'},media:{video:[{url:'https://example.com/a.mp4'}]}}));assert.throws(()=>validatePlane({model:'seedance-2.5',prompt:{text:'x'},media:{reference:[{url:'http://127.0.0.1/private'}]}}));assert.throws(()=>validatePlane({model:'../bad',prompt:{text:'x'}}));});
test('session encryption hides key and rejects altered data and wrong secret',async()=>{const secret='test-secret-that-is-longer-than-32-characters',value=await seal('test-id:test-secret',secret);assert.ok(!value.includes('test-id'));assert.equal(await unseal(value,secret),'test-id:test-secret');assert.equal(await unseal(value+'bad',secret),null);assert.equal(await unseal(value,'different-secret-that-is-longer-than-32-chars'),null);});
test('a local owner session is opaque and never id:secret-parsed',async()=>{const secret='test-secret-that-is-longer-than-32-characters';const owner='owner-key-abcdefghijklmnop';const value=await seal(owner,secret,'local');assert.ok(!value.includes(owner));// It survives the round trip, which it would not if it went through the
// Higgsfield id:secret parser, and it cannot be confused with a provider key.
assert.equal(await unseal(value,secret,'local'),owner);assert.equal(await unseal(value,secret,'higgsfield'),null);});
test('cross-origin generation denied before provider calls',async()=>{const r=await worker.fetch(new Request('https://witchcraft.pics/api/generate',{method:'POST',headers:{origin:'https://other.invalid'},body:'{}'}),{} as any);assert.equal(r.status,403);});
test('anonymous generation requires own key',async()=>{const r=await worker.fetch(new Request('https://witchcraft.pics/api/generate',{method:'POST',headers:{origin:'https://witchcraft.pics'},body:'{}'}),{} as any);assert.equal(r.status,401);});
test('a wrong local owner key cannot reach the local renderer',async()=>{const env={SESSION_SECRET:'test-secret-that-is-longer-than-32-characters',HF_API_BASE_URL:'https://api.higgsfield.ai',OWNER_ACCESS_KEY:'owner-key-abcdefghijklmnop',LOCAL_BRIDGE_HMAC:'h'.repeat(40),MEDIA:{get:async()=>null,put:async()=>({key:'x'}),list:async()=>({objects:[]}),delete:async()=>{}}} as any;const bad=await worker.fetch(new Request('https://witchcraft.pics/api/credentials?provider=local',{method:'POST',headers:{origin:'https://witchcraft.pics','content-type':'application/json'},body:JSON.stringify({ownerKey:'owner-key-wrongwrongwrongwrong'})}),env);assert.ok([400,403].includes(bad.status),'a wrong owner key must be refused, got '+bad.status);const good=await worker.fetch(new Request('https://witchcraft.pics/api/credentials?provider=local',{method:'POST',headers:{origin:'https://witchcraft.pics','content-type':'application/json'},body:JSON.stringify({ownerKey:'owner-key-abcdefghijklmnop'})}),env);assert.equal(good.status,200);const cookie=(good.headers.get('set-cookie')??'').split(';')[0];const submit=await worker.fetch(new Request('https://witchcraft.pics/api/generate',{method:'POST',headers:{origin:'https://witchcraft.pics','content-type':'application/json',cookie},body:JSON.stringify({model:'local-realvis-sdxl',prompt:{text:'a lighthouse'},media:{},settings:{}})}),env);assert.equal(submit.status,200);const anon=await worker.fetch(new Request('https://witchcraft.pics/api/generate',{method:'POST',headers:{origin:'https://witchcraft.pics','content-type':'application/json'},body:JSON.stringify({model:'local-realvis-sdxl',prompt:{text:'a lighthouse'},media:{},settings:{}})}),env);assert.equal(anon.status,401,'the local renderer must not accept an anonymous submit');});
test('reference URLs reject encoded IPs and reserved networks',()=>{for(const url of ['https://2130706433/a','https://0x7f000001/a','https://172.16.0.1/a','https://100.64.0.1/a','https://localhost.local/a','https://[::1]/a','https://user:pass@example.com/a'])assert.throws(()=>publicReference(url),url);assert.equal(publicReference('https://example.com/a.png'),'https://example.com/a.png');});
test('world disposal frees shared texture bitmap and geometry exactly once',()=>{let closed=0,textures=0,geometries=0;const texture=new T.Texture({close(){closed++;}} as any);texture.addEventListener('dispose',()=>textures++);const geometry=new T.BoxGeometry();geometry.addEventListener('dispose',()=>geometries++);const material=new T.MeshBasicMaterial({map:texture});const root=new T.Group();root.add(new T.Mesh(geometry,material),new T.Mesh(geometry,material));disposeObject(root);assert.deepEqual({closed,textures,geometries},{closed:1,textures:1,geometries:1});});
test('streaming body limits count bytes and cancel oversized unknown-length input',async()=>{let cancelled=false;const stream=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(4097));},cancel(){cancelled=true;}});const request=new Request('https://witchcraft.pics/api/credentials',{method:'POST',body:stream,duplex:'half'} as any);await assert.rejects(readLimitedText(request,4096),BodyLimitError);assert.equal(cancelled,true);assert.equal(await readLimitedText(new Request('https://example.com',{method:'POST',body:'é'}),2),'é');await assert.rejects(readLimitedText(new Request('https://example.com',{method:'POST',body:'é'}),1),BodyLimitError);});

/* v0.02 regression: the catalog's seed sentinel is -1 ("random"), but ComfyUI's
   KSampler seed minimum is 0. A graph that forwarded -1 was rejected by
   /prompt with "Value -1 smaller than min of 0" -> HTTP 400, and every default
   run of Krea 2 Turbo and FLUX Schnell failed three times before this guard. */
test('no local graph forwards the -1 random-seed sentinel to a sampler',async()=>{
 const {toComfyGraph}=await import('../src/generation/local-input');
 const {MODELS}=await import('../src/generation/catalog');
 const {parseSettings}=await import('../src/generation/catalog/parse-settings');
 for(const id of ['local-krea2-turbo','local-flux-schnell','local-realvis-sdxl','local-wan22-t2v','local-wan22-i2v','local-ltx23-t2v','local-h3-t2v','local-h3-i2v']){
  const model=(MODELS as readonly any[]).find(m=>m.id===id);
  if(!model)continue;
  const preset=(model.settings as any).preset.default;
  const settings=parseSettings(model,{});
  /* only hand a start frame to a preset that declares one: a T2V graph
     correctly REFUSES an unwanted reference rather than ignoring it. */
  const start=(model.roles as any)?.start?'https://witchcraft.pics/m/a.png':undefined;
  const graph:any=toComfyGraph({model:id,prompt:{text:'x'},media:{},settings} as any,preset,start);
  for(const [node,spec] of Object.entries<any>(graph)){
   if(!/KSampler|SamplerCustom|Noise/.test(String(spec?.class_type)))continue;
   for(const [field,value] of Object.entries<any>(spec.inputs??{})){
    if(/seed/i.test(field)&&typeof value==='number'){
     assert.ok(value>=0,`${id} node ${node} ${field} = ${value} is rejected by ComfyUI (min 0)`);
    }
   }
  }
 }
});

/* v0.02 regression: a browser fetch() with a FormData body sends NO
   content-length header. The upload gate read the missing header as 0 and
   answered 413 "Choose a file smaller than 20 MB" for EVERY file, so nothing
   could ever be attached - for visitors and for the owner alike. */
test('owner upload accepts a FormData body with no content-length header',async()=>{
 const secret='test-secret-that-is-longer-than-thirty-two-characters';
 const owner='testownerkey1234567890';
 const put:any[]=[];
 const env:any={SESSION_SECRET:secret,OWNER_ACCESS_KEY:owner,HF_API_BASE_URL:'https://api.higgsfield.ai',
  MEDIA:{put:async(k:string,b:any,m:any)=>{put.push({k,m});return{};}}};
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
 const form=new FormData();
 form.set('file',new File([png],'ref.png',{type:'image/png'}));
 const req=new Request('https://witchcraft.pics/api/upload?provider=higgsfield',{method:'POST',body:form,
  headers:{origin:'https://witchcraft.pics',cookie:'__Host-witchcraft-local='+await seal(owner,secret,'local',undefined)}});
 assert.equal(req.headers.get('content-length'),null,'precondition: browser omits content-length');
 const res:any=await worker.fetch(req as any,env,{waitUntil(){}} as any);
 assert.equal(res.status,200,'owner upload must succeed, got '+res.status+' '+await res.clone().text());
 assert.equal(put.length,1,'exactly one blob stored');
 assert.match(put[0].k,/\.png$/);
});
