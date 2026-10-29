const fs=require('node:fs');
const path=require('node:path');
const {createRequire}=require('node:module');
const esbuild=require('esbuild');
const {chromium}=require('playwright');
const frontend='D:/部署程序/ibtai/ai-assistant';
const r=createRequire(frontend+'/package.json');
const {parse,compileScript}=r('vue/compiler-sfc');
const sass=r('sass');
const out=path.resolve('cursor-replay-results');
fs.mkdirSync(out,{recursive:true});
const chat=fs.readFileSync(frontend+'/components/lobster/ChatPanel.vue','utf8');
const timeline=fs.readFileSync(frontend+'/components/lobster/ActivityTimeline.vue','utf8');
const composable=fs.readFileSync(frontend+'/composables/useLobsterChat.ts','utf8');
const rows=fs.readFileSync('C:/Users/Win10/Downloads/12052.jsonl','utf8').replace(/^\uFEFF/,'').trim().split(/\r?\n/).map(JSON.parse);
const start=rows.findIndex(x=>x.type==='message'&&x.message?.role==='user'&&JSON.stringify(x.message.content).includes('删掉开头的修订说明'));
const end=rows.findIndex((x,i)=>i>start&&x.type==='message'&&x.message?.role==='user');
const turn=rows.slice(start,end);
const applyStep=composable.slice(composable.indexOf('      const applyStep ='),composable.indexOf('      // Wrap up a message'));
const scrolling=chat.slice(chat.indexOf('const scrollToBottom ='),chat.indexOf('</script>')).replace('await nextTick()','scrollCalls++; await nextTick()');
const css=[chat,timeline].map(x=>sass.compileString(x.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1]).css).join('\n');
const labels={exec:'正在执行任务',write:'正在写入文件',edit:'正在编辑文件',read:'正在读取文件'};
const events=[];
for(const row of turn){
 const m=row.message;
 if(!m)continue;
 if(m.role==='assistant')for(const item of m.content||[]){
  if(item.type==='text'&&item.text)events.push({type:'text',text:item.text,time:row.timestamp});
  if(item.type==='toolCall')events.push({type:'step',phase:'start',stepId:item.id,index:events.filter(e=>e.phase==='start').length+1,label:labels[item.name]||item.name,category:item.name==='exec'?'default':'write',tool:item.name,status:'running',time:row.timestamp});
 }
 if(m.role==='toolResult'){
  // Stop before the user-triggered abort; it is not the phenomenon under test.
  if((m.content||[]).some(x=>x.text?.includes('Command aborted by signal')))break;
  const prev=events.find(e=>e.stepId===m.toolCallId);
  if(prev)events.push({...prev,phase:'end',status:m.isError?'failed':'completed',time:row.timestamp});
 }
}
const entry=`import {createApp,ref,watch,nextTick,h} from 'vue';
import Timeline from 'timeline-under-test';
const messages=ref([{id:1,content:'',isStreaming:true,steps:[],stepsCollapsed:false}]);
const chatMessagesRef=ref(null);let scrollCalls=0;
${scrolling}
${applyStep}
window.audit={messages,scrollToBottom,async replay(event){if(event.type==='text')messages.value[0].content+=event.text;else applyStep(1,event);await nextTick();},getCalls:()=>scrollCalls, async collapse(){messages.value[0].stepsCollapsed=true;await nextTick();}};
createApp({setup(){return()=>h('div',{class:'chat-panel'},[
h('div',{class:'chat-messages',ref:chatMessagesRef},messages.value.map(m=>h('div',{class:'message-row assistant'},[
h('div',{class:'avatar'},[h('div',{class:'avatar-img'},'夙')]),
h('div',{class:'message-content'},[
h('div',{class:'message-header'},[h('span',{class:'message-name'},'夙衡'),h('span',{class:'streaming-indicator'},m.isStreaming?'正在处理':'已完成')]),
m.steps.length?h(Timeline,{steps:m.steps,streaming:m.isStreaming,collapsed:m.stepsCollapsed}):null,
h('div',{class:'message-bubble assistant'},[h('div',{class:'message-markdown'},m.content),m.isStreaming?h('span',{class:'cursor-blink'},'▍'):null])])]))),
h('div',{class:'input-area'},'■ 暂停输出')])}}).mount('#app');`;
(async()=>{
 const bundle=await esbuild.build({stdin:{contents:entry,loader:'ts',resolveDir:frontend},bundle:true,write:false,format:'iife',platform:'browser',define:{__VUE_OPTIONS_API__:'true',__VUE_PROD_DEVTOOLS__:'false',__VUE_PROD_HYDRATION_MISMATCH_DETAILS__:'false','process.env.NODE_ENV':'"production"'},alias:{vue:r.resolve('vue/dist/vue.esm-bundler.js')},plugins:[{name:'real-timeline',setup(build){build.onResolve({filter:/^timeline-under-test$/},()=>({path:'timeline',namespace:'audit'}));build.onLoad({filter:/.*/,namespace:'audit'},()=>({contents:compileScript(parse(timeline).descriptor,{id:'timeline-audit',inlineTemplate:true}).content,loader:'ts',resolveDir:frontend}));}}]});
 const browser=await chromium.launch({headless:true});
 const results=[];
 try{
  for(const viewport of [{width:1280,height:720},{width:1440,height:900},{width:1920,height:1080}])for(let repeat=1;repeat<=3;repeat++){
   const page=await browser.newPage({viewport});
   await page.setContent(`<style>${css} html,body,#app{height:100%;margin:0}.chat-panel{height:calc(100vh - 100px);width:min(100%,1000px)}.input-area{height:45px;flex-shrink:0}</style><div id="app"></div>`);
   await page.addScriptTag({content:bundle.outputFiles[0].text});
   const measure=()=>page.evaluate(()=>{const box=document.querySelector('.chat-messages'),cursor=document.querySelector('.cursor-blink');const b=box.getBoundingClientRect(),c=cursor?.getBoundingClientRect();return {steps:audit.messages.value[0].steps.length,isStreaming:audit.messages.value[0].isStreaming,scrollCalls:audit.getCalls(),scrollTop:box.scrollTop,cursorExists:!!cursor,cursorInView:!!c&&c.top>=b.top&&c.bottom<=b.bottom,cursorTop:c?.top,viewportBottom:b.bottom,animation:cursor?getComputedStyle(cursor).animationName:null,contentLength:audit.messages.value[0].content.length}});
   let firstHidden=null;
   for(const event of events){await page.evaluate(e=>audit.replay(e),event);await page.waitForTimeout(35);const state=await measure();if(!state.cursorInView&&!firstHidden)firstHidden={eventTime:event.time,tool:event.tool,...state};}
   await page.waitForTimeout(350);
   const final=await measure();
   if(repeat===1)await page.screenshot({path:path.join(out,`replay-${viewport.height}-before-scroll.png`)});
   await page.evaluate(()=>audit.scrollToBottom());
   await page.waitForTimeout(30);
   const afterScroll=await measure();
   if(repeat===1)await page.screenshot({path:path.join(out,`replay-${viewport.height}-after-scroll.png`)});
   results.push({viewport,repeat,firstHidden,final,afterScroll});
   console.log(JSON.stringify(results.at(-1)));
   await page.close();
  }
 }finally{await browser.close()}
 const report={method:'Local replay fixture using real ActivityTimeline.vue, both component styles, and extracted applyStep/auto-scroll functions; not a recording of the deployed page. JSONL tool calls mapped to steps; no tool commands executed.',sourceLines:[start+1,end],toolCalls:events.filter(x=>x.phase==='start').length,textChunks:events.filter(x=>x.type==='text').length,events,results};
 fs.writeFileSync(path.join(out,'replay-results.json'),JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
