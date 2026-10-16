import type {ModelEntry} from './types';

const one = {type:'enum',values:['1'],default:'1'} as const;
const seed = {type:'range',min:-1,max:2147483647,step:1,default:-1} as const;
const videoSettings = {
  resolution:{type:'enum',values:['720p','1080p'],default:'720p'},
  duration:{type:'range',min:5,max:15,step:5,default:5},
  shotType:{type:'enum',values:['single','multi'],default:'single'},
  enhancePrompt:{type:'boolean',default:false},seed,batchSize:one,
} as const;

/** Each entry is an actual documented RunPod endpoint, never an alias for a different model. */
export const RUNPOD_MODELS:readonly ModelEntry[] = [
 {id:'rp-wan26-image',label:'WAN 2.6 Image · RunPod',surface:'image',provider:'runpod',endpoint:'wan-2-6-t2i',roles:{},settings:{size:{type:'enum',values:['1024*1024','1024*768','1440*1024'],default:'1024*1024'},seed,batchSize:one}},
 {id:'rp-flux-schnell',label:'FLUX Schnell · RunPod',surface:'image',provider:'runpod',endpoint:'black-forest-labs-flux-1-schnell',roles:{},settings:{aspectRatio:{type:'enum',values:['1:1','4:3','3:4','16:9','9:16'],default:'1:1'},steps:{type:'range',min:1,max:8,step:1,default:4},seed,batchSize:one}},
 {id:'rp-wan26-video',label:'WAN 2.6 Cinema · RunPod',surface:'video',provider:'runpod',endpoint:'wan-2-6-t2v',roles:{audio:1},settings:{aspectRatio:{type:'enum',values:['16:9','9:16'],default:'16:9'},...videoSettings}},
 {id:'rp-wan26-animate',label:'WAN 2.6 Animate · RunPod',surface:'video',provider:'runpod',endpoint:'wan-2-6-i2v',roles:{start:1,audio:1},settings:videoSettings},
 {id:'rp-qwen-edit',label:'Qwen Image Edit · RunPod',surface:'image',provider:'runpod',endpoint:'qwen-image-edit',roles:{reference:1},settings:{outputFormat:{type:'enum',values:['png','jpeg'],default:'png'},seed,batchSize:one}},
 {id:'rp-kling26-motion',label:'Kling 2.6 Motion · RunPod',surface:'video',provider:'runpod',endpoint:'kling-v2-6-std-motion-control',roles:{start:1,video:1},settings:{characterOrientation:{type:'enum',values:['video','image'],default:'video'},keepOriginalSound:{type:'boolean',default:true},batchSize:one}},
];
