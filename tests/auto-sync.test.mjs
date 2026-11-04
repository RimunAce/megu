import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const mocks = {
  anilist: `export async function gql(...args) { return globalThis.__test.gql(...args); }
    export async function saveListEntry(...args) { return globalThis.__test.save(...args); }`,
  tauri: `export const isTauri = true; export async function getPendingProgress(...args) { return globalThis.__test.pending(...args); }`,
  app: `export const useAuthStore = { getState: () => globalThis.__test.auth };`,
};
const source = (await readFile('src/lib/autoSync.ts', 'utf8')).replace(/^import .*;\r?\n/gm, '');
const mockSource = Object.values(mocks).join('\n').replaceAll('export ', '');
const js = stripTypeScriptTypes(`${mockSource}\n${source}`);
const sync = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,String(v)) };
globalThis.window = new EventTarget();
const item = {mediaId: 42, episode: 8, title: 'Test title'};
function setup(progress = 0) {
  storage.clear();
  const state = {auth:{token:'token',viewer:{id:5}}, progress, writes:[], fail:false, manual:[]};
  globalThis.__test = {
    auth:state.auth,
    pending:async()=>state.manual,
    gql:async()=>{if(state.fail)throw Error('offline');return {Media:{mediaListEntry:{progress:state.progress}}}},
    save:async(...args)=>{state.writes.push(args);},
  };
  return state;
}
test('updates progress and clears a successful queued item', async () => {
  const state=setup(4); sync.queueAutoSync(5,item); await sync.drainAutoSync(5,'token',()=>{});
  assert.equal(state.writes.length,1); assert.equal(state.writes[0][2].progress,8); assert.deepEqual(sync.pendingAutoSync(5),[]);
});
test('never lowers AniList progress', async () => {
  const state=setup(10); sync.queueAutoSync(5,item); await sync.drainAutoSync(5,'token',()=>{});
  assert.equal(state.writes.length,0); assert.deepEqual(sync.pendingAutoSync(5),[]);
});
test('retains offline work for automatic retry', async () => {
  const state=setup(); state.fail=true; sync.queueAutoSync(5,item); await sync.drainAutoSync(5,'token',()=>{});
  assert.equal(sync.pendingAutoSync(5).length,1); state.fail=false; await sync.drainAutoSync(5,'token',()=>{});
  assert.equal(state.writes.length,1); assert.equal(sync.pendingAutoSync(5).length,0);
});
test('preserves conflicting manual edits', async () => {
  const state=setup(); state.manual=[{media_id:42}]; sync.queueAutoSync(5,item); await sync.drainAutoSync(5,'token',()=>{});
  assert.equal(state.writes.length,0); assert.equal(sync.pendingAutoSync(5).length,1);
});
test('coalesces episodes and isolates accounts', async () => {
  const state=setup(); sync.queueAutoSync(5,item); sync.queueAutoSync(5,{...item,episode:9}); sync.queueAutoSync(6,item);
  await sync.drainAutoSync(6,'token',()=>{}); assert.equal(state.writes.length,0);
  await sync.drainAutoSync(5,'token',()=>{}); assert.equal(state.writes[0][2].progress,9); assert.equal(sync.pendingAutoSync(6).length,1);
});
test('does not send pending updates while automatic sync is disabled', async () => {
  const state=setup();sync.queueAutoSync(5,item);localStorage.setItem('megu.autoSync','false');await sync.drainAutoSync(5,'token',()=>{});
  assert.equal(state.writes.length,0);assert.equal(sync.pendingAutoSync(5).length,1);localStorage.setItem('megu.autoSync','true');await sync.drainAutoSync(5,'token',()=>{});assert.equal(state.writes.length,1);
});
test('preserves a newer episode queued during a request', async () => {
  const state=setup(); globalThis.__test.save=async(...args)=>{state.writes.push(args);sync.queueAutoSync(5,{...item,episode:9})};
  sync.queueAutoSync(5,item);await sync.drainAutoSync(5,'token',()=>{});
  assert.equal(state.writes[0][2].progress,8);assert.equal(sync.pendingAutoSync(5)[0].episode,9);
});
test('rechecks for manual edits just before an automatic save', async () => {
  const state=setup();globalThis.__test.gql=async()=>{state.manual=[{media_id:42}];return {Media:{mediaListEntry:{progress:0}}}};
  sync.queueAutoSync(5,item);await sync.drainAutoSync(5,'token',()=>{});
  assert.equal(state.writes.length,0);assert.equal(sync.pendingAutoSync(5).length,1);
});
