export async function uploadMedia(file:File):Promise<{url:string}>{
if(file.size>20*1024*1024)throw new Error('Please choose a file smaller than 20 MB.');
const form=new FormData();form.set('file',file);
/* v0.02 fix: the upload endpoint resolves its credential from the SAME provider
   namespace the model runs in. A local preset sent ?provider=local, which made
   /api/upload demand the studio owner cookie and answer 401 even for a perfectly
   valid owner session, and the attach tray swallowed that 401 so the file simply
   never appeared. Uploads are blob storage, not a renderer, so they are always
   authorised against the default (Higgsfield) session; the owner cookie still
   gates which namespace the blob is written to on the server. */
const provider='higgsfield';
const response=await fetch('/api/upload?provider='+provider,{method:'POST',body:form,credentials:'same-origin'});
const text=await response.text();
let result:{url?:string;error?:string};
try{result=JSON.parse(text)as{url?:string;error?:string};}catch{result={error:'The upload service returned an unreadable reply.'};}
if(!response.ok)throw new Error(result.error||`The upload could not finish (${response.status}).`);
if(!result.url)throw new Error('The upload finished without returning a file reference.');
return result as {url:string};}
