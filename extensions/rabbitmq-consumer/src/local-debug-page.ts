export function renderLocalDebugPage(runPath: string, skillsPath: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OpenClaw · RabbitMQ 本地通道</title>
  <style>
    :root{color-scheme:dark;--bg:#080b12;--panel:#10141d;--panel2:#151a25;--line:#242b39;--muted:#8d97aa;--text:#edf1f7;--accent:#f26b38;--accent2:#ff8b5e;--success:#56c596;--danger:#ff7f8c;--sidebar:260px}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;overflow:hidden}
    button,input,select,textarea{font:inherit}button{color:inherit}.app{height:100vh;display:grid;grid-template-columns:var(--sidebar) 1fr}
    aside{background:#0c1017;border-right:1px solid var(--line);padding:18px 14px;display:flex;flex-direction:column;min-width:0}
    .brand{display:flex;align-items:center;gap:10px;font-weight:750;font-size:16px;padding:4px 8px 18px}.logo{width:31px;height:31px;display:grid;place-items:center;border-radius:10px;background:linear-gradient(135deg,#ff9a66,#e34e23);box-shadow:0 8px 22px #f26b3833}
    .new-chat{width:100%;display:flex;align-items:center;justify-content:center;gap:8px;border:1px solid #3a4252;background:#171c27;border-radius:10px;padding:10px 12px;cursor:pointer}.new-chat:hover{border-color:#596276;background:#1c2230}
    nav{margin-top:20px;display:grid;gap:5px}.nav-item{display:flex;align-items:center;gap:10px;padding:9px 11px;border:0;background:transparent;text-align:left;cursor:pointer;border-radius:9px;color:#aeb7c7}.nav-item:hover{background:#141a24}.nav-item.active{background:#1a202c;color:#fff}.nav-icon{width:20px;text-align:center}
    .side-card{margin-top:auto;border:1px solid var(--line);background:#111620;border-radius:12px;padding:12px}.side-card strong{display:block;margin-bottom:5px}.side-card p{color:var(--muted);font-size:12px;margin:0}.safe{display:flex;align-items:center;gap:7px;color:var(--success);font-size:12px;margin-top:10px}
    main{min-width:0;height:100vh;display:grid;grid-template-rows:58px 1fr auto;background:radial-gradient(circle at 50% -25%,#25202a 0,transparent 38%),var(--bg)}
    header{height:58px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 22px;background:#0b0f16dd;backdrop-filter:blur(14px)}
    .channel{display:flex;align-items:center;gap:10px}.channel-title{font-weight:680}.badge{display:inline-flex;align-items:center;gap:6px;border:1px solid #4a3a32;background:#211712;color:#ffae88;border-radius:999px;padding:4px 9px;font-size:12px}.dot{width:7px;height:7px;border-radius:50%;background:var(--success);box-shadow:0 0 0 4px #56c59619}.mobile-tabs{display:none;gap:5px}.mobile-tabs button{border:1px solid var(--line);background:#131923;border-radius:8px;padding:6px 8px;font-size:12px}.mobile-tabs button.active{border-color:#70432f;color:#ff9d72}
    .session{color:var(--muted);font:12px ui-monospace,SFMono-Regular,Consolas,monospace;max-width:42vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #messages,.workspace-panel{grid-row:2;overflow:auto;scrollbar-color:#343b49 transparent}#messages{padding:32px max(24px,calc((100% - 850px)/2)) 52px}.workspace-panel{padding:34px max(24px,calc((100% - 920px)/2)) 50px}.workspace-panel[hidden]{display:none}.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:25px}.panel-head h1{font-size:26px;margin:0 0 5px}.panel-head p{margin:0;color:var(--muted)}.panel-action{border:1px solid #3c4555;background:#171d28;border-radius:9px;padding:8px 12px;cursor:pointer}.panel-action:hover{border-color:#5a6476}
    .welcome{max-width:720px;margin:7vh auto 36px;text-align:center}.welcome .hero-logo{width:58px;height:58px;margin:0 auto 18px;display:grid;place-items:center;border-radius:18px;background:linear-gradient(135deg,#ff9a66,#db441e);font-size:30px;box-shadow:0 18px 45px #f26b3828}.welcome h1{font-size:28px;line-height:1.2;margin:0 0 10px}.welcome p{color:var(--muted);margin:0 auto 22px;max-width:600px}
    .flow{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:7px;color:#b8c0ce;font-size:12px}.flow span{border:1px solid var(--line);background:#111620;border-radius:8px;padding:7px 10px}.flow b{color:#596274;font-weight:400}
    .message{display:grid;grid-template-columns:34px minmax(0,1fr);gap:12px;max-width:850px;margin:0 auto 24px}.avatar{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:#1d2330;border:1px solid #323a4a}.message.user .avatar{background:#392016;border-color:#603421}.message-head{display:flex;align-items:center;gap:8px;height:24px;margin-bottom:5px}.message-head strong{font-size:13px}.message-head time{font-size:11px;color:#687286}.bubble{white-space:pre-wrap;overflow-wrap:anywhere}.message.user .bubble{background:#151a24;border:1px solid var(--line);border-radius:4px 14px 14px 14px;padding:12px 14px;width:max-content;max-width:100%}.message.assistant .bubble{padding:3px 1px;color:#e7ebf2}
    .pending{display:inline-flex;align-items:center;gap:8px;color:var(--muted)}.typing{display:flex;gap:4px}.typing i{width:5px;height:5px;background:#8993a5;border-radius:50%;animation:pulse 1.1s infinite}.typing i:nth-child(2){animation-delay:.16s}.typing i:nth-child(3){animation-delay:.32s}@keyframes pulse{0%,70%,100%{opacity:.28;transform:translateY(0)}35%{opacity:1;transform:translateY(-3px)}}
    .trace{margin:0 0 14px;border:0;background:transparent}.trace>summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:7px;width:max-content;max-width:100%;padding:5px 2px 8px;color:#aab4c4;font-size:12px;font-weight:650}.trace>summary::-webkit-details-marker{display:none}.trace>summary:before{content:'›';font-size:17px;line-height:1;color:#697487;transition:transform .15s}.trace[open]>summary:before{transform:rotate(90deg)}.trace-title-icon{font-size:14px}.trace-count{color:#687386;font-weight:400}.trace-list{padding:1px 0 0 5px}.trace-event{position:relative;display:grid;grid-template-columns:29px minmax(0,1fr);gap:9px;padding:2px 0 12px}.trace-event:not(:last-child):before{content:'';position:absolute;left:14px;top:29px;bottom:-1px;width:1px;background:#2a3240}.trace-node{position:relative;z-index:1;width:29px;height:29px;border:1px solid #303949;border-radius:9px;background:#151b25;display:grid;place-items:center}.trace-icon{font-size:13px;filter:saturate(.8)}.trace-status{position:absolute;right:-3px;bottom:-3px;width:13px;height:13px;border:2px solid var(--bg);border-radius:50%;background:var(--success);color:#07110c;display:grid;place-items:center;font:700 8px/1 system-ui}.trace-event.failed .trace-status{background:var(--danger);color:#26070b}.trace-event.running .trace-status{background:#d8a95b;color:#251805}.trace-main{min-width:0;padding-top:3px}.trace-event-head{display:flex;align-items:baseline;gap:8px;min-height:23px}.trace-label{min-width:0;color:#b8c1cf;font-size:12px;overflow-wrap:anywhere}.trace-event.failed .trace-label{color:#ff9ba4}.trace-duration{margin-left:auto;color:#657084;font:11px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap}.trace-event-detail{margin-top:2px}.trace-event-detail>summary{cursor:pointer;list-style:none;width:20px;height:18px;color:#6f7a8d;display:grid;place-items:center;border-radius:5px}.trace-event-detail>summary::-webkit-details-marker{display:none}.trace-event-detail>summary:after{content:'›';font-size:17px;line-height:1;transition:transform .15s}.trace-event-detail[open]>summary:after{transform:rotate(90deg);color:#e88a62}.trace-event-detail-body{margin:3px 0 1px;padding:9px 11px;border-left:2px solid #3b4658;border-radius:0 8px 8px 0;background:#0e131b;color:#929daf;font-size:12px;line-height:1.65;overflow-wrap:anywhere}.trace-event-detail-body p{margin:0}.trace-event-detail-body p+p{margin-top:5px}.error-text{color:var(--danger)}
    .skill-section+.skill-section{margin-top:30px;padding-top:25px;border-top:1px solid var(--line)}.skill-section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin-bottom:14px}.skill-section-head h2{margin:0 0 3px;font-size:17px}.skill-section-head p{margin:0;color:var(--muted);font-size:12px}.skill-toolbar{display:flex;align-items:center;gap:8px}.skill-toolbar input{width:170px;border:1px solid #303848;background:#0c1119;color:var(--text);border-radius:8px;padding:8px 10px;outline:0}.skill-toolbar input:focus{border-color:#626d82}.skill-toolbar button{border:1px solid #3c4555;background:#171d28;border-radius:8px;padding:8px 11px;cursor:pointer}.mysql-status{min-height:20px;color:var(--muted);font-size:12px;margin-bottom:10px}.mysql-status.error-text{color:var(--danger)}.skill-empty{grid-column:1/-1;border:1px dashed #303848;border-radius:11px;padding:22px;text-align:center;color:var(--muted)}
    .skill-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.skill-card{border:1px solid var(--line);background:#111620;border-radius:13px;padding:15px;text-align:left;cursor:pointer;min-height:128px}.skill-card:hover{border-color:#596375;background:#151b26}.skill-card.selected{border-color:#a75836;box-shadow:inset 0 0 0 1px #a75836}.skill-card strong{display:block;margin:8px 0 4px}.skill-card small{color:var(--muted);display:block}.skill-icon{width:32px;height:32px;border-radius:9px;background:#24202b;display:grid;place-items:center}.skill-slug{margin-top:12px;color:#697488;font:10px ui-monospace,SFMono-Regular,Consolas,monospace;overflow:hidden;text-overflow:ellipsis}.active-skill{display:inline-flex;align-items:center;gap:6px;color:#ffae88;border:1px solid #5c392c;background:#211713;border-radius:999px;padding:3px 8px;font-size:11px}.active-skill[hidden]{display:none}
    .schedule-layout{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(240px,.7fr);gap:16px}.schedule-card{border:1px solid var(--line);background:#111620;border-radius:14px;padding:17px}.schedule-card h2{font-size:16px;margin:0 0 14px}.field{display:grid;gap:6px;margin-bottom:13px}.field label{font-size:12px;color:#aeb7c7}.field input,.field select,.field textarea{width:100%;border:1px solid #303848;background:#0c1119;color:var(--text);border-radius:9px;padding:10px 11px;outline:0}.field textarea{min-height:105px;resize:vertical}.field input:focus,.field select:focus,.field textarea:focus{border-color:#626d82}.primary{width:100%;border:0;background:var(--accent);border-radius:9px;padding:10px 12px;cursor:pointer}.primary:hover{background:var(--accent2)}.schedule-tip{color:var(--muted);font-size:12px}.quick-list{display:grid;gap:9px;margin-top:15px}.quick-item{border:1px solid var(--line);border-radius:9px;padding:10px;color:#b8c0ce;font-size:12px}
    .composer-shell{grid-row:3;padding:0 max(24px,calc((100% - 850px)/2)) 18px;background:linear-gradient(transparent,#080b12 24%)}.composer-shell[hidden]{display:none}.composer{border:1px solid #303847;background:#111620;border-radius:16px;box-shadow:0 16px 55px #0007;transition:border-color .15s}.composer:focus-within{border-color:#5d6678}.composer textarea{width:100%;min-height:54px;max-height:180px;resize:none;border:0;outline:0;background:transparent;color:var(--text);padding:15px 15px 5px}.composer textarea::placeholder{color:#687286}.composer-tools{display:flex;align-items:center;justify-content:space-between;padding:7px 9px 9px 13px}.composer-meta{display:flex;align-items:center;gap:7px;min-width:0}.ingress{font-size:11px;color:#7d879a}.send{width:34px;height:34px;border:0;border-radius:10px;background:var(--accent);display:grid;place-items:center;cursor:pointer;font-size:17px;flex:0 0 auto}.send:hover{background:var(--accent2)}.send:disabled{opacity:.38;cursor:not-allowed}.hint{text-align:center;color:#5f697c;font-size:11px;margin-top:8px}
    @media(max-width:760px){:root{--sidebar:0px}aside{display:none}.channel,.session{display:none}.mobile-tabs{display:flex}header{padding:0 10px}.workspace-panel,#messages,.composer-shell{padding-left:16px;padding-right:16px}.welcome{margin-top:3vh}.schedule-layout{grid-template-columns:1fr}.panel-head{display:block}.panel-action{margin-top:12px}.skill-section-head{display:block}.skill-toolbar{margin-top:10px}.skill-toolbar input{min-width:0;flex:1}}
  </style>
</head>
<body>
<div class="app">
  <aside>
    <div class="brand"><span class="logo">🦞</span><span>OpenClaw</span></div>
    <button id="new-chat" class="new-chat" type="button"><span>＋</span> 新会话</button>
    <nav aria-label="本地调试导航">
      <button class="nav-item active" type="button" data-panel="chat"><span class="nav-icon">◫</span>聊天</button>
      <button class="nav-item" type="button" data-panel="skills"><span class="nav-icon">✦</span>Skills</button>
      <button class="nav-item" type="button" data-panel="schedule"><span class="nav-icon">◷</span>定时任务</button>
    </nav>
    <section class="side-card">
      <strong>本地会话隔离</strong>
      <p>网页消息会先封装为 RabbitMQ envelope，再进入 consumer 与 agent pipeline。</p>
      <div class="safe"><span class="dot"></span>扩展能力对齐部署环境</div>
      <p>复用现有 MySQL 与 Milvus；聊天历史隔离到 <code>history_test</code>，RabbitMQ 测试队列为 <code>MessageTest</code>。</p>
    </section>
  </aside>
  <main>
    <header>
      <div class="channel"><span id="view-title" class="channel-title">RabbitMQ 本地通道</span><span class="badge"><span class="dot"></span>通过 RabbitMQ 管道进入</span></div>
      <div class="mobile-tabs"><button class="active" type="button" data-panel="chat">聊天</button><button type="button" data-panel="skills">Skills</button><button type="button" data-panel="schedule">任务</button></div>
      <div id="session-id" class="session"></div>
    </header>
    <section id="messages" aria-live="polite"></section>
    <section id="skills-panel" class="workspace-panel" hidden>
      <div class="panel-head"><div><h1>Skills</h1><p>内置 Skill 与 MySQL“我的 Skills”都会随 RabbitMQ 消息进入同一条 consumer pipeline。</p></div><button id="clear-skill" class="panel-action" type="button">使用自动选择</button></div>
      <section class="skill-section">
        <div class="skill-section-head"><div><h2>内置 Skills</h2><p>单选，通过 <code>builtin_skill_name</code> 进入。</p></div></div>
        <div class="skill-grid">
          <button class="skill-card" type="button" data-skill="ai-public-opinion-brief"><span class="skill-icon">▤</span><strong>AI 舆情简报</strong><small>按简报工作流完成检索、研判与结构化输出。</small><span class="skill-slug">ai-public-opinion-brief</span></button>
          <button class="skill-card" type="button" data-skill="gov-public-opinion-analysis-agent"><span class="skill-icon">⌘</span><strong>政务舆情分析</strong><small>生成正式的政务舆情分析与处置建议。</small><span class="skill-slug">gov-public-opinion-analysis-agent</span></button>
          <button class="skill-card" type="button" data-skill="infringement-judgment"><span class="skill-icon">⚖</span><strong>企业侵权判定</strong><small>针对企业主体进行侵权风险判断和证据整理。</small><span class="skill-slug">infringement-judgment</span></button>
          <button class="skill-card" type="button" data-skill="institution-violation-judgment"><span class="skill-icon">◇</span><strong>机构违规研判</strong><small>分析非企业机构内容的违规风险和报告路径。</small><span class="skill-slug">institution-violation-judgment</span></button>
          <button class="skill-card" type="button" data-skill="ai-collaboration-diagnostic"><span class="skill-icon">◎</span><strong>AI 协作诊断</strong><small>诊断人与 AI 的协作流程并给出改进方案。</small><span class="skill-slug">ai-collaboration-diagnostic</span></button>
        </div>
      </section>
      <section class="skill-section">
        <div class="skill-section-head"><div><h2>MySQL · 我的 Skills</h2><p>可多选，只读取当前 user_id 下已启用技能的名称与说明。</p></div><div class="skill-toolbar"><input id="mysql-user-id" aria-label="MySQL user_id" value="local-user" placeholder="user_id"><button id="refresh-mysql-skills" type="button">读取技能</button></div></div>
        <div id="mysql-skill-status" class="mysql-status">输入真实 user_id 后读取 MySQL 技能。</div>
        <div id="mysql-skills" class="skill-grid"><div class="skill-empty">尚未读取 MySQL 技能</div></div>
      </section>
    </section>
    <section id="schedule-panel" class="workspace-panel" hidden>
      <div class="panel-head"><div><h1>定时任务</h1><p>任务指令会先回到聊天区供你确认，再通过 RabbitMQ 管道交给 OpenClaw 的 cron 工具执行。</p></div><button id="schedule-list" class="panel-action" type="button">查看现有任务</button></div>
      <div class="schedule-layout">
        <section class="schedule-card">
          <h2>创建任务草稿</h2>
          <div class="field"><label for="schedule-name">任务名称</label><input id="schedule-name" placeholder="例如：每日舆情简报"></div>
          <div class="field"><label for="schedule-preset">执行时间</label><select id="schedule-preset"><option value="每天 09:00（Asia/Shanghai）">每天 09:00</option><option value="每个工作日 09:00（Asia/Shanghai）">工作日 09:00</option><option value="每小时整点">每小时</option><option value="每 30 分钟">每 30 分钟</option></select></div>
          <div class="field"><label for="schedule-prompt">任务内容</label><textarea id="schedule-prompt" placeholder="描述定时任务要执行的工作"></textarea></div>
          <button id="schedule-draft" class="primary" type="button">生成指令并去聊天确认</button>
        </section>
        <section class="schedule-card">
          <h2>仍然走真实入口</h2>
          <p class="schedule-tip">页面不会直接改写 cron 存储。创建、查看、启停和删除都由 OpenClaw 在 RabbitMQ 对话中调用定时任务工具完成。</p>
          <div class="quick-list"><div class="quick-item">① 在这里填写任务草稿</div><div class="quick-item">② 回到聊天确认指令</div><div class="quick-item">③ RabbitMQ → agent → cron tool</div></div>
        </section>
      </div>
    </section>
    <div id="composer-shell" class="composer-shell">
      <div class="composer">
        <textarea id="composer" rows="1" aria-label="输入消息" placeholder="发送一条 RabbitMQ 入站测试消息…"></textarea>
        <div class="composer-tools"><div class="composer-meta"><span id="ingress" class="ingress">RabbitMQ envelope · local-user · memory off</span><span id="active-skill" class="active-skill" hidden></span></div><button id="send" class="send" type="button" aria-label="发送消息">↑</button></div>
      </div>
      <div class="hint">Enter 发送 · Shift + Enter 换行 · 仅展示脱敏过程，不展示隐藏推理原文</div>
    </div>
  </main>
</div>
<template id="trace-template"><details class="trace"></details></template>
<script>
  const messages=document.querySelector('#messages');
  const composer=document.querySelector('#composer');
  const send=document.querySelector('#send');
  const newChat=document.querySelector('#new-chat');
  const sessionLabel=document.querySelector('#session-id');
  const viewTitle=document.querySelector('#view-title');
  const composerShell=document.querySelector('#composer-shell');
  const skillsPanel=document.querySelector('#skills-panel');
  const schedulePanel=document.querySelector('#schedule-panel');
  const activeSkill=document.querySelector('#active-skill');
  const ingress=document.querySelector('#ingress');
  const mysqlUserId=document.querySelector('#mysql-user-id');
  const mysqlSkills=document.querySelector('#mysql-skills');
  const mysqlSkillStatus=document.querySelector('#mysql-skill-status');
  const MAX_HISTORY_ID=2147483647;
  let sessionId=createSessionId();
  let nextHistoryId=createHistoryId();
  let selectedSkill='';
  let selectedCustomSkillIds=[];
  let mysqlSkillsById=new Map();
  let busy=false;

  function createSessionId(){return 'local-'+crypto.randomUUID();}
  function createHistoryId(){const values=new Uint32Array(1);crypto.getRandomValues(values);return (values[0]%MAX_HISTORY_ID)+1;}
  function takeHistoryId(){const id=nextHistoryId;nextHistoryId=id>=MAX_HISTORY_ID?createHistoryId():id+1;return id;}
  function now(){return new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});}
  function updateSessionLabel(){sessionLabel.textContent='session: '+sessionId;sessionLabel.title=sessionId;}
  function currentUserId(){return mysqlUserId.value.trim()||'local-user';}
  function updateIngress(){ingress.textContent='RabbitMQ envelope · '+currentUserId()+' · memory off';}
  function showPanel(panel){
    const isChat=panel==='chat';messages.hidden=!isChat;skillsPanel.hidden=panel!=='skills';schedulePanel.hidden=panel!=='schedule';composerShell.hidden=!isChat;
    viewTitle.textContent=panel==='skills'?'Skills':panel==='schedule'?'定时任务':'RabbitMQ 本地通道';
    for(const control of document.querySelectorAll('[data-panel]'))control.classList.toggle('active',control.dataset.panel===panel);
    if(isChat){composer.focus();scrollToBottom();}
  }
  function updateActiveSkill(){
    const selected=document.querySelector('[data-skill="'+selectedSkill+'"]');
    for(const card of document.querySelectorAll('[data-skill]'))card.classList.toggle('selected',card.dataset.skill===selectedSkill);
    for(const card of document.querySelectorAll('[data-mysql-skill-id]'))card.classList.toggle('selected',selectedCustomSkillIds.includes(Number(card.dataset.mysqlSkillId)));
    const customNames=selectedCustomSkillIds.map(id=>mysqlSkillsById.get(id)?.name||('#'+id));
    const label=selectedSkill?'Skill · '+(selected?.querySelector('strong')?.textContent||selectedSkill):customNames.length?'MySQL · '+customNames.join(' + '):'';
    activeSkill.hidden=!label;activeSkill.textContent=label;
  }
  function clearSkillSelection(){selectedSkill='';selectedCustomSkillIds=[];updateActiveSkill();}
  function renderMysqlSkills(skills){
    mysqlSkills.replaceChildren();mysqlSkillsById=new Map(skills.map(skill=>[skill.id,skill]));
    selectedCustomSkillIds=selectedCustomSkillIds.filter(id=>mysqlSkillsById.has(id));
    if(!skills.length){const empty=document.createElement('div');empty.className='skill-empty';empty.textContent='该 user_id 暂无已启用的 MySQL 技能';mysqlSkills.appendChild(empty);updateActiveSkill();return;}
    for(const skill of skills){
      const card=document.createElement('button');card.className='skill-card';card.type='button';card.dataset.mysqlSkillId=String(skill.id);
      const icon=document.createElement('span');icon.className='skill-icon';icon.textContent='DB';
      const name=document.createElement('strong');name.textContent=skill.name||('Skill #'+skill.id);
      const description=document.createElement('small');description.textContent=skill.description||'MySQL 自定义技能';
      const slug=document.createElement('span');slug.className='skill-slug';slug.textContent='skill_id: '+skill.id;
      card.append(icon,name,description,slug);
      card.onclick=()=>{selectedSkill='';const id=skill.id;selectedCustomSkillIds=selectedCustomSkillIds.includes(id)?selectedCustomSkillIds.filter(value=>value!==id):selectedCustomSkillIds.length<20?[...selectedCustomSkillIds,id]:selectedCustomSkillIds;updateActiveSkill();};
      mysqlSkills.appendChild(card);
    }
    updateActiveSkill();
  }
  async function loadMysqlSkills(){
    const userId=currentUserId();updateIngress();clearSkillSelection();
    mysqlSkillStatus.classList.remove('error-text');mysqlSkillStatus.textContent='正在读取 '+userId+' 的 MySQL 技能…';
    try{
      const response=await fetch('${skillsPath}?user_id='+encodeURIComponent(userId));
      const data=await response.json();if(!response.ok)throw new Error(data.error||'读取失败');
      const skills=Array.isArray(data.skills)?data.skills.filter(skill=>Number.isInteger(skill.id)&&skill.id>0&&typeof skill.name==='string'):[];
      renderMysqlSkills(skills);mysqlSkillStatus.textContent='已读取 '+skills.length+' 个已启用技能 · 只读';
    }catch(error){mysqlSkillsById=new Map();selectedCustomSkillIds=[];mysqlSkills.replaceChildren();const empty=document.createElement('div');empty.className='skill-empty';empty.textContent='MySQL 技能暂不可用';mysqlSkills.appendChild(empty);mysqlSkillStatus.classList.add('error-text');mysqlSkillStatus.textContent=String(error);updateActiveSkill();}
  }
  function scrollToBottom(){messages.scrollTop=messages.scrollHeight;}
  function appendText(parent,text){parent.appendChild(document.createTextNode(text));}
  function makeMessage(role,text){
    const article=document.createElement('article');article.className='message '+role;
    const avatar=document.createElement('div');avatar.className='avatar';avatar.textContent=role==='user'?'你':'🦞';
    const body=document.createElement('div');
    const head=document.createElement('div');head.className='message-head';
    const name=document.createElement('strong');name.textContent=role==='user'?'你':'OpenClaw';
    const time=document.createElement('time');time.textContent=now();head.append(name,time);
    const bubble=document.createElement('div');bubble.className='bubble';if(text)appendText(bubble,text);
    body.append(head,bubble);article.append(avatar,body);messages.appendChild(article);scrollToBottom();
    return {article,body,bubble};
  }
  function renderWelcome(){
    messages.innerHTML='';
    const welcome=document.createElement('section');welcome.className='welcome';
    welcome.innerHTML='<div class="hero-logo">🦞</div><h1>用 RabbitMQ 管道和 OpenClaw 对话</h1><p>这里看起来像本地 OpenClaw，但每条消息都会先构造成真实 RabbitMQ 消息，再进入 rabbitmq-consumer 的解析、会话和 agent 流程。</p><div class="flow"><span>网页消息</span><b>→</b><span>RabbitMQ Envelope</span><b>→</b><span>Consumer</span><b>→</b><span>OpenClaw Agent</span></div>';
    messages.appendChild(welcome);
  }
  const TRACE_ICONS={query:'⌕',read:'▤',write:'✎',search:'◎',memory:'◉',check:'◇',report:'▥',schedule:'◷',default:'·'};
  function traceIcon(category){return TRACE_ICONS[category]||TRACE_ICONS.default;}
  function formatTraceLabel(summary,status){
    const label=typeof summary==='string'&&summary.trim()?summary.trim():'执行处理步骤';
    return status==='running'?label:(label.replace(/^(正在|开始)/,'').trim()||label);
  }
  function formatTraceDuration(durationMs){
    if(!Number.isFinite(durationMs)||durationMs<0)return '';
    if(durationMs<1000)return Math.round(durationMs)+'ms';
    if(durationMs<60000)return (durationMs/1000).toFixed(durationMs<10000?1:0)+'s';
    const minutes=Math.floor(durationMs/60000);const seconds=Math.round((durationMs%60000)/1000);
    return minutes+'m'+(seconds?' '+seconds+'s':'');
  }
  function renderTrace(body,traceItems){
    if(!traceItems.length)return;
    const panel=document.querySelector('#trace-template').content.firstElementChild.cloneNode(true);panel.open=true;
    const panelSummary=document.createElement('summary');
    const titleIcon=document.createElement('span');titleIcon.className='trace-title-icon';titleIcon.textContent='🧠';
    const title=document.createElement('span');title.textContent='工作过程';
    const count=document.createElement('span');count.className='trace-count';count.textContent='· '+traceItems.length+' 个步骤';
    panelSummary.append(titleIcon,title,count);panel.appendChild(panelSummary);
    const list=document.createElement('div');list.className='trace-list';
    for(const item of traceItems){
      const narrative=Array.isArray(item.narrative)?item.narrative:[];const hasNarrative=narrative.length>0;
      const row=document.createElement('div');row.className='trace-event';row.classList.toggle('failed',item.status==='failed');row.classList.toggle('running',item.status==='running');row.classList.toggle('expandable',hasNarrative);
      const node=document.createElement('span');node.className='trace-node';
      const icon=document.createElement('span');icon.className='trace-icon';icon.textContent=traceIcon(item.category);
      const status=document.createElement('span');status.className='trace-status';status.textContent=item.status==='failed'?'!':item.status==='running'?'·':'✓';node.append(icon,status);
      const main=document.createElement('div');main.className='trace-main';
      const head=document.createElement('div');head.className='trace-event-head';
      const label=document.createElement('span');label.className='trace-label';label.textContent=formatTraceLabel(item.summary,item.status)+(item.repeatCount>1?' · '+item.repeatCount+' 次':'');
      const duration=document.createElement('span');duration.className='trace-duration';duration.textContent=formatTraceDuration(item.durationMs);head.append(label,duration);main.appendChild(head);
      if(hasNarrative){
        const details=document.createElement('details');details.className='trace-event-detail';
        const detailSummary=document.createElement('summary');detailSummary.setAttribute('aria-label','展开具体工作内容');
        const detailBody=document.createElement('div');detailBody.className='trace-event-detail-body';
        for(const line of narrative){
          const paragraph=document.createElement('p');paragraph.textContent=line;detailBody.appendChild(paragraph);
        }
        details.append(detailSummary,detailBody);main.appendChild(details);
      }
      row.append(node,main);list.appendChild(row);
    }
    panel.appendChild(list);body.insertBefore(panel,body.querySelector('.bubble'));
  }
  function setPending(bubble){
    bubble.innerHTML='<span class="pending"><span class="typing"><i></i><i></i><i></i></span>正在通过 RabbitMQ 管道处理…</span>';
  }
  async function submit(){
    const message=composer.value.trim();if(!message||busy)return;
    busy=true;send.disabled=true;composer.disabled=true;composer.value='';composer.style.height='auto';
    makeMessage('user',message);
    const assistant=makeMessage('assistant','');setPending(assistant.bubble);
    try{
      const payload={id:takeHistoryId(),message,session_id:sessionId,user_id:currentUserId(),use_memory:false,...(selectedSkill?{builtin_skill_name:selectedSkill}:selectedCustomSkillIds.length?{skill_ids:selectedCustomSkillIds}:{})};
      const response=await fetch('${runPath}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});
      const data=await response.json();if(!response.ok)throw new Error(data.error||'运行失败');
      assistant.bubble.textContent=data.response||'（没有返回文本）';renderTrace(assistant.body,Array.isArray(data.trace)?data.trace:[]);
    }catch(error){assistant.bubble.className='bubble error-text';assistant.bubble.textContent=String(error);}
    finally{busy=false;send.disabled=false;composer.disabled=false;composer.focus();scrollToBottom();}
  }
  for(const control of document.querySelectorAll('[data-panel]'))control.onclick=()=>showPanel(control.dataset.panel);
  for(const card of document.querySelectorAll('[data-skill]'))card.onclick=()=>{selectedCustomSkillIds=[];selectedSkill=card.dataset.skill||'';updateActiveSkill();showPanel('chat');};
  document.querySelector('#clear-skill').onclick=()=>clearSkillSelection();
  document.querySelector('#refresh-mysql-skills').onclick=()=>void loadMysqlSkills();
  mysqlUserId.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();void loadMysqlSkills();}};
  mysqlUserId.oninput=()=>updateIngress();
  const prepareScheduledTask=message=>{clearSkillSelection();composer.value=message;showPanel('chat');composer.dispatchEvent(new Event('input'));};
  document.querySelector('#schedule-list').onclick=()=>prepareScheduledTask('请列出当前所有定时任务，包括名称、执行时间、启用状态和任务内容。');
  document.querySelector('#schedule-draft').onclick=()=>{
    const name=document.querySelector('#schedule-name').value.trim();
    const schedule=document.querySelector('#schedule-preset').value;
    const prompt=document.querySelector('#schedule-prompt').value.trim();
    if(!name||!prompt){document.querySelector('#schedule-name').focus();return;}
    prepareScheduledTask('请创建一个定时任务：名称「'+name+'」；执行时间「'+schedule+'」；任务内容「'+prompt+'」。创建前请复述配置并确认使用 Asia/Shanghai 时区；创建后返回任务编号和下次执行时间。');
  };
  newChat.onclick=()=>{if(busy)return;sessionId=createSessionId();nextHistoryId=createHistoryId();updateSessionLabel();renderWelcome();showPanel('chat');};
  send.onclick=()=>void submit();
  composer.onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();void submit();}};
  composer.oninput=()=>{composer.style.height='auto';composer.style.height=Math.min(composer.scrollHeight,180)+'px';};
  updateSessionLabel();updateIngress();updateActiveSkill();renderWelcome();showPanel('chat');
</script>
</body>
</html>`;
}
