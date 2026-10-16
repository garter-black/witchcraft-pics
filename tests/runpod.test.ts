import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MODELS,parseSettings} from '../src/generation/catalog';
import {RUNPOD_MODELS} from '../src/generation/catalog/runpod';
import {toRunpod} from '../src/generation/runpod-input';
import {createRunpodClient,mapRunpodStatus,parseRunpodId,RUNPOD_POLICY} from '../worker/runpod';
import worker,{seal,unseal} from '../worker/index';
import {validatePlane} from '../worker/validation';

const key='rpa_abcdefghijklmnopqrstuvwxyz1234567890',secret='private-test-secret-longer-than-thirty-two-chars';
function plane(id:string,media:any={}){const m=MODELS.find(m=>m.id===id)!;return {model:id,prompt:{text:'Black glass city'},settings:parseSettings(m,{}),media};}
const image={id:'i',role:'start',url:'https://example.com/source.png'},video={id:'v',role:'video',url:'https://example.com/motion.mp4'};
test('six RunPod routes map documented inputs and enforce required media',()=>{
 assert.equal(RUNPOD_MODELS.length,6);
 assert.equal(toRunpod(plane('rp-wan26-image')).input.size,'1024*1024');
 const flux=toRunpod(plane('rp-flux-schnell'));assert.equal(flux.input.width,1024);assert.equal(flux.input.num_inference_steps,4);
 const wan=toRunpod(plane('rp-wan26-video'));assert.deepEqual([wan.endpoint,wan.input.duration,wan.input.size],['wan-2-6-t2v',5,'1280*720']);
 for(const id of ['rp-wan26-animate','rp-qwen-edit','rp-kling26-motion'])assert.throws(()=>toRunpod(plane(id)),/Add/);
 assert.equal(toRunpod(plane('rp-wan26-animate',{start:[image]})).input.image,image.url);
 assert.equal(toRunpod(plane('rp-qwen-edit',{reference:[image]})).input.image,image.url);
 assert.equal(toRunpod(plane('rp-kling26-motion',{start:[image],video:[video]})).input.video,video.url);
 assert.throws(()=>toRunpod(plane('soul-2')),/Higgsfield/);
});
test('RunPod jobs use fixed endpoint, bounded policy and no automatic submission retry',async()=>{
 const calls:any[]=[];const client=createRunpodClient(key,(async(url:any,init:any)=>{calls.push({url,init});return Response.json({id:'12345-u1',status:'IN_QUEUE'});}) as typeof fetch);
 const queued=await client.submit('wan-2-6-t2v',{prompt:'test'});assert.equal(queued.requestId,'rp:wan-2-6-t2v:12345-u1');
 assert.equal(calls[0].url,'https://api.runpod.ai/v2/wan-2-6-t2v/run');
 assert.equal(calls[0].init.headers.Authorization,'Bearer '+key);
 assert.deepEqual(JSON.parse(calls[0].init.body).policy,RUNPOD_POLICY);
 assert.equal(RUNPOD_POLICY.executionTimeout,600000);assert.equal(RUNPOD_POLICY.ttl,1200000);
 let count=0;const failure=createRunpodClient(key,(async()=>{count++;throw new Error('timeout');}) as typeof fetch);
 await assert.rejects(failure.submit('wan-2-6-t2v',{}),/may already be running/);assert.equal(count,1);
 await assert.rejects(client.submit('../malicious',{}),/Unsupported/);
});
test('real observed RunPod output.result and documented media fields both normalize',()=>{
 const realShape={id:'5b46555d-e2ba-49f5-abf7-0cb3f5192d9f-u1',status:'COMPLETED',output:{cost:0.5,result:'https://d2h7xmz5gqybh9.cloudfront.net/predictions/e1e347a96634416492e0fef83f00c61d/1.mp4'}};
 assert.equal(mapRunpodStatus('wan-2-6-t2v',realShape).video?.url,realShape.output.result);
 assert.equal(mapRunpodStatus('wan-2-6-t2i',{id:'image-u1',status:'COMPLETED',output:{image_url:'https://image.runpod.ai/result.png'}}).images?.[0].url,'https://image.runpod.ai/result.png');
 assert.equal(mapRunpodStatus('wan-2-6-t2v',{id:'job-u1',status:'TIMED_OUT'}).status,'failed');
 assert.equal(mapRunpodStatus('wan-2-6-t2v',{id:'job-u1',status:'CANCELLED'}).status,'canceled');
 assert.throws(()=>mapRunpodStatus('wan-2-6-t2v',{status:'IN_QUEUE'}),/job ID/);
 assert.throws(()=>mapRunpodStatus('wan-2-6-t2v',{id:'job-u1',status:'COMPLETED',output:{result:'http://127.0.0.1/a'}}),/HTTPS/);
 for(const id of ['rp:../pods:1','rp:wan-2-6-t2v:../x','rp:wan-2-6-t2v:1:extra'])assert.throws(()=>parseRunpodId(id));
});
test('encrypted provider sessions cannot be swapped across accounts',async()=>{
 const value=await seal(key,secret,'runpod');assert.equal(await unseal(value,secret,'runpod'),key);assert.equal(await unseal(value,secret,'higgsfield'),null);
 const hf=await seal('id:secret',secret);assert.equal(await unseal(hf,secret,'runpod'),null);
});
test('worker sends RunPod generation only to RunPod and returns provider-tagged IDs',async()=>{
 const saved=globalThis.fetch,calls:any[]=[];globalThis.fetch=(async(url:any,init:any)=>{calls.push({url,init});return Response.json({id:'worker-job-u1',status:'IN_QUEUE'});}) as typeof fetch;
 try{
  const cookie=await seal(key,secret,'runpod');
  const make=(body:any)=>new Request('https://witchcraft.pics/api/generate',{method:'POST',headers:{origin:'https://witchcraft.pics',cookie:'__Host-witchcraft-runpod='+cookie},body:JSON.stringify(body)});
  const response=await worker.fetch(make(plane('rp-wan26-video')),{SESSION_SECRET:secret} as any);assert.equal(response.status,200);assert.equal((await response.json() as any).requestId,'rp:wan-2-6-t2v:worker-job-u1');assert.equal(calls.length,1);
  const hf=await worker.fetch(make(plane('soul-2')),{SESSION_SECRET:secret} as any);assert.equal(hf.status,401);assert.equal(calls.length,1);
  assert.throws(()=>validatePlane({...plane('rp-qwen-edit'),media:{reference:[{...image,url:'https://127.0.0.1/source.png'}]}}));
 }finally{globalThis.fetch=saved;}
});
