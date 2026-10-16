// Local acceptance harness only: real Worker/routes + in-memory TEST storage.
// Preauthenticated synthetic owner fixture; never reads production secrets.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import worker, { seal } from '../worker/index';
import { fakeR2 } from './fake-r2';
const root = resolve('dist');
const PORT = 5201;
const origin = `http://127.0.0.1:${PORT}`;
const storage = fakeR2();
const put = storage.put.bind(storage);
storage.put = async (key, value, opts) => put(key, value instanceof ReadableStream ? await new Response(value).arrayBuffer() : value, opts);
const env: any = { SESSION_SECRET: 'local-browser-test-secret-not-a-production-credential', OWNER_ACCESS_KEY: 'local-browser-test-owner-not-production', MEDIA: storage };
const cookie = '__Host-witchcraft-local=' + await seal(env.OWNER_ACCESS_KEY, env.SESSION_SECRET, 'local');
const types: Record<string,string> = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.glb':'model/gltf-binary'};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, origin);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) {
      if (url.pathname === '/api/generate') {
        res.writeHead(409, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'TEST HARNESS: generation disabled; no paid or GPU request sent.'})); return;
      }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [k,v] of Object.entries(req.headers)) if (v && !['host','cookie','content-length'].includes(k)) headers.set(k, Array.isArray(v)?v.join(','):v);
      headers.set('cookie',cookie);
      const body = Buffer.concat(chunks);
      const input = new Request(url, {method:req.method,headers,...(body.length?{body}: {})});
      const result = await worker.fetch(input, env, {waitUntil(){}} as any);
      res.writeHead(result.status,Object.fromEntries(result.headers));
      res.end(Buffer.from(await result.arrayBuffer())); return;
    }
    const file = resolve(root, '.' + url.pathname);
    if (!file.startsWith(root)) {res.writeHead(403);res.end();return;}
    let bytes: Buffer; let extension=extname(file);
    try {bytes=await readFile(file);} catch {bytes=await readFile(resolve(root,'index.html'));extension='.html';}
    res.writeHead(200, {'Content-Type':types[extension]??'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);
  } catch(e) {res.writeHead(500,{'Content-Type':'text/plain'});res.end(String(e));}
});
server.listen(PORT,'127.0.0.1',()=>console.log(`TEST ONLY: ${origin}`));
setTimeout(()=>server.close(()=>process.exit(0)),15*60*1000).unref();
