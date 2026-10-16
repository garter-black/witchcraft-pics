import {getModel} from './catalog';
import type {GenerationPlane,MediaRole} from './catalog/types';

export function toRunpod(plane:GenerationPlane){
 const model=getModel(plane.model);
 if(model.provider!=='runpod'||!model.endpoint)throw new Error('This model requires its Higgsfield connection. Choose a RunPod model to use RunPod.');
 const s=plane.settings;
 const media=(role:MediaRole,required=false)=>{const value=plane.media[role]?.[0]?.url;if(required&&!value)throw new Error(role==='video'?'Add a motion reference video.':'Add the required source image.');return value;};
 const input:Record<string,unknown>={prompt:plane.prompt.text};
 if(model.id==='rp-wan26-image')Object.assign(input,{size:s.size,seed:s.seed,enable_safety_checker:true});
 else if(model.id==='rp-flux-schnell'){
  const sizes:Record<string,[number,number]>={'1:1':[1024,1024],'4:3':[1024,768],'3:4':[768,1024],'16:9':[1024,576],'9:16':[576,1024]};
  const [width,height]=sizes[String(s.aspectRatio)];Object.assign(input,{width,height,num_inference_steps:s.steps,guidance:1,seed:s.seed,image_format:'png'});
 }else if(model.id==='rp-qwen-edit')Object.assign(input,{image:media('reference',true),output_format:s.outputFormat,seed:s.seed,enable_safety_checker:true});
 else if(model.id==='rp-kling26-motion')Object.assign(input,{image:media('start',true),video:media('video',true),character_orientation:s.characterOrientation,keep_original_sound:s.keepOriginalSound});
 else{
  const portrait=s.aspectRatio==='9:16',hd=s.resolution==='1080p';
  Object.assign(input,{duration:Number(s.duration),size:portrait?(hd?'1080*1920':'720*1280'):(hd?'1920*1080':'1280*720'),shot_type:s.shotType,seed:s.seed,enable_prompt_expansion:s.enhancePrompt});
  if(model.id==='rp-wan26-animate')input.image=media('start',true);
  if(media('audio'))input.audio=media('audio');
 }
 return {endpoint:model.endpoint,input};
}
