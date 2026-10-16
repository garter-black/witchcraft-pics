import {RUNPOD_MODELS} from '../src/generation/catalog/runpod';
import type {GenerationStatus,QueuedGeneration} from '../src/generation/platform';
import {PlatformError} from '../src/generation/platform';
import {publicReference} from './validation';

const ENDPOINTS=new Map(RUNPOD_MODELS.map(m=>[m.endpoint!,m.surface]));
export const RUNPOD_POLICY={executionTimeout:600000,ttl:1200000} as const;
const BASE='https://api.runpod.ai/v2';
export function runpodKey(value:unknown):string{
 if(typeof value!=='string'||!/^rpa_[A-Za-z0-9_-]{20,200}$/.test(value.trim()))throw new Error('Enter your RunPod API key, beginning with rpa_.');
 return value.trim();
}
export function parseRunpodId(value:string){
 const [prefix,endpoint,id,...extra]=value.split(':');
 if(prefix!=='rp'||extra.length||!ENDPOINTS.has(endpoint)||!id||!/^[a-z0-9_-]{1,128}$/i.test(id))throw new Error('Invalid RunPod request ID.');
 return {endpoint,id};
}
function requestId(endpoint:string,id:unknown){
 if(typeof id!=='string'||!id)throw new Error('RunPod did not return a job ID. Check your RunPod job history before submitting again.');
 const value=`rp:${endpoint}:${id}`;parseRunpodId(value);return value;
}
function record(value:unknown):Record<string,any>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};}
export function mapRunpodStatus(endpoint:string,payload:unknown):GenerationStatus{
 if(!ENDPOINTS.has(endpoint))throw new Error('Unsupported RunPod endpoint.');
 const data=record(payload),out=record(Array.isArray(data.output)?data.output[0]:data.output);
 const id=requestId(endpoint,data.id);
 const states:Record<string,string>={IN_QUEUE:'queued',IN_PROGRESS:'in_progress',COMPLETED:'completed',FAILED:'failed',CANCELLED:'canceled',CANCELED:'canceled',TIMED_OUT:'failed'};
 const status=states[data.status]??'unknown';
 const result:GenerationStatus={requestId:id,status};
 if(status==='completed'){
  const video=ENDPOINTS.get(endpoint)==='video';
  const raw=(video?out.video_url:out.image_url)??out.result;
  if(typeof raw!=='string')throw new Error('RunPod completed this request without a usable media URL.');
  const url=publicReference(raw);if(video)result.video={url};else result.images=[{url}];
 }
 if(data.error||status==='failed')result.error=typeof data.error==='string'?data.error:'RunPod could not complete this request within its execution limit.';
 return result;
}
export function createRunpodClient(apiKey:string,fetchImpl:typeof fetch=fetch){
 const key=runpodKey(apiKey);
 const headers={Authorization:'Bearer '+key,'Content-Type':'application/json','User-Agent':'WitchcraftStudio/1.0'};
 async function send(endpoint:string,action:string,body?:unknown){
  if(!ENDPOINTS.has(endpoint))throw new Error('Unsupported RunPod endpoint.');
  let response:Response;
  try{response=await fetchImpl(`${BASE}/${endpoint}/${action}`,{method:body?'POST':'GET',headers,signal:AbortSignal.timeout(25000),...(body?{body:JSON.stringify(body)}:{})});}
  catch{throw new Error(body?'RunPod submission could not be confirmed. Check your RunPod job history before submitting again; this request may already be running.':'RunPod status is temporarily unavailable.');}
  const payload=await response.json().catch(()=>null);
  if(!response.ok){const data=record(payload);throw new PlatformError(response.status,{detail:typeof data.error==='string'?data.error:typeof data.message==='string'?data.message:`RunPod request failed (${response.status}).`});}
  return payload;
 }
 return {
  async verify(){
   const response=await fetchImpl(`${BASE}/wan-2-6-t2v/status/00000000-0000-4000-8000-000000000000-u1`,{headers,signal:AbortSignal.timeout(15000)});
   if(response.status===401||response.status===403)throw new Error('RunPod did not accept this key or its endpoint permissions.');
   if(response.status!==404&&!response.ok)throw new Error('RunPod could not verify this key. Try again later.');
  },
  async submit(endpoint:string,input:Record<string,unknown>):Promise<QueuedGeneration>{
   const data=record(await send(endpoint,'run',{input,policy:RUNPOD_POLICY}));
   if(data.status==='FAILED')throw new Error(typeof data.error==='string'?data.error:'RunPod rejected the request.');
   const id=requestId(endpoint,data.id);
   return {requestId:id,status:String(data.status??'IN_QUEUE').toLowerCase(),statusUrl:'',cancelUrl:''};
  },
  async status(value:string){const {endpoint,id}=parseRunpodId(value);return mapRunpodStatus(endpoint,await send(endpoint,`status/${id}`));},
 };
}
