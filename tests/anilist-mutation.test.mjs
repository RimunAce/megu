import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source=stripTypeScriptTypes(await readFile('src/lib/anilist.ts','utf8'));
const {saveListEntry}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
test('progress-only sync omits score and all other unedited AniList fields',async()=>{
  const original=globalThis.fetch;let request;
  globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,status:200,json:async()=>({data:{SaveMediaListEntry:{}}})}};
  try{await saveListEntry('test',42,{progress:3});assert.deepEqual(request.variables,{mediaId:42,progress:3});assert.match(request.query,/progress: \$progress/);assert.doesNotMatch(request.query,/scoreRaw:|notes:|private:|repeat:/)}finally{globalThis.fetch=original}
});
test('explicit zero, false and empty notes are sent without interpolation',async()=>{
  const original=globalThis.fetch;let request;
  globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,status:200,json:async()=>({data:{SaveMediaListEntry:{}}})}};
  try{await saveListEntry('test',42,{score:0,repeat:0,notes:'',private:false});assert.deepEqual(request.variables,{mediaId:42,score:0,repeat:0,notes:'',private:false});assert.match(request.query,/scoreRaw: \$score/);assert.match(request.query,/private: \$private/)}finally{globalThis.fetch=original}
});
test('sends explicit list settings and dates without altering unrelated fields',async()=>{
  const original=globalThis.fetch;let request;
  globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,status:200,json:async()=>({data:{SaveMediaListEntry:{}}})}};
  try{await saveListEntry('test',42,{customLists:[],hiddenFromStatusLists:false,startedAt:{year:2026,month:1,day:2},completedAt:{}});assert.deepEqual(request.variables,{mediaId:42,hiddenFromStatusLists:false,customLists:[],startedAt:{year:2026,month:1,day:2},completedAt:{}});assert.match(request.query,/\$startedAt: FuzzyDateInput/);assert.doesNotMatch(request.query,/scoreRaw:|notes:/)}finally{globalThis.fetch=original}
});
test('uses AniList preferred-format score argument and supports partial date clears',async()=>{
  const original=globalThis.fetch;let request;
  globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return {ok:true,status:200,json:async()=>({data:{SaveMediaListEntry:{}}})}};
  try{await saveListEntry('test',42,{scoreFormatted:8.5,startedAt:{year:2026,month:null,day:null}});assert.deepEqual(request.variables,{mediaId:42,scoreFormatted:8.5,startedAt:{year:2026,month:null,day:null}});assert.match(request.query,/score: \$scoreFormatted/);assert.doesNotMatch(request.query,/scoreRaw:/)}finally{globalThis.fetch=original}
});
