// ── SHARED DATA CONFIG ──────────────────────────────────────────────────────
// data.json is written daily by GitHub Actions (fetch_jira_data.py).
// Claude can also inject live data via window.__injectTeamData() for
// on-demand refreshes using the Chrome extension.
// On Save: changes persist to localStorage, Jira, and Confluence.
// GitHub data.json is updated only by the daily Action — never from the browser.
const REPO     = 'julia7lukas/wbs-dashboard';
const DATA_URL = 'https://raw.githubusercontent.com/' + REPO + '/main/data.json?cb=' + Date.now();
const ANTHROPIC_API  = 'https://api.anthropic.com/v1/messages';
const ATLASSIAN_MCP  = 'https://mcp.atlassian.com/v1/sse';
const CONFLUENCE_PAGE_IDS = { WBS:'6627524645', GIN:null, MOJO:null, MAV:null, AMGO:null };

let TEAMS = {};

// Track issue state at load time so we only push actual diffs to Jira
let _issueSnapshot = {};
// Track members removed this session so saveAll can unassign their issues
let _removedMembers = [];

// ── SPRINT-SCOPED CACHE (localStorage — capacity edits only, no secrets) ────
function cacheKey(projectKey, sprintName) {
  return 'wbs-cache-' + projectKey + '-' + sprintName.replace(/\s+/g, '-');
}
function loadSavedCapacity(projectKey, sprintName) {
  try {
    const raw = localStorage.getItem(cacheKey(projectKey, sprintName));
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p.sprintName === sprintName ? p : null;
  } catch(e) { return null; }
}
function saveCapacity(projectKey, sprintName, members, teamDays) {
  try {
    localStorage.setItem(cacheKey(projectKey, sprintName),
      JSON.stringify({ sprintName, members: members.map(m=>({...m})), teamDays: teamDays.map(d=>({...d})) }));
  } catch(e) {}
}
function purgeStaleCaches(projectKey, currentSprintName) {
  const prefix = 'wbs-cache-' + projectKey + '-';
  const keep   = cacheKey(projectKey, currentSprintName);
  Object.keys(localStorage).forEach(k => { if (k.startsWith(prefix) && k !== keep) localStorage.removeItem(k); });
}

// ── PUBLIC INJECT API (called by Claude via javascript_tool) ─────────────────
window.__injectTeamData = function(jsonStr) {
  try {
    const incoming = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
    Object.keys(incoming).forEach(teamKey => {
      const nd    = incoming[teamKey];
      const saved = loadSavedCapacity(nd.projectKey, nd.sprintName);
      if (saved) { nd.members = saved.members; nd.teamDays = saved.teamDays; }
      TEAMS[teamKey] = nd;
    });
    buildTeamSelector();
    switchTeam(currentTeam || Object.keys(TEAMS)[0]);
    const el = document.getElementById('sync-ts');
    if (el) el.textContent = 'Jira sync: ' + new Date().toLocaleString('en-US', {
      dateStyle:'short', timeStyle:'short', timeZone:'America/Chicago'
    }) + ' · Live ✓';
  } catch(e) { console.error('__injectTeamData failed:', e); alert('Inject failed: ' + e.message); }
};

// ── ANTHROPIC → ATLASSIAN MCP WRITE-BACKS ────────────────────────────────────
// Saves route through api.anthropic.com → Atlassian MCP → Jira / Confluence.
// No secrets needed in the browser — auth is handled by the Anthropic session.
async function callAtlassianMCP(prompt) {
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
      mcp_servers: [{ type: 'url', url: ATLASSIAN_MCP, name: 'atlassian' }]
    })
  });
  if (!res.ok) throw new Error('Anthropic API error: ' + res.status);
  const data = await res.json();
  return data.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
}

async function syncIssuesToJira(changedIssues) {
  if (!changedIssues.length) return;
  const cloudId = '0affc225-bae5-4e42-ba94-341cbdb24213';
  const lines = changedIssues.map(iss => {
    const parts = [];
    if (iss._assigneeChanged) parts.push('assignee → "' + iss.assignee + '"');
    if (iss._statusChanged)   parts.push('status → "' + iss.status + '"');
    if (iss._estChanged)      parts.push('originalEstimate → ' + iss.est + 'h');
    return iss.key + ': ' + parts.join(', ');
  }).join('\n');
  const prompt =
    'You are updating Jira issues on cloudId ' + cloudId + '. ' +
    'For each issue below apply the changes using editJiraIssue and/or transitionJiraIssue tools. ' +
    'For assignee changes, look up the account ID using lookupJiraAccountId first. ' +
    'For status changes, get available transitions with getTransitionsForJiraIssue then apply the right one. ' +
    'For estimate changes, set timetracking.originalEstimate in hours (e.g. "6h"). ' +
    'Apply all changes silently — no explanations needed, just do it.\n\n' +
    'Issues to update:\n' + lines;
  return callAtlassianMCP(prompt);
}

async function syncCapacityToConfluence() {
  const sd     = getSD();
  const pageId = CONFLUENCE_PAGE_IDS[currentTeam];
  if (!pageId) { console.log('No Confluence page ID configured for', currentTeam); return; }
  const cloudId    = '0affc225-bae5-4e42-ba94-341cbdb24213';
  const memberRows = members.map(m => m.name + ': ' + (m.hrs||6) + ' hrs/day, ' + (m.pto||0) + ' PTO days').join('\n');
  const daysOffRows = teamDays.length
    ? teamDays.map(d => d.date + ' (' + d.type + ')' + (d.note ? ' — ' + d.note : '')).join('\n')
    : 'None';
  const prompt =
    'Update the Confluence page ID ' + pageId + ' on cloudId ' + cloudId + '. ' +
    'Find the capacity table section and update it with the current sprint capacity data below. ' +
    'Preserve all existing page content and structure — only update the capacity/member rows and team days off section. ' +
    'Use updateConfluencePage with the latest data. Add a "Last updated" timestamp.\n\n' +
    'Sprint: ' + sd.sprintName + ' (' + sd.startDate + ' → ' + sd.endDate + ')\n' +
    'Team members:\n' + memberRows + '\n' +
    'Team days off:\n' + daysOffRows + '\n' +
    'Total net capacity: ' + members.reduce((a,m) => a+cap(m), 0) + 'h';
  return callAtlassianMCP(prompt);
}

// ── TEAM SELECTOR ─────────────────────────────────────────────────────────────
let currentTeam = null;

function switchTeam(key) {
  if (!TEAMS[key]) return;
  currentTeam = key;
  const SD = TEAMS[key];
  purgeStaleCaches(SD.projectKey, SD.sprintName);
  const saved = loadSavedCapacity(SD.projectKey, SD.sprintName);
  if (saved) {
    const savedMap = Object.fromEntries(saved.members.map(m => [m.name, m]));
    members  = SD.members.map(m => savedMap[m.name] ? {...savedMap[m.name]} : {...m});
    teamDays = saved.teamDays.map(d => ({...d}));
  } else {
    members  = SD.members.map(m => ({...m}));
    teamDays = SD.teamDays ? SD.teamDays.map(d => ({...d})) : [];
  }
  issues = SD.issues.map(i => ({...i}));
  _removedMembers = [];
  _issueSnapshot  = Object.fromEntries(issues.map(i => [i.key, {assignee:i.assignee, status:i.status, est:i.est}]));

  document.getElementById('sprint-name').value       = SD.sprintName;
  document.getElementById('hdr-sprint').textContent  = SD.sprintName;
  document.getElementById('hdr-team').textContent    = SD.team + ' (' + SD.projectKey + ')';
  document.getElementById('start-date').value        = SD.startDate;
  document.getElementById('end-date').value          = SD.endDate;
  document.getElementById('work-days').value         = SD.workDays;
  document.getElementById('hrs-day').value           = SD.hrsPerDay;
  const ts = new Date(SD.syncedAt);
  document.getElementById('sync-ts').textContent = 'Jira sync: ' +
    ts.toLocaleDateString('en-US', {timeZone:'America/Chicago'}) + ' ' +
    ts.toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', timeZone:'America/Chicago'});
  document.getElementById('team-badge').textContent = key;
  document.querySelectorAll('.team-btn').forEach(b => {
    b.style.background  = b.dataset.key===key ? 'var(--green)' : 'var(--bg3)';
    b.style.color       = b.dataset.key===key ? '#000'         : 'var(--t2)';
    b.style.borderColor = b.dataset.key===key ? 'var(--green)' : 'var(--bdr)';
  });
  renderAll();
}

const AVC = ['#00d4aa','#4da6ff','#a78bfa','#f472b6','#fbbf24','#f87171','#34d399','#60a5fa'];
const AVB = AVC.map(c => c + '22');
function ini(n) { return (n||'').trim().split(/\s+/).map(w=>w[0]||'').join('').toUpperCase().slice(0,2)||'?'; }

let members, teamDays, issues, charts = {}, sortKey = 'key', sortDir = 1;
function getSD()       { return TEAMS[currentTeam]; }
function parseDate(s)  { if (!s) return null; const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); }
function isoDate(d)    { return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }

// ── LOAD ──────────────────────────────────────────────────────────────────────
async function load() {
  const el = document.getElementById('sync-ts');
  if (el) el.textContent = 'Loading sprint data...';
  try {
    const res = await fetch(DATA_URL);
    if (res.ok) {
      const data = await res.json();
      if (data && Object.keys(data).length > 0) {
        Object.keys(data).forEach(teamKey => {
          const sd    = data[teamKey];
          const saved = loadSavedCapacity(sd.projectKey, sd.sprintName);
          if (saved) {
            const savedMap = Object.fromEntries(saved.members.map(m=>[m.name,m]));
            sd.members  = sd.members.map(m => savedMap[m.name] ? {...savedMap[m.name]} : {...m});
            sd.teamDays = saved.teamDays.map(d=>({...d}));
          }
        });
        TEAMS = data;
        buildTeamSelector();
        switchTeam(Object.keys(TEAMS)[0]);
        if (el) {
          const ts = new Date(Object.values(TEAMS)[0].syncedAt);
          el.textContent = 'Jira sync: ' + ts.toLocaleString('en-US', {
            dateStyle:'short', timeStyle:'short', timeZone:'America/Chicago'
          }) + ' · Auto ✓';
        }
        return;
      }
    }
  } catch(e) { console.log('Could not fetch data.json:', e); }
  showLoadPrompt();
}

function showLoadPrompt() {
  document.querySelector('.main').innerHTML =
    '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:60vh;gap:20px;text-align:center;padding:40px">' +
    '<div style="font-size:48px">🔄</div>' +
    '<div style="font-size:18px;font-weight:500;color:var(--t1)">No sprint data loaded yet</div>' +
    '<div style="font-size:13px;color:var(--t2);max-width:420px">Data refreshes automatically every weekday at 6am CT.<br>Or ask Claude: <em>"refresh the WBS sprint dashboard"</em></div></div>';
}

function buildTeamSelector() {
  const tl = document.getElementById('team-selector');
  if (!tl) return;
  tl.innerHTML = '';
  Object.keys(TEAMS).forEach(k => {
    const b = document.createElement('button');
    b.className = 'btn team-btn'; b.dataset.key = k; b.textContent = k;
    b.style.cssText = 'padding:4px 10px;font-size:11px;font-weight:600';
    b.onclick = () => switchTeam(k);
    tl.appendChild(b);
  });
}

// ── SAVE — localStorage + Jira + Confluence ───────────────────────────────────
async function saveAll() {
  const s   = getSD();
  const btn = document.querySelector('.btn-g');
  const el  = document.getElementById('sync-ts');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving...'; }

  // Detect changed issues vs snapshot
  const changedIssues = issues.filter(iss => {
    const snap = _issueSnapshot[iss.key];
    if (!snap) return false;
    iss._assigneeChanged = snap.assignee !== iss.assignee;
    iss._statusChanged   = snap.status   !== iss.status;
    iss._estChanged      = snap.est       !== iss.est;
    return iss._assigneeChanged || iss._statusChanged || iss._estChanged;
  });

  // Sprint-scoped localStorage (capacity edits — no secrets)
  saveCapacity(s.projectKey, s.sprintName, members, teamDays);

  // Jira + Confluence in parallel
  let jiraStatus = '', confluenceStatus = '';
  const promises = [];

  if (changedIssues.length > 0) {
    promises.push(
      syncIssuesToJira(changedIssues)
        .then(()  => { jiraStatus = ' · Jira ✓'; })
        .catch(e  => { console.error('Jira sync failed:', e); jiraStatus = ' · Jira ✗'; })
    );
  }

  promises.push(
    syncCapacityToConfluence()
      .then(()  => { confluenceStatus = ' · Confluence ✓'; })
      .catch(e  => { console.error('Confluence sync failed:', e); confluenceStatus = ' · Confluence ✗'; })
  );

  await Promise.all(promises);

  // Update snapshot so next save only diffs new changes
  _issueSnapshot  = Object.fromEntries(issues.map(i => [i.key, {assignee:i.assignee, status:i.status, est:i.est}]));
  _removedMembers = [];

  if (btn) { btn.disabled = false; btn.textContent = '✓ Save changes'; }
  if (el)  el.textContent = (el.textContent||'').replace(/ · (Saving|Saved|Jira|Confluence).*/g, '') +
    jiraStatus + confluenceStatus + ' · Saved ✓';
}

// ── CAPACITY HELPERS ──────────────────────────────────────────────────────────
function wd()       { return Math.max(1, parseInt(document.getElementById('work-days').value)||9); }
function hd()       { return Math.max(1, parseInt(document.getElementById('hrs-day').value)||6); }
function tdo()      { return teamDays.length; }
function cap(m)     { return Math.max(0, wd()-tdo()-(m.pto||0)) * (m.hrs||hd()); }
function asgnFor(n) { const sd=getSD(); return sd&&sd.subtaskHrs ? (sd.subtaskHrs[n]||{}).est||0    : 0; }
function logFor(n)  { const sd=getSD(); return sd&&sd.subtaskHrs ? (sd.subtaskHrs[n]||{}).logged||0 : 0; }

function memberOpts(sel) {
  return '<option value="Unassigned"'+(!sel||sel==='Unassigned'?' selected':'')+'>Unassigned</option>' +
    members.map(m=>'<option value="'+m.name+'"'+(m.name===sel?' selected':'')+'>'+m.name+'</option>').join('');
}

function removeMember(i) {
  const removed = members[i];
  _removedMembers.push(removed.name);
  issues.forEach(iss => { if (iss.assignee === removed.name) iss.assignee = 'Unassigned'; });
  members.splice(i, 1);
  renderAll();
}

function addMemberPrompt() {
  const n = (prompt('Name:')||'').trim(); if (!n) return;
  if (members.find(m=>m.name===n)) { alert(n+' already listed.'); return; }
  members.push({name:n, hrs:hd(), pto:0}); renderAll();
}

// ── RENDER MEMBERS ─────────────────────────────────────────────────────────────
function renderMembers() {
  const tb = document.getElementById('mtbody');
  tb.innerHTML = members.map((m,i) => {
    const c=cap(m), asgn=asgnFor(m.name), logged=logFor(m.name);
    const remaining = Math.max(0, asgn - logged);
    const util=c>0?Math.min(100,Math.round(asgn/c*100)):0;
    const utilCol=util>100?'var(--red)':util>85?'var(--amber)':'var(--green)';
    // Remaining is red when >80% of capacity still unlogged with <50% sprint elapsed
    const sd=getSD();
    const sprintDays = wd();
    const today=new Date(), start=parseDate(sd&&sd.startDate), end=parseDate(sd&&sd.endDate);
    const totalMs=(end&&start)?(end-start):1, elapsedMs=start?Math.min(today-start,totalMs):0;
    const sprintPct=totalMs>0?elapsedMs/totalMs:0;
    // Red if remaining hrs > expected remaining capacity (you're behind)
    const expectedRemaining = c * (1 - sprintPct);
    const remCol = (remaining > 0 && remaining > expectedRemaining * 1.2) ? 'var(--red)'
                 : remaining > 0 ? 'var(--amber)' : 'var(--green)';
    return '<tr class="dr">'+
      '<td><div class="mc"><div class="av" style="background:'+AVB[i%8]+';color:'+AVC[i%8]+'">'+ini(m.name)+'</div>'+
      '<input style="background:transparent;border:none;color:var(--t1);font-family:var(--font);font-size:13px;width:130px" value="'+m.name+'" onchange="members['+i+'].name=this.value.trim();renderAll()"></div></td>'+
      '<td class="c"><input class="ni" type="number" min="1" max="12" value="'+(m.hrs||hd())+'" oninput="members['+i+'].hrs=Math.max(1,+this.value||'+hd()+');recalc()"></td>'+
      '<td class="c"><input class="ni" type="number" min="0" value="'+(m.pto||0)+'" oninput="members['+i+'].pto=Math.max(0,+this.value||0);recalc()"></td>'+
      '<td class="c netc">'+c+'h</td>'+
      '<td class="c" style="color:var(--blue)">'+asgn+'h</td>'+
      '<td class="c" style="color:var(--t2)">'+logged+'h</td>'+
      '<td class="c"><div style="font-size:12px;font-weight:600;color:'+remCol+'">'+remaining+'h</div></td>'+
      '<td class="c"><div style="font-size:11px;font-weight:600;color:'+utilCol+'">'+util+'%</div></td>'+
      '<td><button class="rb" onclick="removeMember('+i+')">×</button></td></tr>';
  }).join('')+
  '<tr><td colspan="9" style="padding:6px 0"><button class="addl" onclick="addMemberPrompt()">+ Add team member</button></td></tr>';
  const tp=members.reduce((a,m)=>a+(m.pto||0),0);
  const tc=members.reduce((a,m)=>a+cap(m),0);
  const ta=members.reduce((s,m)=>s+asgnFor(m.name),0);
  const tl=members.reduce((s,m)=>s+logFor(m.name),0);
  const tr2=Math.max(0,ta-tl);
  document.getElementById('t-pto').textContent=tp;
  document.getElementById('t-cap').textContent=tc+'h';
  const el=document.getElementById('t-asgn'); if(el) el.textContent=ta+'h';
  const el2=document.getElementById('t-log'); if(el2) el2.textContent=tl+'h';
  const el3=document.getElementById('t-rem2'); if(el3) el3.textContent=tr2+'h';
}

// ── RENDER TEAM DAYS OFF ───────────────────────────────────────────────────────
function sprintDateAttrs() {
  const s=document.getElementById('start-date').value, e=document.getElementById('end-date').value;
  return (s?'min="'+s+'"':'')+' '+(e?'max="'+e+'"':'');
}
function renderTDO() {
  const a=sprintDateAttrs();
  document.getElementById('tdo-list').innerHTML = teamDays.map((d,i)=>
    '<div class="dor">'+
    '<input type="date" class="si2" style="font-size:11px;padding:3px 5px" value="'+d.date+'" '+a+' oninput="teamDays['+i+'].date=this.value;renderTDO();recalc()">'+
    '<select class="si2" style="font-size:11px;padding:3px 5px" oninput="teamDays['+i+'].type=this.value">'+
      '<option '+(d.type==='Holiday' ?'selected':'')+'>Holiday</option>'+
      '<option '+(d.type==='Recharge'?'selected':'')+'>Recharge</option>'+
      '<option '+(d.type==='Company' ?'selected':'')+'>Company</option>'+
    '</select>'+
    '<button class="rb" onclick="teamDays.splice('+i+',1);renderTDO();recalc()">×</button></div>'
  ).join('');
  document.getElementById('tdo-chip').textContent=teamDays.length+' day'+(teamDays.length!==1?'s':'');
}
function addTDO() {
  const s=document.getElementById('start-date').value||getSD().startDate;
  const e=document.getElementById('end-date').value||getSD().endDate;
  const ex=new Set(teamDays.map(d=>d.date)); let cur=parseDate(s); const end=parseDate(e); let sg='';
  while(cur<=end){const iso=isoDate(cur); if(cur.getDay()!==0&&cur.getDay()!==6&&!ex.has(iso)){sg=iso;break;} cur.setDate(cur.getDate()+1);}
  teamDays.push({date:sg,type:'Holiday',note:''}); renderTDO(); recalc();
}

// ── RENDER ISSUES ──────────────────────────────────────────────────────────────
function setSort(k) { if(sortKey===k) sortDir*=-1; else{sortKey=k;sortDir=1;} renderIssues(); }
function sortedIssues() {
  const ord={Done:3,'In Progress':2,Blocked:1,Open:0};
  return [...issues].sort((a,b)=>{
    let av,bv;
    if(sortKey==='status')  {av=ord[a.status]||0;  bv=ord[b.status]||0;}
    else if(sortKey==='est'){av=a.est||0;           bv=b.est||0;}
    else if(sortKey==='assignee'){av=a.assignee||'';bv=b.assignee||'';}
    else{av=a.key;bv=b.key;}
    return av<bv?-sortDir:av>bv?sortDir:0;
  });
}
function renderIssues() {
  const hdr=document.getElementById('issues-hdr');
  const ar=k=>sortKey===k?(sortDir>0?' ▲':' ▼'):'';
  if(hdr) hdr.innerHTML=
    '<th style="width:78px;cursor:pointer" onclick="setSort(\'key\')">Issue'+ar('key')+'</th>'+
    '<th style="width:55px">Type</th><th>Summary</th>'+
    '<th style="width:125px;cursor:pointer" onclick="setSort(\'assignee\')">Assignee'+ar('assignee')+'</th>'+
    '<th class="c" style="width:65px;cursor:pointer" onclick="setSort(\'est\')">Est hrs'+ar('est')+'</th>'+
    '<th class="c" style="width:58px">Logged</th>'+
    '<th class="c" style="width:80px">Remaining</th>'+
    '<th style="width:108px;cursor:pointer" onclick="setSort(\'status\')">Status'+ar('status')+'</th>';
  const si={Done:'✅','In Progress':'🔄',Open:'📋',Blocked:'🚫'};
  const sc={Done:'s-done','In Progress':'s-prog',Open:'s-open',Blocked:'s-blok'};
  document.getElementById('issues-tbody').innerHTML = sortedIssues().map(iss=>{
    const i=issues.indexOf(iss);
    const rem=Math.max(0,(iss.est||0)-(iss.logged||0));
    const pct=iss.est>0?Math.round((iss.logged||0)/iss.est*100):0;
    const subtaskHtml=iss.subtasks
      ?'<div style="font-size:10px;color:var(--t3);margin-top:3px;line-height:1.5">'+
        iss.subtasks.split(', ').map(s=>{
          const m=s.match(/^(\w+-\d+)\s+\(([^,]+),\s+(\d+)h est,\s+(\d+)h logged\)$/);
          if(!m) return '<span style="opacity:.6">'+s+'</span>';
          const[,key,who,est,log]=m; const done=parseInt(log)>=parseInt(est);
          return '<span style="color:'+(done?'var(--green)':'var(--t3)')+'">'+key+' '+who+' '+log+'/'+est+'h</span>';
        }).join(' · ')+'</div>':'';
    return '<tr class="dr">'+
      '<td><span class="jkey">'+iss.key+'</span></td>'+
      '<td style="font-size:11px;color:var(--t3)">'+iss.type+'</td>'+
      '<td style="font-size:12px">'+iss.summary+subtaskHtml+'</td>'+
      '<td><select class="si2" style="width:120px" onchange="issues['+i+'].assignee=this.value;recalc()">'+memberOpts(iss.assignee)+'</select></td>'+
      '<td class="c"><input class="ni" type="number" min="0" step="0.5" value="'+(iss.est||0)+'" oninput="issues['+i+'].est=+this.value;recalc()"></td>'+
      '<td class="c" style="color:var(--t2)">'+(iss.logged||'—')+'</td>'+
      '<td class="c"><div style="font-size:12px;font-weight:500;color:'+(rem>0?'var(--amber)':'var(--green)')+'">'+rem+'h</div>'+
        '<div style="font-size:10px;color:var(--t3)">'+pct+'% done</div></td>'+
      '<td class="'+(sc[iss.status]||'s-open')+'">'+(si[iss.status]||'📋')+
        ' <select style="background:transparent;border:none;color:inherit;font-size:12px;cursor:pointer" onchange="issues['+i+'].status=this.value;renderAll()">'+
          '<option '+(iss.status==='Open'        ?'selected':'')+'>Open</option>'+
          '<option '+(iss.status==='In Progress' ?'selected':'')+'>In Progress</option>'+
          '<option '+(iss.status==='Done'        ?'selected':'')+'>Done</option>'+
          '<option '+(iss.status==='Blocked'     ?'selected':'')+'>Blocked</option>'+
        '</select></td></tr>';
  }).join('');
  const te=issues.reduce((a,i)=>a+(+i.est||0),0);
  const tl=issues.reduce((a,i)=>a+(+i.logged||0),0);
  const doneCount=issues.filter(i=>i.status==='Done').length;
  const pc=issues.length>0?Math.round(doneCount/issues.length*100):0;
  document.getElementById('i-est').textContent=Math.round(te*10)/10||0;
  document.getElementById('i-log').textContent=Math.round(tl*10)/10||0;
  document.getElementById('i-rem').textContent=(Math.round(Math.max(0,te-tl)*10)/10||0)+'h · '+pc+'% done';
}

// ── AVAILABILITY BARS ──────────────────────────────────────────────────────────
function renderAvail() {
  document.getElementById('avail-list').innerHTML = members.map(m=>{
    const c=cap(m), a=asgnFor(m.name), logged=logFor(m.name);
    const p=c>0?Math.min(100,Math.round(a/c*100)):0;
    const col=p>100?'var(--red)':p>80?'var(--amber)':'var(--green)';
    return '<div class="ar"><div class="ar-hd">'+
      '<span style="color:var(--t2);font-size:12px">'+m.name+'</span>'+
      '<span style="color:var(--t3);font-size:11px">'+a+'h est / '+logged+'h logged / '+c+'h cap ('+p+'%)</span></div>'+
      '<div class="ar-bg"><div class="ar-fill" style="width:'+p+'%;background:'+col+'"></div></div></div>';
  }).join('');
}

// ── CALENDAR ───────────────────────────────────────────────────────────────────
function renderCal() {
  const el=document.getElementById('cal-grid');
  const startStr=document.getElementById('start-date').value, endStr=document.getElementById('end-date').value;
  if(!startStr||!endStr){el.innerHTML='';return;}
  const s=parseDate(startStr), e=parseDate(endStr);
  if(!s||!e||isNaN(s)||isNaN(e)){el.innerHTML='';return;}
  const _n=new Date(); const todayIso=isoDate(_n), offDates=new Set(teamDays.map(d=>d.date));
  let h=['Su','Mo','Tu','We','Th','Fr','Sa'].map(d=>'<div class="cdl">'+d+'</div>').join('');
  for(let i=0;i<s.getDay();i++) h+='<div class="cd"></div>';
  let wc=0; const cur=new Date(s);
  while(cur<=e){
    const dow=cur.getDay(), iso=isoDate(cur);
    const isToday=iso===todayIso, isOff=offDates.has(iso), isWeekend=dow===0||dow===6, isPast=iso<todayIso&&!isToday;
    if(!isWeekend&&!isOff) wc++;
    let cls='cd',ex='';
    if(isToday) cls+=' today';
    else if(isOff) cls+=' off';
    else if(isWeekend){}
    else if(isPast){cls+=' work';ex=' style="opacity:.38"';}
    else cls+=' work';
    h+='<div class="'+cls+'"'+ex+' title="'+iso+'">'+cur.getDate()+'</div>';
    cur.setDate(cur.getDate()+1);
  }
  el.innerHTML=h;
  const w=document.getElementById('work-days'); if(w&&wc>0) w.value=wc;
}

// ── BURNDOWN CHART ─────────────────────────────────────────────────────────────
function renderBurndown() {
  const sd=getSD();
  const startStr=(sd&&sd.startDate)||document.getElementById('start-date').value||'';
  const endStr  =(sd&&sd.endDate)  ||document.getElementById('end-date').value  ||'';
  const s=parseDate(startStr), e=parseDate(endStr);
  if(!s||!e) return;
  const _n=new Date(), todayIso=isoDate(_n), off=new Set(teamDays.map(d=>d.date));
  const workDays=[]; const cur=new Date(s);
  while(cur<=e){ const dow=cur.getDay(), iso=isoDate(cur); if(dow!==0&&dow!==6&&!off.has(iso)) workDays.push(iso); cur.setDate(cur.getDate()+1);}
  if(!workDays.length) return;
  const totalEst     =issues.reduce((a,i)=>a+(+i.est||0),0);
  const totalLogged  =issues.reduce((a,i)=>a+(+i.logged||0),0);
  const remainingNow =Math.max(0,totalEst-totalLogged);
  const n=workDays.length;
  const ideal=workDays.map((_,i)=>Math.round(totalEst*(1-i/Math.max(n-1,1))*10)/10);
  const pivotIdx=workDays.findIndex(d=>d>=todayIso);
  const pivot=pivotIdx===-1?n-1:pivotIdx;
  const actual=workDays.map((day,i)=>{
    if(i>pivot) return null;
    if(pivot===0) return totalEst;
    if(i===pivot) return remainingNow;
    return Math.round((totalEst-(totalEst-remainingNow)*(i/pivot))*10)/10;
  });
  const labels=workDays.map(d=>{const[,m,day]=d.split('-'); return parseInt(m)+'/'+parseInt(day);});
  if(charts.bd) charts.bd.destroy();
  charts.bd=new Chart(document.getElementById('burndown-chart'),{
    type:'line',
    data:{labels,datasets:[
      {label:'Ideal',data:ideal,borderColor:'rgba(77,166,255,.45)',borderDash:[5,5],borderWidth:1.5,pointRadius:0,fill:false,tension:0},
      {label:'Actual',data:actual,borderColor:'#00d4aa',backgroundColor:'rgba(0,212,170,.08)',borderWidth:2,pointRadius:3,pointBackgroundColor:'#00d4aa',fill:true,tension:0,spanGaps:false}
    ]},
    options:{
      responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+': '+ctx.raw+'h remaining'}}},
      scales:{
        x:{grid:{color:'rgba(255,255,255,.04)'},ticks:{color:'#5a6580',font:{size:10},maxTicksLimit:8}},
        y:{grid:{color:'rgba(255,255,255,.04)'},ticks:{color:'#5a6580',font:{size:10},precision:0},min:0,max:Math.max(10,totalEst),title:{display:true,text:'Hours remaining',color:'#5a6580',font:{size:10}}}
      }
    }
  });
}

// ── RECALC / RENDER ALL ────────────────────────────────────────────────────────
function recalc() {
  const tc=members.reduce((a,m)=>a+cap(m),0);
  const ta=members.reduce((a,m)=>a+asgnFor(m.name),0);
  const tp=tdo();
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

function renderAll() { renderTDO(); renderIssues(); recalc(); }

async function refreshFromJira() {
  const btn=document.getElementById('refresh-btn');
  if(btn){btn.textContent='Ask Claude ↗';btn.disabled=false;}
  alert('To refresh sprint data on demand, ask Claude:\n"Refresh the WBS sprint dashboard"\n\nAutomatic refresh runs every weekday at 6am CT.');
}

load();
