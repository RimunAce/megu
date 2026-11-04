import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source=(await readFile('src/lib/playback.ts','utf8')).replace(/^import .*;\r?\n/gm,'');
const script=stripTypeScriptTypes(`const PROVIDERS=['anikoto','kaa'];\n${source}`);
const {getPlayback,savePlayback,formatTime}=await import(`data:text/javascript;base64,${Buffer.from(script).toString('base64')}`);
const storage=new Map();
globalThis.localStorage={getItem:(k)=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,String(v))};
globalThis.window=new EventTarget();
const record={mediaId:42,title:'Test',episodeId:'watch/anikoto/42/sub/anikoto-1',episode:1,provider:'anikoto',audio:'sub',server:'Player A',position:124.7,duration:1400,updatedAt:1};
test('retains provider, player and fractional timestamp per account',()=>{
  storage.clear();savePlayback(5,record);assert.deepEqual(getPlayback(5),[record]);assert.deepEqual(getPlayback(6),[]);
});
test('separate players and episodes retain their own positions',()=>{
  storage.clear();savePlayback(5,record);savePlayback(5,{...record,server:'Player B',position:42});
  savePlayback(5,{...record,position:130});const data=getPlayback(5);assert.equal(data.length,2);assert.equal(data[0].position,130);assert.equal(data[1].position,42);
});
test('ignores corrupt data and invalid provider records',()=>{
  storage.clear();storage.set('megu.playback.v1.5','{');assert.deepEqual(getPlayback(5),[]);
  storage.set('megu.playback.v1.5',JSON.stringify([{...record,provider:'unknown'},{...record,position:2000},record]));assert.deepEqual(getPlayback(5),[record]);
});
test('formats minutes and hours correctly',()=>{
  assert.equal(formatTime(9.9),'0:09');assert.equal(formatTime(3601),'1:00:01');assert.equal(formatTime(-1),'0:00');
});
