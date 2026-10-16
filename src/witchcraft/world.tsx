
import {useCallback,useEffect,useRef,useState} from 'react';
import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {Reflector} from 'three/addons/objects/Reflector.js';
import {OpenHiggsfieldApp} from '@/openhiggsfield/openhiggsfield-app';
import {useActive} from '@/generation/stores/active';
import {DISTRICTS,STATIONS} from './districts';
import {disposeObject} from './dispose-world';

type Driver={travel:(index:number)=>void;station:(id:string)=>void;pause:(p:boolean)=>void;home:()=>void;dispose:()=>void};
export function World({onStudio}:{onStudio:()=>void}){
const mount=useRef<HTMLDivElement>(null),driver=useRef<Driver|null>(null);
const [entered,setEntered]=useState(false),[district,setDistrict]=useState<number|null>(null),[bench,setBench]=useState(false),[benchCreated,setBenchCreated]=useState(false),[help,setHelp]=useState(false),[paused,setPaused]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState('AN OBSIDIAN CITY. THIRTY-EIGHT WAYS TO CREATE.');
const pendingDistrict=useRef<number|null>(null),stationTimer=useRef<number|undefined>(undefined);
const closeBench=useCallback(()=>setBench(false),[]);
const clearStation=()=>{window.clearTimeout(stationTimer.current);stationTimer.current=undefined;};
useEffect(()=>()=>window.clearTimeout(stationTimer.current),[]);
const selectModel=(id:string)=>{useActive.getState().setModel(id);setBenchCreated(true);setBench(true);};
const selectRef=useRef(selectModel);selectRef.current=selectModel;
useEffect(()=>{if(!entered||!mount.current)return;let disposed=false;try{driver.current=buildWorld(mount.current,{onDistrict:i=>setDistrict(i),onModel:id=>selectRef.current(id),onStatus:s=>{if(!disposed)setStatus(s);},onError:s=>{if(!disposed)setError(s);}});if(pendingDistrict.current!==null)driver.current.travel(pendingDistrict.current);}catch{setError('Your browser could not start the 3D renderer. You can use every tool in the studio.');}return()=>{disposed=true;driver.current?.dispose();driver.current=null;};},[entered]);
useEffect(()=>{driver.current?.pause(paused||bench);},[paused,bench]);
useEffect(()=>{if(!entered||paused||location.hostname!=='127.0.0.1'||!new URLSearchParams(location.search).has('inspect'))return;const timer=window.setTimeout(()=>setPaused(true),10000);return()=>window.clearTimeout(timer);},[entered,paused]);
useEffect(()=>{const onTravel=()=>{setBench(false);setStatus('CHOOSE A DISTRICT AND TRAVEL TO YOUR NEXT INSTRUMENT.');};window.addEventListener('witchcraft-travel',onTravel);return()=>window.removeEventListener('witchcraft-travel',onTravel);},[]);
const travel=(i:number)=>{clearStation();pendingDistrict.current=i;setPaused(false);setEntered(true);setBench(false);setDistrict(i);driver.current?.travel(i);};
return <section className="world" data-entered={entered} data-workshop={bench} aria-label="Witchcraft interactive 3D world"><div ref={mount} className="world-stage"/>
{!entered?<div className="world-intro"><span className="world-eyebrow">WITCHCRAFT / THE OTHER SIDE</span><h1>Enter the<br/><em>impossible.</em></h1><p>A city built from imagination.<br/>Every district is a different kind of magic.<br/>The Huntress is waiting.</p><div className="world-entry"><button onClick={()=>setEntered(true)}>CROSS THE THRESHOLD ↗</button><small>AN INTERACTIVE 3D EXPERIENCE</small></div></div>:district!==null&&!bench?<div className="world-arrival"><span className="world-eyebrow">DISTRICT 0{district+1} / {DISTRICTS[district].subtitle}</span><h2>{DISTRICTS[district].name.toUpperCase()}</h2><p>{DISTRICTS[district].description}<br/>Choose a station to travel to its instrument.</p><div className="world-stations">{STATIONS.filter(s=>district===5||s.district===district).map(s=><button key={s.model.id} onClick={()=>{clearStation();setPaused(false);driver.current?.station(s.model.id);stationTimer.current=window.setTimeout(()=>selectModel(s.model.id),matchMedia('(prefers-reduced-motion: reduce)').matches?0:950);}}>{s.model.label} ↗</button>)}</div><button onClick={()=>selectModel(DISTRICTS[district].model)}>{district===5?'OPEN THE ARCHIVE':'ENTER THE WORKSHOP'} ↗</button></div>:null}
<div className="world-tools">{entered&&<button onClick={()=>{setPaused(p=>!p);}}>{paused?'RESUME':'PAUSE'}</button>}<button onClick={()=>{clearStation();pendingDistrict.current=null;setDistrict(null);setBench(false);setPaused(false);driver.current?.home();}}>OVERVIEW</button><button onClick={()=>setHelp(v=>!v)}>CONTROLS</button><button onClick={onStudio}>2D ↗</button></div>
{help&&<div className="world-help">Choose a district to travel.<br/>Drag the scene to look around.<br/>W A S D or arrow keys to move.<br/>Click a luminous station to open its tool.<br/>Escape closes the workshop.<br/>Pause stops the scene's motion.</div>}
{entered&&<div className="world-marker"/>}<div className="world-coordinate">THE NIGHT IS YOUR CANVAS<br/>33° S / 151° E</div><div className="world-status" role={error?'alert':'status'}>{error||status}</div>
<nav className="world-districts" aria-label="Travel to a tool district">{DISTRICTS.map((d,i)=><button key={d.id} className={district===i?'active':''} onClick={()=>travel(i)}><small>0{i+1} / {d.subtitle.replace('THE ','')}</small><strong>{d.name.toUpperCase()} ↗</strong><span>{d.description}</span></button>)}</nav>
{benchCreated&&<Workbench open={bench} close={closeBench} archive={district===5}/>}
</section>;
}
function Workbench({open,close,archive}:{open:boolean;close:()=>void;archive:boolean}){useEffect(()=>{if(!open)return;const fn=(e:KeyboardEvent)=>{if(e.key==='Escape')close();};window.addEventListener('keydown',fn);if(archive)requestAnimationFrame(()=>document.getElementById('ohf-tab-assets')?.click());return()=>window.removeEventListener('keydown',fn);},[open,close,archive]);return <div className="world-workbench" hidden={!open} inert={!open} role="dialog" aria-label="District creation workshop"><button onClick={close}>RETURN TO THE WORLD ×</button><OpenHiggsfieldApp/></div>;}

function buildWorld(mount:HTMLElement,callbacks:{onDistrict:(i:number)=>void;onModel:(id:string)=>void;onStatus:(s:string)=>void;onError:(s:string)=>void}):Driver{
const renderer=new T.WebGLRenderer({antialias:true,alpha:true,powerPreference:'low-power'});renderer.setPixelRatio(Math.min(devicePixelRatio,1));renderer.setSize(mount.clientWidth,mount.clientHeight);renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.05;renderer.setClearColor(0x080909,0);mount.appendChild(renderer.domElement);
const scene=new T.Scene();scene.fog=new T.FogExp2(0x080a0c,.0048);
const camera=new T.PerspectiveCamera(52,mount.clientWidth/mount.clientHeight,.1,900);camera.position.set(12,8,22);
const target=new T.Vector3(0,10,-48),goalPos=camera.position.clone(),goalTarget=target.clone();let moving=false,paused=false,dead=false,frame=0,last=0,dirty=true,renderedFrames=0;const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
const pmrem=new T.PMREMGenerator(renderer),room=new RoomEnvironment(),environment=pmrem.fromScene(room,.025);scene.environment=environment.texture;scene.environmentIntensity=.18;room.dispose();pmrem.dispose();
scene.add(new T.HemisphereLight(0xd3dfe8,0x080808,.45));const moonLight=new T.DirectionalLight(0xd8e6ff,2.2);moonLight.position.set(-40,100,-80);scene.add(moonLight);const fill=new T.DirectionalLight(0xffdec9,.8);fill.position.set(15,9,25);scene.add(fill);
const matte=new T.MeshStandardMaterial({color:0x080a0c,metalness:.55,roughness:.7}),gloss=new T.MeshPhysicalMaterial({color:0x111418,metalness:.92,roughness:.2,clearcoat:1,clearcoatRoughness:.12}),edge=new T.MeshBasicMaterial({color:0xe0e5e7}),dim=new T.MeshBasicMaterial({color:0x53616a}),red=new T.MeshBasicMaterial({color:0x6f1820});
const geometries=new Set<T.BufferGeometry>(),materials=new Set<T.Material>([matte,gloss,edge,dim,red]);const meshes:T.Object3D[]=[];
function mesh(g:T.BufferGeometry,m:T.Material,x:number,y:number,z:number){geometries.add(g);const o=new T.Mesh(g,m);o.position.set(x,y,z);scene.add(o);return o;}
function box(x:number,y:number,z:number,w:number,h:number,d:number,m:T.Material=matte){return mesh(new T.BoxGeometry(w,h,d),m,x,y,z);}
function ring(x:number,y:number,z:number,r:number,t:number,m:T.Material=edge){return mesh(new T.TorusGeometry(r,t,8,96),m,x,y,z);}
const floor=mesh(new T.PlaneGeometry(290,310),gloss,0,-.05,-75);floor.rotation.x=-Math.PI/2;
const reflection=new Reflector(new T.PlaneGeometry(288,308),{color:0x15171a,textureWidth:512,textureHeight:256,clipBias:.004,multisample:0});reflection.rotation.x=-Math.PI/2;reflection.position.set(0,-.02,-75);scene.add(reflection);
for(let i=0;i<25;i++){box(-144+i*12,0,-75,.015,.008,308,matte);box(0,0,-225+i*12,287,.008,.015,matte);}
for(let x of [-3.5,3.5])box(x,.03,-63,.035,.025,190,edge);
const moon=mesh(new T.SphereGeometry(29,48,32),matte,-25,110,-400);const halo=ring(-25,110,-402,31,.09);halo.rotation.z=.25;
const towerGeo=new T.BoxGeometry(1,1,1);geometries.add(towerGeo);const city=new T.InstancedMesh(towerGeo,matte,190);const windows=new T.InstancedMesh(towerGeo,dim,190);let seed=71;const random=()=>{seed=(seed*16807)%2147483647;return(seed-1)/2147483646;};const matrix=new T.Matrix4(),pos=new T.Vector3(),scale=new T.Vector3(),rot=new T.Quaternion();
for(let i=0;i<190;i++){const angle=random()*Math.PI*2,r=155+random()*180,h=15+Math.pow(random(),2)*130;pos.set(Math.cos(angle)*r,h/2-13,Math.sin(angle)*r-80);scale.set(5+random()*15,h,5+random()*13);matrix.compose(pos,rot,scale);city.setMatrixAt(i,matrix);pos.y+=h*.1;pos.x+=scale.x*.501;scale.set(.04,h*.7,.05);matrix.compose(pos,rot,scale);windows.setMatrixAt(i,matrix);}scene.add(city,windows);
const floating:T.Object3D[]=[];
for(const side of [-1,1]){for(let j=0;j<6;j++){const z=12-j*29;box(side*82,30,z,8,65,12,gloss);box(side*77.95,30,z+5.5,.035,61,.035,edge);for(let k=0;k<4;k++)box(side*(79+k*1.3),30,z+6.03,.16,64,.3,matte);}box(side*80,58,-60,11,2,200,gloss);}
box(0,61,-113,170,2,9,matte);box(0,59.98,-108.4,168,.025,.025,edge);
DISTRICTS.forEach((d,i)=>{const plinth=mesh(new T.CylinderGeometry(19,23,2,8),gloss,d.x,-1,d.z);plinth.rotation.y=Math.PI/8;let portal=ring(d.x,11,d.z-3,10,.1);portal.rotation.z=i*.3;floating.push(portal);ring(d.x,11,d.z-3.12,10.8,.07,dim);box(d.x-12,11,d.z-6,3,24,6,gloss);box(d.x+12,11,d.z-6,3,24,6,gloss);box(d.x,24,d.z-6,27,1.5,6,matte);box(d.x-10.4,11,d.z-2.9,.04,22,.04,edge);box(d.x+10.4,11,d.z-2.9,.04,22,.04,edge);const core=mesh(i===0?new T.IcosahedronGeometry(3.5,2):i===1?new T.OctahedronGeometry(4):new T.TorusKnotGeometry(2.6,.65,80,12),gloss,d.x,10,d.z);floating.push(core);const light=new T.PointLight(0xd8ebff,38,28,2);light.position.set(d.x,10,d.z+6);scene.add(light);label(d.name.toUpperCase(),d.x,25.8,d.z-3,10);});
function label(text:string,x:number,y:number,z:number,w=7){const c=document.createElement('canvas');c.width=768;c.height=96;const ctx=c.getContext('2d')!;ctx.fillStyle='#e8e5dd';ctx.font='34px Helvetica, Arial';ctx.textAlign='center';ctx.fillText(text,384,60);const texture=new T.CanvasTexture(c);texture.colorSpace=T.SRGBColorSpace;const material=new T.SpriteMaterial({map:texture,transparent:true,depthWrite:false});materials.add(material);const s=new T.Sprite(material);s.position.set(x,y,z);s.scale.set(w,w/8,1);scene.add(s);return s;}
STATIONS.forEach(s=>{const pedestal=box(s.x,1.6,s.z,1.8,3.2,1.8,gloss);pedestal.userData.model=s.model.id;meshes.push(pedestal);const disc=ring(s.x,4,s.z,.8,.045);disc.userData.model=s.model.id;meshes.push(disc);label(s.model.label.replace('Witchcraft ','').toUpperCase(),s.x,5.4,s.z,5);box(s.x,3.21,s.z,1.82,.018,1.82,edge);});
const guardianX=12,guardianZ=-3;
const guardianBase=mesh(new T.CylinderGeometry(3.9,4.5,.35,64),gloss,guardianX,.175,guardianZ);ring(guardianX,.37,guardianZ,3.7,.018).rotation.x=Math.PI/2;
callbacks.onStatus('THE GATES ARE OPEN. LOADING THE HUNTRESS…');
const assetManager=new T.LoadingManager();let textureFailed=false;assetManager.onError=()=>{textureFailed=true;callbacks.onError('A Huntress texture could not load. The districts and studio remain available.');};
new GLTFLoader(assetManager).load('/huntress.glb',gltf=>{if(dead){disposeObject(gltf.scene);return;}const root=gltf.scene;root.updateMatrixWorld(true);const bounds=new T.Box3().setFromObject(root),size=bounds.getSize(new T.Vector3()),center=bounds.getCenter(new T.Vector3());const s=9.5/size.y;root.scale.setScalar(s);root.position.set(guardianX-center.x*s,.35-bounds.min.y*s,guardianZ-center.z*s);root.traverse(o=>{if(o instanceof T.Mesh){o.frustumCulled=false;o.castShadow=false;o.receiveShadow=false;}});scene.add(root);dirty=true;if(!textureFailed)callbacks.onStatus('HUNTRESS / GUARDIAN OF THE THRESHOLD. CHOOSE A DISTRICT.');},undefined,()=>callbacks.onError('The Huntress could not load. The districts and studio remain available.'));
const guardianLight=new T.PointLight(0xffe4d2,140,25,2);guardianLight.position.set(guardianX+2,8,guardianZ+6);scene.add(guardianLight);
const beam=box(0,.1,0,.045,.02,16,edge);
const ray=new T.Raycaster(),pointer=new T.Vector2();let dragging=false,moved=0,px=0,py=0;const keys=new Set<string>();
function invalidate(){dirty=true;}
function down(e:PointerEvent){dragging=true;moved=0;px=e.clientX;py=e.clientY;renderer.domElement.setPointerCapture(e.pointerId);}
function move(e:PointerEvent){if(!dragging)return;const dx=e.clientX-px,dy=e.clientY-py;moved+=Math.abs(dx)+Math.abs(dy);px=e.clientX;py=e.clientY;moving=false;const offset=target.clone().sub(camera.position);const sph=new T.Spherical().setFromVector3(offset);sph.theta-=dx*.004;sph.phi=Math.max(.3,Math.min(2.7,sph.phi+dy*.004));target.copy(camera.position).add(new T.Vector3().setFromSpherical(sph));invalidate();}
function up(e:PointerEvent){dragging=false;if(moved>5)return;const rect=renderer.domElement.getBoundingClientRect();pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);ray.setFromCamera(pointer,camera);const hit=ray.intersectObjects(meshes)[0];if(hit)callbacks.onModel(hit.object.userData.model);}
function keydown(e:KeyboardEvent){if((e.target as HTMLElement).matches('input,textarea,button')||paused)return;if(['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].includes(e.key.toLowerCase())){e.preventDefault();keys.add(e.key.toLowerCase());invalidate();}}
function keyup(e:KeyboardEvent){keys.delete(e.key.toLowerCase());}
function blur(){keys.clear();dragging=false;}
function resize(){const w=mount.clientWidth,h=mount.clientHeight;if(!w||!h)return;camera.aspect=w/h;camera.updateProjectionMatrix();renderer.setSize(w,h);invalidate();if(paused){camera.lookAt(target);renderer.render(scene,camera);renderer.domElement.dataset.frames=String(++renderedFrames);}}
const observer=new ResizeObserver(resize);observer.observe(mount);
renderer.domElement.addEventListener('pointerdown',down);renderer.domElement.addEventListener('pointermove',move);renderer.domElement.addEventListener('pointerup',up);window.addEventListener('keydown',keydown);window.addEventListener('keyup',keyup);window.addEventListener('blur',blur);document.addEventListener('visibilitychange',invalidate);
function tick(time:number){if(dead)return;frame=requestAnimationFrame(tick);if(document.hidden||paused||time-last<42)return;const dt=Math.min((time-last)/1000,.08);last=time;
if(keys.size){moving=false;const forward=target.clone().sub(camera.position).setY(0).normalize(),right=forward.clone().cross(camera.up);const v=new T.Vector3();if(keys.has('w')||keys.has('arrowup'))v.add(forward);if(keys.has('s')||keys.has('arrowdown'))v.sub(forward);if(keys.has('a')||keys.has('arrowleft'))v.sub(right);if(keys.has('d')||keys.has('arrowright'))v.add(right);v.normalize().multiplyScalar(dt*15);camera.position.add(v);target.add(v);camera.position.x=T.MathUtils.clamp(camera.position.x,-130,130);camera.position.z=T.MathUtils.clamp(camera.position.z,-210,60);dirty=true;}
if(moving){const t=reduced?1:1-Math.exp(-dt*3);camera.position.lerp(goalPos,t);target.lerp(goalTarget,t);if(camera.position.distanceTo(goalPos)<.02)moving=false;dirty=true;}
if(!reduced){floating.forEach((o,i)=>{o.rotation.y+=dt*.025*(i%2?1:-1);});beam.position.z=20-(time*.007)%175;dirty=true;}
if(dirty){camera.lookAt(target);renderer.render(scene,camera);renderer.domElement.dataset.frames=String(++renderedFrames);dirty=false;}}
frame=requestAnimationFrame(tick);
function go(p:T.Vector3,t:T.Vector3){goalPos.copy(p);goalTarget.copy(t);moving=true;paused=false;dirty=true;cancelAnimationFrame(frame);frame=requestAnimationFrame(tick);}
return {travel(i){const d=DISTRICTS[i];go(new T.Vector3(d.x+16,9,d.z+28),new T.Vector3(d.x,9,d.z));callbacks.onDistrict(i);callbacks.onStatus('TRAVELLING TO '+d.name.toUpperCase());},station(id){const s=STATIONS.find(x=>x.model.id===id);if(s)go(new T.Vector3(s.x+3,5,s.z+7),new T.Vector3(s.x,3,s.z));},home(){go(new T.Vector3(12,8,22),new T.Vector3(0,10,-48));},pause(p){paused=p;keys.clear();dirty=true;cancelAnimationFrame(frame);if(!p)frame=requestAnimationFrame(tick);},dispose(){dead=true;cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('keydown',keydown);window.removeEventListener('keyup',keyup);window.removeEventListener('blur',blur);document.removeEventListener('visibilitychange',invalidate);renderer.domElement.removeEventListener('pointerdown',down);renderer.domElement.removeEventListener('pointermove',move);renderer.domElement.removeEventListener('pointerup',up);reflection.removeFromParent();reflection.geometry.dispose();reflection.dispose();assetManager.abort();disposeObject(scene);environment.dispose();renderer.dispose();renderer.forceContextLoss();renderer.domElement.remove();}};
}

