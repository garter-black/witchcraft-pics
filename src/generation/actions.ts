import type {GenerationPlane} from './catalog/types';
import type {Provider} from './catalog/types';
import type {StatusResult,QueuedGeneration} from './platform';
import {MissingCredentialsError} from './credentials';
import {notifyCredentialChange} from './credential-events';
import {wipeClientState, completeScopeRemoval, resetPersistentStores, type WipeResult} from './credential-scope';
import {runExclusive} from './storage-boundary';
async function call<T>(action:string,data:unknown={},method='POST'):Promise<T>{
const response=await fetch('/api/'+action,{method,credentials:'same-origin',headers:method==='GET'?{}:{'Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify(data)})});
const value=await response.json();if(response.status===401)throw new MissingCredentialsError();
if(!response.ok)throw new Error(value.error||'The studio could not complete this request.');return value;}

/* ---------- the credential mutation boundary ----------

   Every call that changes which credential scope the browser is on runs through
   here AFTER its API call succeeds. A credential change is a storage-scope
   boundary, and that boundary has three jobs, in order:

   1. bump the scope epoch, stop the previous scope's polls, and drop the
      sensitive localStorage keys (synchronous);
   2. AWAIT removal of the previous scope's browser history record (the reliable
      guarantee — a whole-database delete can be blocked by another tab and must
      not be reported as success), then reset the in-memory sensitive stores;
   3. tell every mounted surface through one explicit event, so a mutation from
      ANY caller — the visitor key modal, the private /owner page, or a
      programmatic call — clears mounted history instead of only the caller that
      remembered to.

   The boundary does NOT swallow a failed cleanup: if the record could not be
   confirmed removed, the mutation rejects so the caller reports it rather than
   claiming a clean switch.

   ORDERING (the direct-action fix): the SYNCHRONOUS scope invalidation runs
   FIRST, outside the queue — the epoch bumps, `stopWatching()` fires and the
   sensitive localStorage keys drop IMMEDIATELY, so every async callback already
   in flight (a poll that would settle, a history load in progress) is
   invalidated the instant the boundary is reached, not after earlier writes
   drain. Only then is the AWAITED storage removal (the history-record delete)
   queued through the SAME `runExclusive` chain that serializes history saves,
   so a save still in flight lands BEFORE the removal and a late old save cannot
   recreate a readable row. The synchronous half never queues, so there is no
   nested-queue deadlock. */
async function afterCredentialMutation(provider:Provider):Promise<WipeResult>{
  // 1. SYNCHRONOUS, immediate: bump the scope epoch, stop the previous scope's
  //    polls, and drop the sensitive localStorage keys. This runs BEFORE any
  //    await, so an older callback is already stale the moment this is called.
  const scope = wipeClientState();
  // 2. Reset the sensitive in-memory surfaces NOW, during the wait, so a mounted
  //    gallery cannot keep showing the old scope's media/prompt while the
  //    awaited removal is queued.
  await resetPersistentStores();
  // 3. AWAITED, ordered: the reliable history-record removal, queued behind any
  //    in-flight save so the removal genuinely follows it.
  const result = await runExclusive(() => completeScopeRemoval(scope));
  notifyCredentialChange(provider);
  if (result.error || !result.recordRemoved) {
    throw new Error(
      result.error
        ? `The stored run log could not be fully cleared (${result.error}).`
        : 'The stored run log could not be fully cleared.',
    );
  }
  return result;
}

/** Save or replace a provider key. On success the previous scope is wiped and
    the caller is told through the credential-change event before this resolves. */
export async function savePlatformCredentials(data:unknown,provider:Provider='higgsfield'){
  await call('credentials?provider='+provider,data);
  await afterCredentialMutation(provider);
}
/** Clear a provider key. The wipe runs even though the key is gone — the point
    is that the previous session's runs and references stop being readable. */
export async function clearPlatformCredentials(provider:Provider='higgsfield'){
  await call('credentials?provider='+provider,{},'DELETE');
  await afterCredentialMutation(provider);
}
export async function hasPlatformCredentials(provider:Provider='higgsfield'){return (await call<{configured:boolean}>('credentials?provider='+provider,{},'GET')).configured;}
export async function submitGeneration(plane:GenerationPlane){return call<QueuedGeneration>('generate',plane);}
export async function getGenerationStatuses(data:unknown):Promise<StatusResult[]>{return call('status',data);}

/* ---------- local studio renderer ---------- */

/** The owner connects their own studio, not a paid provider account. The key is
    a generated owner access key; it is never an id:secret and it spends no
    provider balance.

    This is ALSO a credential-scope change: switching or reconnecting the owner
    from /owner must clear the previous browser scope, exactly like a key replace
    in the visitor modal. It routes through the same boundary. */
export async function connectStudioOwner(ownerKey:string){
  await call('credentials?provider=local',{ownerKey});
  await afterCredentialMutation('local');
}

export type RendererState={configured:boolean;connected:boolean;renderer:{online:boolean;ageMs:number;detail?:Record<string,unknown>}};

export async function fetchRendererState():Promise<RendererState>{
  const response=await fetch('/api/local-state',{credentials:'same-origin'});
  if(!response.ok)throw new Error('The studio renderer state could not be read.');
  return await response.json() as RendererState;
}

export type PlanReply={ok:boolean;route:string;reason?:string;held?:Record<string,string>;plan?:{prompt:string;negative:string;shots:Array<{order:number;description:string;motion:string}>}};

/** Prompt and shot planning. Owner-only: the planner spends the owner's own
    route allowance, so an anonymous caller is refused by the server. It is a
    text planner and never renders media. */
export async function requestPlan(data:{prompt:string;surface:'image'|'video';seconds?:number}):Promise<PlanReply>{
  return call<PlanReply>('plan',data);
}
