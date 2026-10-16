import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index';
import {fakeR2} from './fake-r2';

// Synthetic fixtures only. No live keys or network calls.
const ORIGIN='https://studio.test';
const OWNER='owner-session-lifetime-test-only';
const DAY=24*60*60*1000;

test('owner credential stays usable for exactly the advertised one-year cookie lifetime',async(t)=>{
  const start=Date.parse('2026-01-01T00:00:00Z');
  let now=start;
  t.mock.method(Date,'now',()=>now);
  const env={ASSETS:{fetch:async()=>new Response('not found',{status:404})},SESSION_SECRET:'synthetic-session-secret-for-lifetime-test-only',HF_API_BASE_URL:'https://provider.invalid',OWNER_ACCESS_KEY:OWNER,MEDIA:fakeR2()};
  const login=await worker.fetch(new Request(ORIGIN+'/api/credentials?provider=local',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/json'},body:JSON.stringify({ownerKey:OWNER})}),env);
  assert.equal(login.status,200);
  const header=login.headers.get('set-cookie')!;
  assert.ok(header.includes('HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=31536000'));
  const cookie=header.split(';')[0];
  const status=async(config=env)=>{
    const response=await worker.fetch(new Request(ORIGIN+'/api/credentials?provider=local',{headers:{cookie}}),config);
    assert.equal(response.status,200);
    return (await response.json() as {configured:boolean}).configured;
  };
  assert.equal(await status(),true,'new owner session');
  now=start+2*DAY;
  assert.equal(await status(),true,'must not expire after the first day');
  now=start+365*DAY-1;
  assert.equal(await status(),true,'valid just before the advertised expiry');
  assert.equal(await status({...env,OWNER_ACCESS_KEY:'rotated-fixture-only-owner-key'}),false,'owner-key mismatch must still revoke immediately');
  now=start+365*DAY;
  assert.equal(await status(),false,'expires at the exact advertised boundary');
});
