import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { getModel, parseSettings } from '../src/generation/catalog';
import { toComfyGraph, REFERENCE_FIELD, type LocalPreset } from '../src/generation/local-input';
const origin='http://127.0.0.1:8188';
const out='D:/AI/output/witchcraft-astra-repair';
await mkdir(out,{recursive:true});
const source=await readFile('D:/AI/output/krea-proof/krea2_turbo.png');
const form=new FormData();form.set('image',new File([source],'astra-clothed-adult-fixture.png',{type:'image/png'}));
const upload=await fetch(origin+'/upload/image',{method:'POST',body:form});
if(!upload.ok)throw Error('Reference upload rejected: '+upload.status);
const file:any=await upload.json();
const cases: [string,LocalPreset][]=[['local-reactor-faceswap','reactor-faceswap'],['local-character-ipadapter','character-ipadapter']];
const receipts:any[]=[];
for(const [id,preset] of cases){
 const model=getModel(id);const plane={model:id,prompt:{text:'A clothed adult portrait in natural window light, black cotton shirt, realistic photo'},media:{reference:[{id:'ref',url:'fixture'}]},settings:parseSettings(model,{seed:42})};
 const graph=toComfyGraph(plane,preset,'fixture');
 for(const spec of Object.values(graph))if(REFERENCE_FIELD in spec.inputs){delete spec.inputs[REFERENCE_FIELD];spec.inputs.image=file.subfolder?`${file.subfolder}/${file.name}`:file.name;}
 const r=await fetch(origin+'/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:graph})});const accepted:any=await r.json();
 if(!r.ok){receipts.push({id,accepted:false,error:accepted});console.log(JSON.stringify(receipts.at(-1)));continue;}
 const deadline=Date.now()+240000;let row:any;
 while(Date.now()<deadline){await new Promise(r=>setTimeout(r,1500));row=(await (await fetch(origin+'/history/'+accepted.prompt_id)).json())[accepted.prompt_id];if(row)break;}
 const receipt={id,prompt_id:accepted.prompt_id,status:row?.status,outputs:row?.outputs};receipts.push(receipt);console.log(JSON.stringify(receipt));
}
await writeFile(out+'/render-receipts.json',JSON.stringify(receipts,null,2));
if(receipts.some(r=>r.accepted===false||r.status?.status_str!=='success'))process.exitCode=1;
