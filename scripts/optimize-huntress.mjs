import fs from 'node:fs';import crypto from 'node:crypto';import sharp from 'sharp';
sharp.concurrency(1);
const source='C:/Hecate-Prime/artifacts/PANSOPHIA-CHARACTER-BATCH-20260921/huntress/animation-repaired.glb';
const bytes=fs.readFileSync(source),jsonLen=bytes.readUInt32LE(12),doc=JSON.parse(bytes.subarray(20,20+jsonLen).toString()),binStart=20+jsonLen+8,bin=bytes.subarray(binStart);let offset=0;const chunks=[],changes=[],imageViews=new Map(doc.images.map((img,i)=>[img.bufferView,i]));let unchangedViews=0;
const used=new Set();
function visit(value,fn){if(Array.isArray(value))value.forEach(v=>visit(v,fn));else if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){if(key==='bufferView')fn(value,key,item);else visit(item,fn);}}
visit(doc,(_,__,id)=>used.add(id));
const remap=new Map(),retained=[],removed=[];
for(let i=0;i<doc.bufferViews.length;i++){const view=doc.bufferViews[i],original=bin.subarray(view.byteOffset||0,(view.byteOffset||0)+view.byteLength);let data=original;
if(!used.has(i)){removed.push({bufferView:i,bytes:original.length,reason:'No JSON bufferView reference targets this data.'});continue;}
remap.set(i,retained.length);retained.push(view);
if(imageViews.has(i)){const img=doc.images[imageViews.get(i)],meta=await sharp(original).metadata();let pipeline=sharp(original).resize({width:1024,height:1024,fit:'inside',withoutEnlargement:true});data=meta.hasAlpha?await pipeline.png({compressionLevel:7}).toBuffer():await pipeline.jpeg({quality:88,mozjpeg:false}).toBuffer();img.mimeType=meta.hasAlpha?'image/png':'image/jpeg';changes.push({image:img.name||imageViews.get(i),original:original.length,optimized:data.length,width:meta.width,height:meta.height,mimeType:img.mimeType});}else{unchangedViews++;}
view.byteOffset=offset;view.byteLength=data.length;chunks.push(data);offset+=data.length;const pad=(4-offset%4)%4;if(pad){chunks.push(Buffer.alloc(pad));offset+=pad;}}
doc.bufferViews=retained;visit(doc,(parent,key,id)=>{if(!remap.has(id))throw new Error('Lost buffer reference '+id);parent[key]=remap.get(id);});
doc.buffers[0].byteLength=offset;const json=Buffer.from(JSON.stringify(doc)),jsonPad=Buffer.alloc((4-json.length%4)%4,32),body=Buffer.concat(chunks),header=Buffer.alloc(20),binHeader=Buffer.alloc(8);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(20+json.length+jsonPad.length+8+body.length,8);header.writeUInt32LE(json.length+jsonPad.length,12);header.writeUInt32LE(0x4e4f534a,16);binHeader.writeUInt32LE(body.length,0);binHeader.writeUInt32LE(0x004e4942,4);const output=Buffer.concat([header,json,jsonPad,binHeader,body]);fs.writeFileSync('public/huntress.glb',output);
const receipt={source,sourceSHA256:crypto.createHash('sha256').update(bytes).digest('hex'),inputBytes:bytes.length,outputBytes:output.length,unchangedNonImageBufferViews:unchangedViews,removed,bufferViewRemap:Object.fromEntries(remap),images:changes,outputSHA256:crypto.createHash('sha256').update(output).digest('hex')};fs.writeFileSync('C:/Hecate-Prime/artifacts/WITCHCRAFT-STUDIO-20260921/huntress-optimization.json',JSON.stringify(receipt,null,2));console.log(JSON.stringify({inputBytes:bytes.length,outputBytes:output.length,images:changes.length,unchangedNonImageBufferViews:unchangedViews,removed}));


