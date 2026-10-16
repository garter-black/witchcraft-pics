import {MODELS} from '@/generation/catalog';
export const DISTRICTS=[
 {id:'anima',name:'Anima',subtitle:'THE IMAGE SANCTUM',description:'Give the impossible a face.',symbol:'◉',model:'rp-wan26-image',x:0,z:-28},
 {id:'nocturne',name:'Nocturne',subtitle:'THE CINEMA DISTRICT',description:'Dream in moving pictures.',symbol:'▷',model:'rp-wan26-video',x:40,z:-57},
 {id:'eidolon',name:'Eidolon',subtitle:'THE MOTION CHAMBER',description:'A gesture becomes a world.',symbol:'◇',model:'rp-kling26-motion',x:-40,z:-57},
 {id:'phantasm',name:'Phantasm',subtitle:'THE TRANSMUTATION LAB',description:'Rewrite what reality remembers.',symbol:'⌘',model:'rp-qwen-edit',x:58,z:-105},
 {id:'aevum',name:'Aevum',subtitle:'THE TIME OBSERVATORY',description:'Make the moment infinite.',symbol:'∞',model:'seedance-2.5-extend',x:-58,z:-105},
 {id:'grimoire',name:'Grimoire',subtitle:'THE LIVING ARCHIVE',description:'Every vision leaves a trace.',symbol:'▤',model:'soul-cinema',x:0,z:-133},
] as const;
export function districtFor(id:string){if(id.includes('extend'))return 4;if(id.includes('edit'))return 3;if(id.includes('motion')||id==='dop')return 2;return MODELS.find(m=>m.id===id)?.surface==='image'?0:1;}
export const STATIONS=MODELS.map((model,i)=>{const d=districtFor(model.id),peers=MODELS.filter(m=>districtFor(m.id)===d),j=peers.findIndex(m=>m.id===model.id),angle=(j/Math.max(peers.length,1))*Math.PI*2;return {model,index:i,district:d,x:DISTRICTS[d].x+Math.cos(angle)*13,z:DISTRICTS[d].z+Math.sin(angle)*13};});
