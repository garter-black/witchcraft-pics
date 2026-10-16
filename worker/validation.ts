import {getModel,parseSettings} from '../src/generation/catalog';
import type {GenerationPlane,MediaRole} from '../src/generation/catalog/types';
export function publicReference(value:string){
 const url=new URL(value),host=url.hostname.toLowerCase();
 const local=/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/.test(host)||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal');
 const octets=host.split('.').map(Number),ipv4=octets.length===4&&octets.every(n=>Number.isInteger(n)&&n>=0&&n<=255);
 const reserved=ipv4&&((octets[0]===172&&octets[1]>=16&&octets[1]<=31)||(octets[0]===100&&octets[1]>=64&&octets[1]<=127)||octets[0]>=224||octets[0]===0);
 if(url.protocol!=='https:'||url.username||url.password||local||reserved||!host.includes('.'))throw new Error('Use a public HTTPS reference.');
 return url.href;
}
export function validatePlane(value:any):GenerationPlane{
 if(!value||typeof value!=='object')throw new Error('Invalid generation request.');
 const model=getModel(value.model);
 if(typeof value.prompt?.text!=='string'||value.prompt.text.length>20000)throw new Error('Enter a prompt shorter than 20,000 characters.');
 if(!value.prompt.text.trim())throw new Error('Enter a prompt.');
 const media:GenerationPlane['media']={};
 for(const [role,items] of Object.entries(value.media||{})){
  const max=model.roles[role as MediaRole];if(!max||!Array.isArray(items)||items.length>max)throw new Error('These references are not supported by this model.');
  media[role as MediaRole]=items.map((item:any)=>({id:String(item.id||''),role:role as MediaRole,url:publicReference(item.url)}));
 }
 return {model:model.id,prompt:{text:value.prompt.text.trim()},media,settings:parseSettings(model,value.settings||{})};
}
