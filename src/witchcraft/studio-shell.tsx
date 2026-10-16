import {lazy,Suspense,useEffect,useState} from 'react';
import {OpenHiggsfieldApp} from '@/openhiggsfield/openhiggsfield-app';
import {useActive} from '@/generation/stores/active';
import {useImagePrompt,useVideoPrompt} from '@/generation/stores/prompt';
import {DISTRICTS} from './districts';
import {useRoute} from './app-router';
import {readRoute,consumeIntent,navigate} from './route';
import {PromptGallery} from './prompt-gallery';
import {FreeAccess} from './free-access';
import {OwnerAccess} from './owner-access';
const World=lazy(()=>import('./world').then(m=>({default:m.World})));
/* Preserve the required legal identity on every route, including early returns.
   Identity changes require the reviewed identity-guard release process. */
function LegalIdentity(){return <span className="wc-legal">Butterfly Kingdom NSW Pty Ltd · ABN 11 691 050 969 · <a href="mailto:hecate@witch.codes">hecate@witch.codes</a></span>}
function LegalFooter(){return <footer className="wc-identity-footer"><LegalIdentity/></footer>}
export function StudioShell(){
const worldSite=location.hostname==='witchcraft.video'||new URLSearchParams(location.search).get('world')==='1';
const [world,setWorld]=useState(worldSite);const model=useActive(s=>s.model);
const route=useRoute();
/* The "use in studio" handoff arrives on history state. When the home route is
   showing it, adopt the prompt and its surface — this also flips a Video-host
   world back to the studio, because the visitor asked to use a prompt. A plain
   ENTER THE WORLD click carries no intent, so deliberate world navigation is
   untouched. The intent is not re-read once consumed, so a later Back to home
   does not replay it. */
useEffect(()=>{if(readRoute()!=='home')return;const intent=consumeIntent();if(!intent)return;
useActive.getState().setModel(intent.model);
(intent.surface==='image'?useImagePrompt:useVideoPrompt).getState().setText(intent.text);
setWorld(false);},[route]);
if(route==='credits')return <><Credits/><LegalFooter/></>;
if(route==='free')return <><FreeAccess/><LegalFooter/></>;
if(route==='owner')return <><OwnerAccess/><LegalFooter/></>;
return <div className={'witchcraft '+(world?'world-mode':'studio-mode')}>
<header className="wc-masthead"><a className="wc-wordmark" href={worldSite?'https://witchcraft.pics':'/'} aria-label="Witchcraft home"><span className="wc-sigil">W</span>WITCHCRAFT<span className="wc-edition">{world?'WORLD / 02':'STUDIO / 01'}</span></a><nav aria-label="Experience"><button className={!world&&route==='home'?'active':''} onClick={()=>{setWorld(false);navigate('home')}}>STUDIO</button><button className={world&&route==='home'?'active':''} onClick={()=>{setWorld(true);navigate('home')}}>ENTER THE WORLD ↗</button><button className={route==='prompts'?'active':''} onClick={()=>navigate('prompts')}>PROMPTS</button><button onClick={()=>navigate('free')}>FREE ACCESS</button></nav><span className="wc-live"><i/> IMAGINATION, UNBOUND</span></header>
{route==='prompts'?<PromptGallery/>:world?<Suspense fallback={<div className="world-loading">BUILDING THE IMPOSSIBLE…</div>}><World onStudio={()=>setWorld(false)}/></Suspense>:<>
<aside className="wc-sidebar"><div className="wc-sidebar-title">THE PRACTICE</div>{DISTRICTS.slice(0,5).map(d=><button key={d.id} className={model===d.model?'active':''} onClick={()=>useActive.getState().setModel(d.model)}><span>{d.symbol}</span><span>{d.name.toUpperCase()}<small>{d.subtitle.replace('THE ','')}</small></span></button>)}<div className="wc-sidebar-bottom"><span>01 / 02</span><button onClick={()=>setWorld(true)}>LEAVE THE ORDINARY ↗</button></div></aside>
<section className="wc-studio" aria-label="Witchcraft creation studio"><OpenHiggsfieldApp fontClassName="wc-type"/></section></>}
<footer className="wc-footnote"><span>WITCHCRAFT © {new Date().getFullYear()}</span><span>Based on <a href="https://github.com/wide-trace/open-higgsfield" target="_blank" rel="noreferrer">OpenHiggsfield by wide-trace</a>. RunPod generation. Original Higgsfield models available with a separate connection.</span><LegalIdentity/><nav className="wc-footnote-nav" aria-label="Footer"><a href="/free-access">FREE ACCESS ↗</a><a href="/credits">CREDITS ↗</a></nav></footer></div>}
export function StudioWelcome(){return <div className="wc-welcome"><div className="wc-hero"><div className="wc-hero-image"/><div className="wc-hero-copy"><p>THE ART OF MAKING THE IMPOSSIBLE.</p><h2>Reality is<br/>a <em>suggestion.</em></h2><span>Images. Cinema. Worlds.<br/>A little darkness. Infinite possibility.</span><button onClick={()=>document.querySelector<HTMLTextAreaElement>('.ohf-prompt')?.focus()}>MAKE SOMETHING UNREAL <b>↗</b></button><a className="wc-hero-free" href="/free-access">New here? Explore free provider signup options →</a></div><div className="wc-hero-caption"><span>FIG. 001</span><span>THE CITY THAT DREAMS YOU BACK</span><span>WITCHCRAFT / NOCTURNE</span></div></div><div className="wc-section-caption"><span>CHOOSE YOUR CRAFT</span><span>ONE IDEA. EVERY POSSIBILITY.</span></div><div className="wc-crafts">{DISTRICTS.slice(0,5).map((d,i)=><button key={d.id} onClick={()=>{useActive.getState().setModel(d.model);document.querySelector<HTMLTextAreaElement>('.ohf-prompt')?.focus();}}><span className={'wc-craft-art art-'+i}><i>{d.symbol}</i><small>0{i+1}</small></span><strong>{d.name.toUpperCase()} <span>↗</span></strong><p>{d.description}</p></button>)}</div></div>}
function Credits(){return <main className="credits"><a href="/">← BACK TO WITCHCRAFT</a><h1>THE PEOPLE BEHIND THE MAGIC.</h1><h2>OPENHIGGSFIELD</h2><p>Witchcraft is based on <a href="https://github.com/wide-trace/open-higgsfield">OpenHiggsfield by wide-trace</a>, revision b16a0ef. The studio interface, generation catalogue and workflow foundation originate in that project. Witchcraft adds its visual identity, spatial world and Cloudflare integration.</p><p>RunPod is the default generation provider. The original Higgsfield catalogue remains available with its own account; Higgsfield was co-founded by Alex Mashrabov. Witchcraft Anima and Anima Cinema are interface names for Higgsfield Soul 2 and Soul Cinema. Witchcraft Oracle is the interface name for Higgsfield DoP. Third-party models retain their original names. Provider availability and charges depend on your own account.</p><h2>THE HUNTRESS</h2><p><a href="https://sketchfab.com/3d-models/huntress-19ceb83a896c4d668b0f30a6fc58d563">Huntress</a> by <a href="https://sketchfab.com/neilhancart">Wilson</a>, licensed under <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>. Changes: animation metadata repair, web texture optimisation, scale and lighting integration.</p><h2>WITCHCRAFT</h2><p>Art direction, spatial experience and interface by Witchcraft. The environment plate is AI generated. The world is rendered in real time with Three.js.</p></main>}
