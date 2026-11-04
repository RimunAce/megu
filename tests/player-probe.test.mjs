import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const template=(await readFile('src-tauri/src/player_probe.js','utf8')).replaceAll('__MEGU_SESSION_JSON__',JSON.stringify('test-session')).replaceAll('__MEGU_RESUME__','120');
function video(duration=1200) { return {duration,currentTime:0,readyState:4,seekable:{length:1},paused:false,getBoundingClientRect:()=>({width:1000,height:600}),addEventListener(){}} }
function simulation({topVideo=null,children=[],expected=0}={}) {
  const source=template.replaceAll('__MEGU_EXPECTED_DURATION__',String(expected));
  let now=1000;const rootListeners=[],rootTimers=[];
  const root={};root.top=root;root.addEventListener=(type,fn)=>{if(type==='message')rootListeners.push(fn)};
  const topDoc={title:'',querySelectorAll:(type)=>type==='video'?(topVideo?[topVideo]:[]):type==='iframe'?frames:[]};
  const rootProxy={postMessage:data=>rootListeners.forEach(fn=>fn({data,source:currentSender}))};
  let currentSender=null;const frames=[];const childTimers=[];
  const globalBase={Date:{now:()=>now},Number,JSON,Math,Map,getComputedStyle:()=>({display:'block',visibility:'visible'}),innerWidth:1000,innerHeight:600};
  vm.runInNewContext(source,{...globalBase,window:root,document:topDoc,setInterval:fn=>rootTimers.push(fn)});
  for (const definition of children) {
    const listeners=[],timers=[];const child={top:rootProxy,addEventListener:(type,fn)=>{if(type==='message')listeners.push(fn)}};
    const proxy={postMessage:data=>listeners.forEach(fn=>fn({data,source:rootProxy}))};
    const oldPost=rootProxy.postMessage;
    // Each child receives a caller-specific WindowProxy for its top window.
    const childTop={postMessage:data=>{currentSender=proxy;oldPost(data);currentSender=null}};
    child.top=childTop;child.parent=childTop;
    proxy.postMessage=data=>listeners.forEach(fn=>fn({data,source:childTop}));
    const v=definition.video;
    const childDoc={querySelectorAll:type=>type==='video'?[v]:[]};
    frames.push({contentWindow:proxy,getBoundingClientRect:()=>definition.rect??{left:0,top:0,right:1000,bottom:600}});
    vm.runInNewContext(source,{...globalBase,window:child,document:childDoc,setInterval:fn=>timers.push(fn)});
    childTimers.push(...timers);
  }
  return {topDoc,tick:()=>{now+=500;childTimers.forEach(fn=>fn());rootTimers.forEach(fn=>fn())}};
}
test('seeks and reports the top-level player',()=>{
  const v=video(),s=simulation({topVideo:v});s.tick();assert.equal(v.currentTime,120);assert.match(s.topDoc.title,/__MEGU_PROGRESS__/);assert.equal(JSON.parse(s.topDoc.title.slice(17)).time,120);
});
test('selects and seeks the visible nested player, not a small advertising frame',()=>{
  const v=video(),ad=video(90);const s=simulation({children:[{video:ad,rect:{left:0,top:0,right:100,bottom:100}},{video:v}]});
  for(let i=0;i<8;i++)s.tick();assert.equal(v.currentTime,120);assert.equal(ad.currentTime,0);assert.equal(JSON.parse(s.topDoc.title.slice(17)).time,120);
});
test('does not select short video advertisements',()=>{
  const ad=video(30),s=simulation({children:[{video:ad}]});for(let i=0;i<8;i++)s.tick();assert.equal(ad.currentTime,0);assert.equal(s.topDoc.title,'');
});
test('does not count a duration-mismatched advertisement as an episode',()=>{
  const ad=video(180),s=simulation({topVideo:ad,expected:1440});for(let i=0;i<8;i++)s.tick();assert.equal(ad.currentTime,0);assert.equal(s.topDoc.title,'');
});
test('routes resume and telemetry through two sandboxed frame levels',()=>{
  let now=1000;const listeners=[[],[],[]],timers=[[],[],[]],v=video();
  const root={},middle={},inner={};
  const rootProxy={postMessage:data=>listeners[0].forEach(fn=>fn({data,source:middleProxy}))};
  const middleParentProxy={postMessage:data=>listeners[1].forEach(fn=>fn({data,source:innerProxy}))};
  const middleProxy={postMessage:data=>listeners[1].forEach(fn=>fn({data,source:rootProxy}))};
  const innerProxy={postMessage:data=>listeners[2].forEach(fn=>fn({data,source:middleParentProxy}))};
  root.top=root;middle.top=rootProxy;middle.parent=rootProxy;inner.top=rootProxy;inner.parent=middleParentProxy;
  [root,middle,inner].forEach((w,i)=>{w.addEventListener=(type,fn)=>{if(type==='message')listeners[i].push(fn)}});
  const rect=()=>({left:0,top:0,right:1000,bottom:600});
  const docs=[{title:'',querySelectorAll:t=>t==='iframe'?[{contentWindow:middleProxy,getBoundingClientRect:rect}]:[]},{querySelectorAll:t=>t==='iframe'?[{contentWindow:innerProxy,getBoundingClientRect:rect}]:[]},{querySelectorAll:t=>t==='video'?[v]:[]}];
  const base={Date:{now:()=>now},Number,JSON,Math,Map,getComputedStyle:()=>({display:'block',visibility:'visible'}),innerWidth:1000,innerHeight:600};
  [root,middle,inner].forEach((window,i)=>vm.runInNewContext(template.replaceAll('__MEGU_EXPECTED_DURATION__','0'),{...base,window,document:docs[i],setInterval:fn=>timers[i].push(fn)}));
  for(let i=0;i<8;i++){now+=500;timers[2].forEach(fn=>fn());timers[1].forEach(fn=>fn());timers[0].forEach(fn=>fn())}
  assert.equal(v.currentTime,120);assert.equal(JSON.parse(docs[0].title.slice(17)).time,120);
});
