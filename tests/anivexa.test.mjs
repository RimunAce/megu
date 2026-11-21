import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source = await readFile('src/lib/anivexa.ts','utf8');
const js = stripTypeScriptTypes(source);
const {safeEmbedUrl,embedOptions,getEpisodes}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
test('bounds provider requests with a timeout while preserving caller cancellation',async(t)=>{
  const timeout=new AbortController();
  t.mock.method(AbortSignal,'timeout',()=>timeout.signal);
  t.mock.method(globalThis,'fetch',(_url,init)=>new Promise((_resolve,reject)=>{
    init.signal.addEventListener('abort',()=>reject(init.signal.reason??new Error('aborted')),{once:true});
  }));
  const caller=new AbortController();
  const canceled=getEpisodes(195539,'anikoto',caller.signal);
  caller.abort();
  await assert.rejects(canceled,{name:'AbortError'});
  const slow=getEpisodes(195539,'anikoto');
  timeout.abort();
  await assert.rejects(slow,/too long/);
});
test('accepts provider embedUrl, embed and explicit embed streams, preferring videojs',()=>{
  const list=embedOptions([{server:'A',embed:'https://flixcloud.cc/e/one'}, {server:'B',embedUrl:'https://megaplay.buzz/videojs/stream/one'}, {server:'C',type:'embed',url:'https://example.com/embed/one'}]);
  assert.deepEqual(list.map(x=>x.label),['B','A','C']);
});
test('rejects local and insecure embed links and deduplicates',()=>{
  assert.equal(safeEmbedUrl('https://127.0.0.1/player'),null);assert.equal(safeEmbedUrl('http://example.com/'),null);
  assert.equal(embedOptions([{embed:'https://example.com/a'},{embedUrl:'https://example.com/a'},{embed:'file:///secret'}]).length,1);
});
test('distinguishes servers returned with duplicate names',()=>{
  const list=embedOptions([{server:'Mirror',embed:'https://example.com/a'},{server:'Mirror',embed:'https://example.com/b'}]);
  assert.deepEqual(list.map(x=>x.label),['Mirror','Mirror #2']);
});
test('prefers direct HLS over embeds and allows cross-host public subtitles',()=>{
  const list=embedOptions([
    {type:'embed',server:'Embed',url:'https://example.org/embed'},
    {type:'hls',server:'Source',url:'https://cdn.example.org/master.m3u8',referer:'https://provider.example.org/',subtitles:[
      {url:'https://cdn.example.org/sub.srt',format:'srt',label:'English',srclang:'en'},
      {url:'https://127.0.0.1/sub.srt',format:'srt'},
      {url:'https://subs.other.example.org/en.vtt',label:'English Alt',srclang:'en'}
    ]},
  ]);
  assert.deepEqual(list.map(x=>x.kind),['hls','embed']);
  assert.equal(list[0].subtitles.length,2);
  assert.equal(list[0].subtitles[1].format,'vtt');
  assert.equal(list[0].referer,'https://provider.example.org/');
});
test('accepts direct mp4 as an in-app player option and not as an embed', () => {
  const list=embedOptions([
    {server:'Mirror',url:'https://cdn.example.org/video/ep1.mp4'},
    {server:'Mirror',type:'mp4',url:'https://cdn.example.org/video/ep1.mp4'},
    {server:'Embed',embed:'https://example.org/e/ep1'},
  ]);
  assert.equal(list.length,2);
  assert.equal(list[0].kind,'mp4');
  assert.equal(list[0].label,'Mirror · Direct MP4');
  assert.equal(list[1].kind,'embed');
});
