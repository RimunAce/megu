import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source = await readFile('src/lib/anivexa.ts','utf8');
const js = stripTypeScriptTypes(source);
const {safeEmbedUrl,embedOptions}=await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
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
test('offers direct HLS with safe same-host subtitles after embeds',()=>{
  const list=embedOptions([{type:'hls',server:'Source',url:'https://cdn.example.org/master.m3u8',referer:'https://provider.example.org/',subtitles:[{url:'https://cdn.example.org/sub.srt',format:'srt',label:'English',srclang:'en'},{url:'https://127.0.0.1/sub.srt',format:'srt'},{url:'https://other.example.org/sub.srt',format:'srt'}]},{type:'embed',server:'Embed',url:'https://example.org/embed'}]);
  assert.deepEqual(list.map(x=>x.kind),['embed','hls']);assert.equal(list[1].subtitles.length,1);assert.equal(list[1].referer,'https://provider.example.org/');
});
