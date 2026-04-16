const SD={"team": "Webslingers", "projectKey": "WBS", "sprintName": "WBS 2026 Q2S2", "startDate": "2026-04-15", "endDate": "2026-04-29", "workDays": 10, "hrsPerDay": 6, "syncedAt": "2026-04-16T15:30:00Z", "members": [{"name": "Julia Lukas", "hrs": 6, "pto": 0}, {"name": "David Swiezy", "hrs": 6, "pto": 0}, {"name": "Jeremy Goodman", "hrs": 6, "pto": 0}, {"name": "Joi Hepler", "hrs": 6, "pto": 0}, {"name": "Matt Glick", "hrs": 6, "pto": 0}, {"name": "Suvarna Damarla", "hrs": 6, "pto": 0}, {"name": "Yudong He", "hrs": 6, "pto": 0}], "teamDays": [{"date": "2026-04-24", "type": "Recharge", "note": ""}], "issues": [{"key": "WBS-66", "type": "Task", "summary": "Migrate Daily Scrum Report Claude Skill from Azure DevOps to Jira", "assignee": "Yudong He", "est": 0, "logged": 2, "status": "Done", "subtasks": ""}, {"key": "WBS-63", "type": "Bug", "summary": "Bug 8867850: Practice Performance - Filter Search - Case Sensitive", "assignee": "Unassigned", "est": 1, "logged": 0, "status": "Open", "subtasks": "WBS-64 ✅ WBS-65 🔄"}, {"key": "WBS-52", "type": "Story", "summary": "Meta Tasks", "assignee": "Unassigned", "est": 32, "logged": 8, "status": "Open", "subtasks": "WBS-53 🔄"}, {"key": "WBS-50", "type": "Bug", "summary": "Bug 8867869: Practice Performance - AR Measures - 500 Internal Server Error", "assignee": "Yudong He", "est": 8, "logged": 2, "status": "Open", "subtasks": "WBS-54 ✅ WBS-55 📋"}, {"key": "WBS-45", "type": "Story", "summary": "Pract Perf: AR measures lookback - pass lookback parameter from UI", "assignee": "Unassigned", "est": 3, "logged": 0, "status": "Open", "subtasks": "WBS-56 ✅ WBS-57 ✅ WBS-58 ✅ WBS-59 📋"}, {"key": "WBS-39", "type": "Story", "summary": "PractPerf Single EOB - Spike - Research to gain understanding of requirements", "assignee": "Unassigned", "est": 20, "logged": 0, "status": "Open", "subtasks": "WBS-60 📋 WBS-61 🔄"}, {"key": "WBS-24", "type": "Story", "summary": "AR Measures Performance Tuning", "assignee": "Yudong He", "est": 20, "logged": 0, "status": "Open", "subtasks": "WBS-25 🔄 WBS-26 📋 WBS-27 📋"}, {"key": "WBS-14", "type": "Story", "summary": "26.1.1 Pract Perf Testing / Deployment DEV02", "assignee": "Unassigned", "est": 38, "logged": 0, "status": "Open", "subtasks": "8 subtasks (mixed)"}]};
const AVC=['#00d4aa','#4da6ff','#a78bfa','#f472b6','#fbbf24','#f87171','#34d399','#60a5fa'];
const AVB=AVC.map(c=>c+'22');
function ini(n){return(n||'').trim().split(/\s+/).map(w=>w[0]||'').join('').toUpperCase().slice(0,2)||'?'}
let members,teamDays,issues,charts={};

function load(){
  const saved=JSON.parse(localStorage.getItem('wbs-'+SD.projectKey+'-'+SD.sprintName)||'null');
  members=saved?saved.members:SD.members.map(m=>({...m}));
  teamDays=saved?saved.teamDays:SD.teamDays.map(d=>({...d}));
  issues=SD.issues.map(i=>({...i}));
  document.getElementById('sprint-name').value=SD.sprintName;
  document.getElementById('hdr-sprint').textContent=SD.sprintName;
  document.getElementById('hdr-team').textContent=SD.team+' ('+SD.projectKey+')';
  document.getElementById('start-date').value=SD.startDate;
  document.getElementById('end-date').value=SD.endDate;
  document.getElementById('work-days').value=SD.workDays;
  document.getElementById('hrs-day').value=SD.hrsPerDay;
  const ts=new Date(SD.syncedAt);
  document.getElementById('sync-ts').textContent='Jira sync: '+ts.toLocaleDateString()+' '+ts.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  renderAll();
}

function saveAll(){
  localStorage.setItem('wbs-'+SD.projectKey+'-'+SD.sprintName,JSON.stringify({members,teamDays}));
  document.getElementById('sync-ts').textContent+=' · Saved ✓';
}

function wd(){return Math.max(1,parseInt(document.getElementById('work-days').value)||10)}
function hd(){return Math.max(1,parseInt(document.getElementById('hrs-day').value)||6)}
function tdo(){return teamDays.length}
function cap(m){return Math.max(0,wd()-tdo()-m.pto)*m.hrs}
function asgnFor(n){return issues.filter(i=>i.assignee===n).reduce((a,i)=>a+(+i.est||0),0)}
function logFor(n){return issues.filter(i=>i.assignee===n).reduce((a,i)=>a+(+i.logged||0),0)}

function renderMembers(){
  document.getElementById('mtbody').innerHTML=members.map((m,i)=>{
    const c=cap(m),a=asgnFor(m.name),l=logFor(m.name),rem=Math.max(0,a-l),over=a>c&&c>0;
    return'<tr class="dr"><td><div class="mc"><div class="av" style="background:'+AVB[i%AVB.length]+';color:'+AVC[i%AVC.length]+'">'+ini(m.name)+'</div><span>'+m.name+'</span></div></td>'+
    '<td class="c"><input class="ni" type="number" min="1" max="12" value="'+m.hrs+'" oninput="members['+i+'].hrs=Math.max(1,+this.value||6);recalc()"></td>'+
    '<td class="c"><input class="ni" type="number" min="0" value="'+m.pto+'" oninput="members['+i+'].pto=Math.max(0,+this.value||0);recalc()"></td>'+
    '<td class="c '+( over?'overc':'netc')+'">'+c+'</td>'+
    '<td class="c">'+a+'</td>'+
    '<td class="c" style="color:'+( rem>0?'var(--amber)':'var(--green)')+'">'+rem+'</td></tr>';
  }).join('');
  const tp=members.reduce((a,m)=>a+m.pto,0);
  const tc=members.reduce((a,m)=>a+cap(m),0);
  const ta=members.reduce((a,m)=>a+asgnFor(m.name),0);
  const tl=members.reduce((a,m)=>a+logFor(m.name),0);
  document.getElementById('t-pto').textContent=tp;
  document.getElementById('t-cap').textContent=tc;
  document.getElementById('t-asgn').textContent=ta;
  document.getElementById('t-rem').textContent=Math.max(0,ta-tl);
}

function renderTDO(){
  document.getElementById('tdo-list').innerHTML=teamDays.map((d,i)=>
    '<div class="dor"><input type="date" class="si2" value="'+d.date+'" oninput="teamDays['+i+'].date=this.value;recalc()">'+
    '<select class="si2" oninput="teamDays['+i+'].type=this.value"><option '+( d.type==='Holiday'?'selected':'')+'>Holiday</option><option '+( d.type==='Recharge'?'selected':'')+'>Recharge</option><option '+( d.type==='Company'?'selected':'')+'>Company</option></select>'+
    '<input type="text" class="si2" value="'+( d.note||'')+'" placeholder="Note..." oninput="teamDays['+i+'].note=this.value">'+
    '<button class="rb" onclick="teamDays.splice('+i+',1);renderTDO();recalc()">&#215;</button></div>'
  ).join('');
  document.getElementById('tdo-chip').textContent=teamDays.length+' day'+(teamDays.length!==1?'s':'');
}
function addTDO(){teamDays.push({date:'',type:'Holiday',note:''});renderTDO();recalc();}

function renderIssues(){
  const si={Done:'&#10003;','In Progress':'&#8635;',Open:'&#9492;',Blocked:'&#9888;'};
  const sc={Done:'s-done','In Progress':'s-prog',Open:'s-open',Blocked:'s-blok'};
  document.getElementById('issues-tbody').innerHTML=issues.map(iss=>{
    const rem=Math.max(0,(iss.est||0)-(iss.logged||0));
    return'<tr class="dr"><td><span class="jkey">'+iss.key+'</span></td>'+
    '<td style="font-size:11px;color:var(--t3)">'+iss.type+'</td>'+
    '<td style="font-size:12px">'+iss.summary+(iss.subtasks?'<div style="font-size:10px;color:var(--t3);margin-top:2px">'+iss.subtasks+'</div>':'')+'</td>'+
    '<td style="font-size:12px">'+( iss.assignee||'Unassigned')+'</td>'+
    '<td class="c">'+( iss.est||'&mdash;')+'</td>'+
    '<td class="c" style="color:var(--t2)">'+( iss.logged||'&mdash;')+'</td>'+
    '<td class="c" style="color:'+( rem>0?'var(--amber)':'var(--green)')+'">'+( rem||'&mdash;')+'</td>'+
    '<td class="'+( sc[iss.status]||'s-open')+'">'+( si[iss.status]||'&#9492;')+' '+iss.status+'</td></tr>';
  }).join('');
  const te=issues.reduce((a,i)=>a+(+i.est||0),0);
  const tl=issues.reduce((a,i)=>a+(+i.logged||0),0);
  document.getElementById('i-est').textContent=te||'&mdash;';
  document.getElementById('i-log').textContent=tl||'&mdash;';
  document.getElementById('i-rem').textContent=Math.max(0,te-tl)||'&mdash;';
}

function renderAvail(){
  document.getElementById('avail-list').innerHTML=members.map(m=>{
    const c=cap(m),a=asgnFor(m.name),p=c>0?Math.min(100,Math.round(a/c*100)):0;
    const col=p>100?'var(--red)':p>80?'var(--amber)':'var(--green)';
    return'<div class="ar"><div class="ar-hd"><span style="color:var(--t2);font-size:12px">'+m.name+'</span><span style="color:var(--t3);font-size:11px">'+a+' / '+c+' hrs ('+p+'%)</span></div><div class="ar-bg"><div class="ar-fill" style="width:'+p+'%;background:'+col+'"></div></div></div>';
  }).join('');
}

function renderCal(){
  const s=new Date(document.getElementById('start-date').value);
  const e=new Date(document.getElementById('end-date').value);
  if(isNaN(s)||isNaN(e)){document.getElementById('cal-grid').innerHTML='';return;}
  const today=new Date();today.setHours(0,0,0,0);
  const off=new Set(teamDays.map(d=>d.date));
  let h=['Su','Mo','Tu','We','Th','Fr','Sa'].map(d=>'<div class="cdl">'+d+'</div>').join('');
  const cur=new Date(s);
  for(let i=0;i<cur.getDay();i++)h+='<div class="cd"></div>';
  while(cur<=e){
    const dow=cur.getDay(),iso=cur.toISOString().slice(0,10);
    const isT=cur.getTime()===today.getTime(),isO=off.has(iso),isW=dow===0||dow===6;
    let c='cd';
    if(isT)c+=' today';else if(isO)c+=' off';else if(!isW)c+=' work';
    h+='<div class="'+c+'" title="'+iso+'">'+cur.getDate()+'</div>';
    cur.setDate(cur.getDate()+1);
  }
  document.getElementById('cal-grid').innerHTML=h;
}

function renderBurndown(){
  const totalEst=issues.reduce((a,i)=>a+(+i.est||0),0);
  const totalLog=issues.reduce((a,i)=>a+(+i.logged||0),0);
  const s=new Date(SD.startDate),e=new Date(SD.endDate),today=new Date();
  today.setHours(0,0,0,0);
  const off=new Set(teamDays.map(d=>d.date));
  const labels=[],workIdx=[];
  const cur=new Date(s);let wi=0;
  while(cur<=e){
    const dow=cur.getDay(),iso=cur.toISOString().slice(0,10);
    if(dow!==0&&dow!==6&&!off.has(iso)){
      labels.push(cur.toLocaleDateString('en-US',{month:'numeric',day:'numeric'}));
      if(cur<=today)workIdx.push(wi);
      wi++;
    }
    cur.setDate(cur.getDate()+1);
  }
  const wdays=labels.length||1;
  const ideal=labels.map((_,i)=>Math.round(totalEst*(1-(i/(wdays-1||1)))*10)/10);
  const elap=workIdx.length;
  const actual=labels.map((_,i)=>{
    if(i>=elap)return null;
    const burned=elap>1?(totalLog/elap)*i:0;
    return Math.max(0,Math.round((totalEst-burned)*10)/10);
  });
  if(charts.bd)charts.bd.destroy();
  charts.bd=new Chart(document.getElementById('burndown-chart'),{
    type:'line',
    data:{labels,datasets:[
      {label:'Ideal',data:ideal,borderColor:'rgba(77,166,255,.45)',borderDash:[5,5],borderWidth:1.5,pointRadius:0,fill:false,tension:0},
      {label:'Actual',data:actual,borderColor:'#00d4aa',backgroundColor:'rgba(0,212,170,.08)',borderWidth:2,pointRadius:3,pointBackgroundColor:'#00d4aa',fill:true,tension:0,spanGaps:false}
    ]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw} hrs`}}},
    scales:{x:{grid:{color:'rgba(255,255,255,.04)'},ticks:{color:'#5a6580',font:{size:10},maxTicksLimit:8}},
    y:{grid:{color:'rgba(255,255,255,.04)'},ticks:{color:'#5a6580',font:{size:10}},min:0,title:{display:true,text:'Hrs remaining',color:'#5a6580',font:{size:10}}}}}
  });
}

function renderCapChart(){
  if(charts.cap)charts.cap.destroy();
  charts.cap=new Chart(document.getElementById('cap-chart'),{
    type:'bar',
    data:{labels:members.map(m=>m.name),datasets:[
      {label:'Capacity',data:members.map(m=>cap(m)),backgroundColor:'rgba(255,255,255,.08)',borderRadius:3,borderSkipped:false},
      {label:'Assigned',data:members.map(m=>asgnFor(m.name)),backgroundColor:'#00d4aa',borderRadius:3,borderSkipped:false}
    ]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>`${ctx.dataset.label}: ${ctx.raw} hrs`}}},
    scales:{x:{grid:{color:'rgba(255,255,255,.04)'},ticks:{color:'#5a6580',font:{size:10}}},
    y:{grid:{display:false},ticks:{color:'#8b97b0',font:{size:10}}}}}
  });
}

function recalc(){
  const tc=members.reduce((a,m)=>a+cap(m),0);
  const ta=issues.reduce((a,i)=>a+(+i.est||0),0);
  const tl=issues.reduce((a,i)=>a+(+i.logged||0),0);
  const tp=members.reduce((a,m)=>a+m.pto,0)+tdo()*members.length;
  const u=tc>0?Math.round(ta/tc*100):0;
  document.getElementById('k-cap').textContent=tc;
  document.getElementById('k-asgn').textContent=ta;
  document.getElementById('k-rem').textContent=Math.max(0,ta-tl);
  document.getElementById('k-util').textContent=u+'%';
  document.getElementById('k-pto').textContent=tp;
  renderMembers();renderAvail();renderCal();renderBurndown();renderCapChart();
}

function renderAll(){renderTDO();renderIssues();recalc();}
load();
