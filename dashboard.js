// ── LIVE DATA — injected by Claude via __injectTeamData() ──────────
// TEAMS is populated externally. On first load, localStorage cache is restored.
let TEAMS = {};

// ── PUBLIC INJECT API (called by Claude via javascript_tool) ────────
window.__injectTeamData = function(jsonStr) {
  try {
    const incoming = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
    Object.assign(TEAMS, incoming);
    localStorage.setItem('wbs-teams-cache', JSON.stringify(TEAMS));
    buildTeamSelector();
    switchTeam(currentTeam || Object.keys(TEAMS)[0]);
    const el = document.getElementById('sync-ts');
    if (el) el.textContent = 'Jira sync: ' + new Date().toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) + ' · Live ✓';
  } catch (e) {
    console.error('__injectTeamData failed:', e);
    alert('Inject failed: ' + e.message);
  }
};

// ── TEAM SELECTOR ────────────────────────────────────────────────────
let currentTeam = null;

function switchTeam(key) {
  if (!TEAMS[key]) return;
  currentTeam = key;
  const SD = TEAMS[key];
  const saveKey = 'wbs-' + SD.projectKey + '-' + SD.sprintName;
  const saved = JSON.parse(localStorage.getItem(saveKey) || 'null');
  members = saved ? saved.members : SD.members.map(m => ({ ...m }));
  teamDays = saved ? saved.teamDays : SD.teamDays.map(d => ({ ...d }));
  issues = SD.issues.map(i => ({ ...i }));

  document.getElementById('sprint-name').value = SD.sprintName;
  document.getElementById('hdr-sprint').textContent = SD.sprintName;
  document.getElementById('hdr-team').textContent = SD.team + ' (' + SD.projectKey + ')';
  document.getElementById('start-date').value = SD.startDate;
  document.getElementById('end-date').value = SD.endDate;
  document.getElementById('work-days').value = SD.workDays;
  document.getElementById('hrs-day').value = SD.hrsPerDay;

  const ts = new Date(SD.syncedAt);
  document.getElementById('sync-ts').textContent = 'Jira sync: ' + ts.toLocaleDateString() + ' ' + ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  document.getElementById('team-badge').textContent = key;

  document.querySelectorAll('.team-btn').forEach(b => {
    b.style.background = b.dataset.key === key ? 'var(--green)' : 'var(--bg3)';
    b.style.color = b.dataset.key === key ? '#000' : 'var(--t2)';
    b.style.borderColor = b.dataset.key === key ? 'var(--green)' : 'var(--bdr)';
  });
  renderAll();
}

const AVC = ['#00d4aa','#4da6ff','#a78bfa','#f472b6','#fbbf24','#f87171','#34d399','#60a5fa'];
const AVB = AVC.map(c => c + '22');
function ini(n) { return (n||'').trim().split(/\s+/).map(w=>w[0]||'').join('').toUpperCase().slice(0,2)||'?'; }

let members, teamDays, issues, charts = {}, sortKey = 'key', sortDir = 1;
function getSD() { return TEAMS[currentTeam]; }

// ── TIMEZONE-SAFE DATE HELPERS ───────────────────────────────────────
function parseDate(str) { if (!str) return null; const [y,m,d]=str.split('-').map(Number); return new Date(y,m-1,d); }
function isoDate(d) { return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }

// ── LOAD — restore from cache or show prompt ─────────────────────────
function load() {
  const savedTeams = localStorage.getItem('wbs-teams-cache');
  if (savedTeams) {
    try {
      TEAMS = JSON.parse(savedTeams);
      buildTeamSelector();
      switchTeam(Object.keys(TEAMS)[0]);
      return;
    } catch(e) { /* fall through */ }
  }
  showLoadPrompt();
}

function showLoadPrompt() {
  document.querySelector('.main').innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;gap:20px;text-align:center;padding:40px">
      <div style="font-size:48px">🔄</div>
      <div style="font-size:18px;font-weight:500;color:var(--t1)">No sprint data loaded yet</div>
      <div style="font-size:13px;color:var(--t2);max-width:420px">Ask Claude: <em>"refresh the WBS sprint dashboard"</em><br>Claude will pull live data from Jira and inject it here.</div>
    </div>`;
}

function buildTeamSelector() {
  const tl = document.getElementById('team-selector');
  if (!tl) return;
  tl.innerHTML = '';
  Object.keys(TEAMS).forEach(k => {
    const b = document.createElement('button');
    b.className = 'btn team-btn';
    b.dataset.key = k;
    b.textContent = k;
    b.style.padding = '4px 10px';
    b.style.fontSize = '11px';
    b.style.fontWeight = '600';
    b.onclick = () => switchTeam(k);
    tl.appendChild(b);
  });
}

function saveAll() {
  const s = getSD();
  localStorage.setItem('wbs-'+s.projectKey+'-'+s.sprintName, JSON.stringify({members,teamDays}));
  localStorage.setItem('wbs-teams-cache', JSON.stringify(TEAMS));
  document.getElementById('sync-ts').textContent += ' · Saved ✓';
}

function wd() { return Math.max(1, parseInt(document.getElementById('work-days').value)||9); }
function hd() { return Math.max(1, parseInt(document.getElementById('hrs-day').value)||6); }
function tdo() { return teamDays.length; }
function cap(m) { return Math.max(0, wd()-tdo()-m.pto)*m.hrs; }
function asgnFor(n) { return (getSD().subtaskHrs[n]||{}).est||0; }
function logFor(n) { return (getSD().subtaskHrs[n]||{}).logged||0; }

function memberOpts(sel) {
  return '<option value="Unassigned"'+(!sel||sel==='Unassigned'?' selected':'')+'>Unassigned</option>'
    +members.map(m=>'<option value="'+m.name+'"'+(m.name===sel?' selected':'')+'>'+m.name+'</option>').join('');
}
function removeMember(i) { members.splice(i,1); renderAll(); }
function addMemberPrompt() {
  const n=(prompt('Name:')||'').trim(); if(!n) return;
  if(members.find(m=>m.name===n)){alert(n+' already listed.');return;}
  members.push({name:n,hrs:hd(),pto:0}); renderAll();
}

function renderMembers() {
  const tb = document.getElementById('mtbody');
  tb.innerHTML = members.map((m,i)=>{
    const c=cap(m);
    return '<tr class="dr"><td><div class="mc"><div class="av" style="background:'+AVB[i%8]+';color:'+AVC[i%8]+'">'+ini(m.name)+'</div>'
      +'<input style="background:transparent;border:none;color:var(--t1);font-family:var(--font);font-size:13px;width:130px" value="'+m.name+'" onchange="members['+i+'].name=this.value.trim();renderAll()"></div></td>'
      +'<td class="c"><input class="ni" type="number" min="1" max="12" value="'+m.hrs+'" oninput="members['+i+'].hrs=Math.max(1,+this.value||6);recalc()"></td>'
      +'<td class="c"><input class="ni" type="number" min="0" value="'+m.pto+'" oninput="members['+i+'].pto=Math.max(0,+this.value||0);recalc()"></td>'
      +'<td class="c netc">'+c+'h</td>'
      +'<td class="c" style="color:var(--blue)">'+asgnFor(m.name)+'h</td>'
      +'<td><button class="rb" onclick="removeMember('+i+')">×</button></td></tr>';
  }).join('')
    +'<tr><td colspan="5" style="padding:6px 0"><button class="addl" onclick="addMemberPrompt()">+ Add team member</button></td></tr>';

  const tp=members.reduce((a,m)=>a+m.pto,0);
  const tc=members.reduce((a,m)=>a+cap(m),0);
  document.getElementById('t-pto').textContent=tp;
  document.getElementById('t-cap').textContent=tc+'h';
  const ta=members.reduce((s,m)=>s+asgnFor(m.name),0);
  const el=document.getElementById('t-asgn'); if(el) el.textContent=ta+'h';
}

function sprintDateAttrs() {
  const s=document.getElementById('start-date').value, e=document.getElementById('end-date').value;
  return (s?'min="'+s+'"':'')+' '+(e?'max="'+e+'"':'');
}

function renderTDO() {
  const a=sprintDateAttrs();
  document.getElementById('tdo-list').innerHTML=teamDays.map((d,i)=>
    '<div class="dor">'
    +'<input type="date" class="si2" value="'+d.date+'" '+a+' oninput="teamDays['+i+'].date=this.value;renderTDO();recalc()">'
    +'<select class="si2" oninput="teamDays['+i+'].type=this.value">'
    +'<option '+(d.type==='Holiday'?'selected':'')+'>Holiday</option>'
    +'<option '+(d.type==='Recharge'?'selected':'')+'>Recharge</option>'
    +'<option '+(d.type==='Company'?'selected':'')+'>Company</option></select>'
    +'<input type="text" class="si2" value="'+(d.note||'')+'" placeholder="Note..." oninput="teamDays['+i+'].note=this.value">'
    +'<button class="rb" onclick="teamDays.splice('+i+',1);renderTDO();recalc()">×</button></div>'
  ).join('');
  document.getElementById('tdo-chip').textContent=teamDays.length+' day'+(teamDays.length!==1?'s':'');
}

function addTDO() {
  const s=document.getElementById('start-date').value||getSD().startDate;
  const e=document.getElementById('end-date').value||getSD().endDate;
  const ex=new Set(teamDays.map(d=>d.date));
  let cur=parseDate(s); const end=parseDate(e); let sg='';
  while(cur<=end){const iso=isoDate(cur);if(cur.getDay()!==0&&cur.getDay()!==6&&!ex.has(iso)){sg=iso;break;}cur.setDate(cur.getDate()+1);}
  teamDays.push({date:sg,type:'Holiday',note:''});
  renderTDO(); recalc();
}

function setSort(k) { if(sortKey===k)sortDir*=-1;else{sortKey=k;sortDir=1;}renderIssues(); }
function sortedIssues() {
  const ord={Done:3,'In Progress':2,Blocked:1,Open:0};
  return [...issues].sort((a,b)=>{
    let av,bv;
    if(sortKey==='status'){av=ord[a.status]||0;bv=ord[b.status]||0;}
    else if(sortKey==='est'){av=a.est||0;bv=b.est||0;}
    else if(sortKey==='assignee'){av=a.assignee||'';bv=b.assignee||'';}
    else{av=a.key;bv=b.key;}
    return av<bv?-sortDir:av>bv?sortDir:0;
  });
}

function renderIssues() {
  const hdr=document.getElementById('issues-hdr');
  const ar=k=>sortKey===k?(sortDir>0?' ▲':' ▼'):'';
  if(hdr) hdr.innerHTML='<th style="width:78px;cursor:pointer" onclick="setSort(\'key\')">Issue'+ar('key')+'</th>'
    +'<th style="width:55px">Type</th><th>Summary</th>'
    +'<th style="width:125px;cursor:pointer" onclick="setSort(\'assignee\')">Assignee'+ar('assignee')+'</th>'
    +'<th class="c" style="width:65px;cursor:pointer" onclick="setSort(\'est\')">Est hrs'+ar('est')+'</th>'
    +'<th class="c" style="width:58px">Logged</th>'
    +'<th class="c" style="width:80px">Remaining</th>'
    +'<th style="width:108px;cursor:pointer" onclick="setSort(\'status\')">Status'+ar('status')+'</th>';

  const si={Done:'✅','In Progress':'🔄',Open:'📋',Blocked:'🚫'};
  const sc={Done:'s-done','In Progress':'s-prog',Open:'s-open',Blocked:'s-blok'};

  document.getElementById('issues-tbody').innerHTML=sortedIssues().map(iss=>{
    const i=issues.indexOf(iss);
    const rem=Math.max(0,(iss.est||0)-(iss.logged||0));
    const pct=iss.est>0?Math.round((iss.logged||0)/iss.est*100):0;
    return '<tr class="dr">'
      +'<td><span class="jkey">'+iss.key+'</span></td>'
      +'<td style="font-size:11px;color:var(--t3)">'+iss.type+'</td>'
      +'<td style="font-size:12px">'+iss.summary+(iss.subtasks?'<div style="font-size:10px;color:var(--t3);margin-top:2px">'+iss.subtasks+'</div>':'')+'</td>'
      +'<td><select class="si2" style="width:120px" onchange="issues['+i+'].assignee=this.value;recalc()">'+memberOpts(iss.assignee)+'</select></td>'
      +'<td class="c"><input class="ni" type="number" min="0" step="0.5" value="'+(iss.est||0)+'" oninput="issues['+i+'].est=+this.value;recalc()"></td>'
      +'<td class="c" style="color:var(--t2)">'+(iss.logged||'—')+'</td>'
      +'<td class="c"><div style="font-size:12px;font-weight:500;color:'+(rem>0?'var(--amber)':'var(--green)')+'">'+rem+'h</div>'
      +'<div style="font-size:10px;color:var(--t3)">'+pct+'% done</div></td>'
      +'<td class="'+(sc[iss.status]||'s-open')+'">'+(si[iss.status]||'📋')
      +' <select style="background:transparent;border:none;color:inherit;font-size:12px;cursor:pointer" onchange="issues['+i+'].status=this.value;renderAll()">'
      +'<option '+(iss.status==='Open'?'selected':'')+'>Open</option>'
      +'<option '+(iss.status==='In Progress'?'selected':'')+'>In Progress</option>'
      +'<option '+(iss.status==='Done'?'selected':'')+'>Done</option>'
      +'<option '+(iss.status==='Blocked'?'selected':'')+'>Blocked</option>'
      +'</select></td></tr>';
  }).join('');

  const te=issues.reduce((a,i)=>a+(+i.est||0),0);
  const tl=issues.reduce((a,i)=>a+(+i.logged||0),0);
  const totalCount=issues.length, doneCount=issues.filter(i=>i.status==='Done').length;
  const pc=totalCount>0?Math.round(doneCount/totalCount*100):0;
  document.getElementById('i-est').textContent=Math.round(te*10)/10||0;
  document.getElementById('i-log').textContent=Math.round(tl*10)/10||0;
  document.getElementById('i-rem').textContent=(Math.round(Math.max(0,te-tl)*10)/10||0)+'h · '+pc+'% done';
}

function renderAvail() {
  document.getElementById('avail-list').innerHTML=members.map(m=>{
    const c=cap(m),a=asgnFor(m.name),p=c>0?Math.min(100,Math.round(a/c*100)):0;
    const col=p>100?'var(--red)':p>80?'var(--amber)':'var(--green)';
    return '<div class="ar">'
      +'<div class="ar-hd"><span style="color:var(--t2);font-size:12px">'+m.name+'</span>'
      +'<span style="color:var(--t3);font-size:11px">'+a+' / '+c+' hrs ('+p+'%)</span></div>'
      +'<div class="ar-bg"><div class="ar-fill" style="width:'+p+'%;background:'+col+'"></div></div></div>';
  }).join('');
  if(charts.cap){charts.cap.destroy();charts.cap=null;}
  const cc=document.getElementById('cap-chart'); if(cc) cc.style.display='none';
}

// ── CALENDAR ─────────────────────────────────────────────────────────
function renderCal() {
  const el=document.getElementById('cal-grid');
  const startStr=document.getElementById('start-date').value;
  const endStr=document.getElementById('end-date').value;
  if(!startStr||!endStr){el.innerHTML='';return;}
  const s=parseDate(startStr),e=parseDate(endStr);
  if(!s||!e||isNaN(s)||isNaN(e)){el.innerHTML='';return;}
  const todayIso=isoDate(new Date());
  const offDates=new Set(teamDays.map(d=>d.date));
  let h=['Su','Mo','Tu','We','Th','Fr','Sa'].map(d=>'<div class="cdl">'+d+'</div>').join('');
  for(let i=0;i<s.getDay();i++) h+='<div class="cd"></div>';
  let wc=0; const cur=new Date(s);
  while(cur<=e){
    const dow=cur.getDay(), iso=isoDate(cur);
    const isToday=iso===todayIso, isOff=offDates.has(iso), isWeekend=dow===0||dow===6;
    const isPast=iso<todayIso&&!isToday;
    const ti=teamDays.find(d=>d.date===iso);
    const ttl=ti?ti.type+(ti.note?' — '+ti.note:''):iso;
    if(!isWeekend&&!isOff) wc++;
    let cls='cd',ex='';
    if(isToday) cls+=' today';
    else if(isOff) cls+=' off';
    else if(isWeekend){/* blank */}
    else if(isPast){cls+=' work';ex=' style="opacity:.38"';}
    else cls+=' work';
    h+='<div class="'+cls+'"'+ex+' title="'+ttl+'">'+cur.getDate()+'</div>';
    cur.setDate(cur.getDate()+1);
  }
  el.innerHTML=h;
  const w=document.getElementById('work-days'); if(w&&wc>0) w.value=wc;
}

// ── BURNDOWN ──────────────────────────────────────────────────────────
function renderBurndown() {
  const sd=getSD();
  const startStr=document.getElementById('start-date').value||(sd&&sd.startDate)||'';
  const endStr=document.getElementById('end-date').value||(sd&&sd.endDate)||'';
  const s=parseDate(startStr), e=parseDate(endStr);
  if(!s||!e) return;
  const todayIso=isoDate(new Date());
  const off=new Set(teamDays.map(d=>d.date));
  const workDays=[]; const cur=new Date(s);
  while(cur<=e){
    const dow=cur.getDay(), iso=isoDate(cur);
    if(dow!==0&&dow!==6&&!off.has(iso)) workDays.push(iso);
    cur.setDate(cur.getDate()+1);
  }
  if(!workDays.length) return;
  const totalIssues=issues.length;
  const doneCount=issues.filter(i=>i.status==='Done').length;
  const openCount=totalIssues-doneCount;
  const n=workDays.length;
  const ideal=workDays.map((_,i)=>Math.round(totalIssues*(1-i/Math.max(n-1,1))*10)/10);
  const pivotIdx=workDays.findIndex(d=>d>=todayIso);
  const pivot=pivotIdx===-1?n-1:pivotIdx;
  const actual=workDays.map((day,i)=>{
    if(i>pivot) return null;
    if(i===pivot) return openCount;
    if(pivot===0) return totalIssues;
    return Math.round((totalIssues-(totalIssues-openCount)*(i/pivot))*10)/10;
  });
  const labels=workDays.map(d=>{const[,m,day]=d.split('-');return parseInt(m)+'/'+parseInt(day);});
  if(charts.bd) charts.bd.destroy();
  charts.bd=new Chart(document.getElementById('burndown-chart'),{
    type:'line',
    data:{labels,datasets:[
      {label:'Ideal',data:ideal,borderColor:'rgba(77,166,255,.45)',borderDash:[5,5],borderWidth:1.5,pointRadius:0,fill:false,tension:0},
      {label:'Actual',data:actual,borderColor:'#00d4aa',backgroundColor:'rgba(0,212,170,.08)',borderWidth:2,pointRadius:3,pointBackgroundColor:'#00d4aa',fill:true,tension:0,spanGaps:false}
    ]},
    options:{
      responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+': '+ctx.raw+' issues remaining'}}},
      scales:{
        x:{grid:{color:'rgba(255,255,255,.04)'},ticks:{color:'#5a6580',font:{size:10},maxTicksLimit:8}},
        y:{grid:{color:'rgba(255,255,255,.04)'},ticks:{color:'#5a6580',font:{size:10},stepSize:1,precision:0},min:0,max:Math.max(5,totalIssues),
          title:{display:true,text:'Issues remaining',color:'#5a6580',font:{size:10}}}
      }
    }
  });
}

// ── RECALC ────────────────────────────────────────────────────────────
function recalc() {
  const tc=members.reduce((a,m)=>a+cap(m),0);
  const ta=members.reduce((a,m)=>a+asgnFor(m.name),0);
  const tp=members.reduce((a,m)=>a+m.pto,0)+tdo();
  const util=tc>0?Math.round(ta/tc*100):0;
  const totalCount=issues.length, doneCount=issues.filter(i=>i.status==='Done').length;
  const pct=totalCount>0?Math.round(doneCount/totalCount*100):0;
  document.getElementById('k-cap').textContent=tc;
  document.getElementById('k-asgn').textContent=ta;
  document.getElementById('k-rem').textContent=pct+'%';
  document.getElementById('k-rem-sub').textContent=doneCount+' of '+totalCount+' issues done';
  document.getElementById('k-util').textContent=util+'%';
  document.getElementById('k-pto').textContent=tp;
  renderMembers(); renderAvail(); renderCal(); renderBurndown();
}

// ── JIRA REFRESH BUTTON — tells user to ask Claude ───────────────────
async function refreshFromJira() {
  const btn=document.getElementById('refresh-btn');
  if(btn){btn.textContent='Ask Claude ↗';btn.disabled=false;}
  alert('To refresh sprint data, ask Claude:\n"Refresh the WBS sprint dashboard"\n\nClaude will pull live data from Jira via MCP and inject it directly into this page.');
}

function renderAll() { renderTDO(); renderIssues(); recalc(); }
load();
