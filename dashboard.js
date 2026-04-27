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

// ── SECURITY CONFIG ──────────────────────────────────────────────────────────
// Restrict API calls to known origins only — prevents hotlinking from unknown domains
const ALLOWED_ORIGINS = [
  'https://julia7lukas.github.io',
  'http://localhost',
  'http://127.0.0.1'
];
const CLOUD_ID = '0affc225-bae5-4e42-ba94-341cbdb24213';

function isAllowedOrigin() {
  return ALLOWED_ORIGINS.some(o => window.location.origin === o || window.location.origin.startsWith(o));
}

// Sanitize any string before writing to innerHTML
// Strips script tags, event handlers, and javascript: URIs
function sanitize(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

// Track members removed this session
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
  if (!isAllowedOrigin()) {
    console.error('Security: API call blocked — unauthorized origin:', window.location.origin);
    throw new Error('Unauthorized origin');
  }
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


async function syncCapacityToConfluence() {
  const sd     = getSD();
  const pageId = CONFLUENCE_PAGE_IDS[currentTeam];
  if (!pageId) { console.log('No Confluence page ID configured for', currentTeam); return; }
  const cloudId = CLOUD_ID;
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
  _removedMembers = [];
  _issueSnapshot  = {};

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

let members, teamDays, charts = {};
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

  // Sprint-scoped localStorage (capacity edits — no secrets)
  saveCapacity(s.projectKey, s.sprintName, members, teamDays);

  // Jira + Confluence in parallel
  let confluenceStatus = '';
  const promises = [];

  promises.push(
    syncCapacityToConfluence()
      .then(()  => { confluenceStatus = ' · Confluence ✓'; })
      .catch(e  => { console.error('Confluence sync failed:', e); confluenceStatus = ' · Confluence ✗'; })
  );

  await Promise.all(promises);

  _removedMembers = [];

  if (btn) { btn.disabled = false; btn.textContent = '✓ Save changes'; }
  if (el)  el.textContent = (el.textContent||'').replace(/ · (Saving|Saved|Jira|Confluence).*/g, '') +
    confluenceStatus + ' · Saved ✓';
}

// ── CAPACITY HELPERS ──────────────────────────────────────────────────────────
function wd()       { return Math.max(1, parseInt(document.getElementById('work-days').value)||9); }
function hd()       { return Math.max(1, parseInt(document.getElementById('hrs-day').value)||6); }
function tdo()      { return teamDays.length; }
function cap(m)     { return Math.max(0, wd()-tdo()-(m.pto||0)) * (m.hrs||hd()); }
function asgnFor(n) { const sd=getSD(); return sd&&sd.subtaskHrs ? (sd.subtaskHrs[n]||{}).est||0    : 0; }
function logFor(n)  { const sd=getSD(); return sd&&sd.subtaskHrs ? (sd.subtaskHrs[n]||{}).logged||0 : 0; }


function removeMember(i) {
  const removed = members[i];
  _removedMembers.push(removed.name);
  members.splice(i, 1);
  autoSave();
  renderAll();
}

function addMemberPrompt() {
  const n = (prompt('Name:')||'').trim(); if (!n) return;
  if (members.find(m=>m.name===n)) { alert(n+' already listed.'); return; }
  members.push({name:n, hrs:hd(), pto:0});
  autoSave();
  renderAll();
}

// ── RENDER MEMBERS ─────────────────────────────────────────────────────────────
function renderMembers() {
  const tb = document.getElementById('mtbody');
  const sd = getSD();
  tb.innerHTML = members.map((m, i) => ({m, i})).filter(({m}) => asgnFor(m.name) > 0).map(({m, i}) => {
    const c = cap(m);
    const asgn = asgnFor(m.name);
    const logged = logFor(m.name);
    const remaining = Math.max(0, asgn - logged);
    // Util = logged vs capacity (actual progress)
    // Remaining is amber when hours left, green when done
    const remCol = remaining > 0 ? 'var(--amber)' : 'var(--green)';
    return '<tr class="dr">'+
      '<td><div class="mc"><div class="av" style="background:'+AVB[i%8]+';color:'+AVC[i%8]+'">'+ini(m.name)+'</div>'+
      '<input style="background:transparent;border:none;color:var(--t1);font-family:var(--font);font-size:13px;width:130px" value="'+sanitize(m.name)+'" onchange="members['+i+'].name=this.value.trim();autoSave();renderAll()"></div></td>'+
      '<td class="c"><input class="ni" type="number" min="1" max="12" value="'+(m.hrs||hd())+'" oninput="members['+i+'].hrs=Math.max(1,+this.value||'+hd()+');autoSave();recalc()"></td>'+
      '<td class="c"><input class="ni" type="number" min="0" value="'+(m.pto||0)+'" oninput="members['+i+'].pto=Math.max(0,+this.value||0);autoSave();recalc()"></td>'+
      '<td class="c netc">'+c+'h</td>'+
      '<td class="c" style="color:var(--blue)">'+asgn+'h</td>'+
      '<td class="c" style="color:var(--t2)">'+logged+'h</td>'+
      '<td class="c"><div style="font-size:12px;font-weight:600;color:'+remCol+'">'+remaining+'h</div></td>'+
      '<td><button class="rb" onclick="removeMember('+i+')">×</button></td></tr>';
  }).join('')+
  '<tr><td colspan="8" style="padding:6px 0"><button class="addl" onclick="addMemberPrompt()">+ Add team member</button></td></tr>';

  // Totals only for members with assigned hours (hidden members excluded entirely)
  const activeMembers = members.filter(m => asgnFor(m.name) > 0);
  const tp = activeMembers.reduce((a,m) => a+(m.pto||0), 0);
  const tc = activeMembers.reduce((a,m) => a+cap(m), 0);
  const ta = activeMembers.reduce((s,m) => s+asgnFor(m.name), 0);
  const tl = activeMembers.reduce((s,m) => s+logFor(m.name), 0);
  const tr2 = Math.max(0, ta-tl);
  document.getElementById('t-pto').textContent = tp;
  document.getElementById('t-cap').textContent = tc+'h';
  const ea=document.getElementById('t-asgn'); if(ea) ea.textContent=ta+'h';
  const el=document.getElementById('t-log');  if(el) el.textContent=tl+'h';
  const er=document.getElementById('t-rem2'); if(er) er.textContent=tr2+'h';
}

// ── AUTO-SAVE — persists to localStorage instantly on every change ────────────
// This ensures changes survive tab close/open without needing to hit Save.
// Save button additionally pushes to Jira + Confluence.
function autoSave() {
  const s = getSD();
  if (!s) return;
  saveCapacity(s.projectKey, s.sprintName, members, teamDays);
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
    '<input type="date" class="si2" style="font-size:11px;padding:3px 5px" value="'+d.date+'" '+a+' oninput="teamDays['+i+'].date=this.value;autoSave();renderTDO();recalc()">'+
    '<select class="si2" style="font-size:11px;padding:3px 5px" oninput="teamDays['+i+'].type=this.value;autoSave()">'+
      '<option '+(d.type==='Holiday' ?'selected':'')+'>Holiday</option>'+
      '<option '+(d.type==='Recharge'?'selected':'')+'>Recharge</option>'+
      '<option '+(d.type==='Company' ?'selected':'')+'>Company</option>'+
    '</select>'+
    '<button class="rb" onclick="teamDays.splice('+i+',1);autoSave();renderTDO();recalc()">×</button></div>'
  ).join('');
  document.getElementById('tdo-chip').textContent=teamDays.length+' day'+(teamDays.length!==1?'s':'');
}
function addTDO() {
  const s=document.getElementById('start-date').value||getSD().startDate;
  const e=document.getElementById('end-date').value||getSD().endDate;
  const ex=new Set(teamDays.map(d=>d.date)); let cur=parseDate(s); const end=parseDate(e); let sg='';
  while(cur<=end){const iso=isoDate(cur); if(cur.getDay()!==0&&cur.getDay()!==6&&!ex.has(iso)){sg=iso;break;} cur.setDate(cur.getDate()+1);}
  teamDays.push({date:sg,type:'Holiday',note:''}); autoSave(); renderTDO(); recalc();
}


// ── AVAILABILITY BARS ──────────────────────────────────────────────────────────
function renderAvail() {
  const activeMembers = members.filter(m => asgnFor(m.name) > 0);
  document.getElementById('avail-list').innerHTML = activeMembers.map(m=>{
    const asgn=asgnFor(m.name), logged=logFor(m.name);
    const remaining = Math.max(0, asgn - logged);
    const p = asgn>0 ? Math.round(remaining/asgn*100) : 0;
    const col = p===0?'var(--green)':p<30?'var(--amber)':'var(--blue)';
    return '<div class="ar"><div class="ar-hd">'+
      '<span style="color:var(--t2);font-size:12px">'+sanitize(m.name)+'</span>'+
      '<span style="color:var(--t3);font-size:11px">'+remaining+'h remaining / '+asgn+'h assigned ('+p+'% left)</span></div>'+
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
  const sd = getSD();
  const startStr = (sd&&sd.startDate) || document.getElementById('start-date').value || '';
  const endStr   = (sd&&sd.endDate)   || document.getElementById('end-date').value   || '';
  const s = parseDate(startStr), e = parseDate(endStr);
  if (!s || !e) return;

  const todayIso = isoDate(new Date());
  const off = new Set(teamDays.map(d => d.date));

  // Working days list (no weekends, no team days off)
  const workDays = [];
  const cur = new Date(s);
  while (cur <= e) {
    const dow = cur.getDay(), iso = isoDate(cur);
    if (dow !== 0 && dow !== 6 && !off.has(iso)) workDays.push(iso);
    cur.setDate(cur.getDate()+1);
  }
  if (!workDays.length) return;

  const activeMembers = members.filter(m => asgnFor(m.name) > 0);
  const originalScope  = activeMembers.reduce((a,m) => a + asgnFor(m.name), 0);
  const totalLogged    = activeMembers.reduce((a,m) => a + logFor(m.name),  0);
  const remainingNow   = Math.max(0, originalScope - totalLogged);

  // Total team capacity for sprint = sum of all active member caps
  const totalCapacity  = activeMembers.reduce((a,m) => a + cap(m), 0);

  const n = workDays.length;
  const pivotIdx = workDays.findIndex(d => d >= todayIso);
  const pivot = pivotIdx === -1 ? n-1 : Math.min(pivotIdx, n-1);
  const daysLeft = n - 1 - pivot;
  const pctDone  = originalScope > 0 ? Math.round(totalLogged/originalScope*100) : 0;

  // ── IDEAL TREND ───────────────────────────────────────────────────────────
  // Grey line: originalScope → 0 linearly across all working days
  const ideal = workDays.map((_,i) =>
    Math.round(originalScope * (1 - i/Math.max(n-1,1)) * 10) / 10
  );

  // ── REMAINING WORK ────────────────────────────────────────────────────────
  // Blue filled: actual hours remaining (assigned - logged from Jira)
  // Anchored: day 0 = originalScope, today = remainingNow, future = null
  const remaining = workDays.map((_,i) => {
    if (i > pivot) return null;
    if (i === 0)   return originalScope;
    if (i === pivot) return remainingNow;
    return Math.round((originalScope - (originalScope - remainingNow) * (i/Math.max(pivot,1))) * 10) / 10;
  });

  // ── REMAINING CAPACITY ────────────────────────────────────────────────────
  // Counts down from totalCapacity at sprint start → 0 at sprint end
  // capPerDay = total team hours / working days in sprint
  // This correctly accounts for all active members × their hrs/day
  const capPerDay = totalCapacity / Math.max(n, 1);
  const remainingCap = workDays.map((_,i) => {
    const capLeft = Math.max(0, totalCapacity - capPerDay * i);
    return Math.round(capLeft * 10) / 10;
  });

  // KPI: capacity remaining from today forward
  const capLeftNow = Math.max(0, Math.round(capPerDay * daysLeft * 10) / 10);

  const labels = workDays.map(d => {
    const [,m,day] = d.split('-');
    return parseInt(m)+'/'+parseInt(day);
  });

  // ── KPI CALCULATIONS (matching Azure DevOps) ──────────────────────────────
  const completedPct  = pctDone; // % of scope logged
  // Average daily burndown = total logged / days elapsed (negative = burning down)
  const daysElapsed   = pivot; // days since sprint start
  const avgBurndown   = daysElapsed > 0 ? Math.round((totalLogged / daysElapsed) * 10) / 10 : 0;
  const notEstimated  = 0; // issues table removed
  // Total scope increase = 0 for now (rises if work added mid-sprint)
  const scopeIncrease = 0;

  // Update or create KPI strip above chart
  let kpi = document.getElementById('bd-kpis');
  if (!kpi) {
    kpi = document.createElement('div');
    kpi.id = 'bd-kpis';
    kpi.style.cssText = 'display:flex;gap:20px;justify-content:space-between;align-items:flex-end;margin-bottom:10px;flex-wrap:wrap';
    document.getElementById('burndown-chart').parentElement.before(kpi);
  }
  const chip = (label, val, col, sub) =>
    '<div style="text-align:left"><div style="font-size:10px;color:var(--t3);text-transform:uppercase;letter-spacing:.08em;white-space:nowrap">'+label+'</div>'+
    '<div style="font-size:26px;font-weight:300;line-height:1;color:'+(col||'var(--t1)')+'">'+val+'</div>'+
    (sub ? '<div style="font-size:10px;color:var(--t3)">'+sub+'</div>' : '')+
    '</div>';
  kpi.innerHTML =
    chip('Completed', completedPct+'%', completedPct > 80 ? 'var(--green)' : 'var(--t1)') +
    chip('Avg Burndown', (avgBurndown > 0 ? '-' : '')+avgBurndown+'h/day', 'var(--t1)', 'per working day') +
    chip('Items not estimated', notEstimated, notEstimated > 0 ? 'var(--amber)' : 'var(--t1)') +
    chip('Total Scope Increase', (scopeIncrease > 0 ? '+' : '')+scopeIncrease+'h', scopeIncrease > 0 ? 'var(--amber)' : 'var(--t1)') +
    chip('Remaining Work', remainingNow+'h', remainingNow > capLeftNow ? 'var(--red)' : 'var(--t1)', remainingNow > capLeftNow ? '⚠ exceeds capacity' : 'of '+originalScope+'h scope');

  if (charts.bd) charts.bd.destroy();
  charts.bd = new Chart(document.getElementById('burndown-chart'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Ideal Trend',
          data: ideal,
          borderColor: 'rgba(180,180,180,.5)',
          borderWidth: 1.5,
          borderDash: [],
          pointRadius: 0,
          fill: false,
          tension: 0,
          order: 3
        },
        {
          label: 'Remaining Capacity',
          data: remainingCap,
          borderColor: 'rgba(0,212,170,.7)',
          borderWidth: 1.5,
          borderDash: [5,4],
          pointRadius: 0,
          fill: false,
          tension: 0,
          order: 2
        },
        {
          label: 'Remaining',
          data: remaining,
          borderColor: '#4da6ff',
          backgroundColor: 'rgba(77,166,255,.25)',
          borderWidth: 2,
          pointRadius: (ctx) => ctx.dataIndex === pivot ? 5 : 0,
          pointBackgroundColor: '#4da6ff',
          fill: true,
          tension: 0,
          spanGaps: false,
          order: 1
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          position: 'bottom',
          align: 'start',
          labels: { color: '#5a6580', font: { size: 10 }, boxWidth: 20, padding: 12, usePointStyle: true }
        },
        tooltip: {
          callbacks: {
            title: items => workDays[items[0]?.dataIndex] || '',
            label: ctx => {
              if (ctx.raw === null) return null;
              return ctx.dataset.label + ': ' + ctx.raw + 'h';
            },
            afterBody: items => {
              const idx = items[0]?.dataIndex;
              return workDays[idx] === todayIso ? ['Today'] : [];
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,.04)' },
          ticks: { color: '#5a6580', font: { size: 10 }, maxTicksLimit: 10 }
        },
        y: {
          grid: { color: 'rgba(255,255,255,.04)' },
          ticks: { color: '#5a6580', font: { size: 10 }, precision: 0 },
          min: 0,
          max: Math.ceil(Math.max(originalScope, totalCapacity) * 1.05) || 10,
          title: { display: true, text: 'Hours', color: '#5a6580', font: { size: 10 } }
        }
      }
    }
  });
}

// ── RECALC / RENDER ALL ────────────────────────────────────────────────────────
function recalc() {
  const active = members.filter(m => asgnFor(m.name) > 0);
  const tc = active.reduce((a,m) => a+cap(m), 0);
  const ta = active.reduce((a,m) => a+asgnFor(m.name), 0);
  const tl = active.reduce((a,m) => a+logFor(m.name), 0);
  const tp = tdo();

  document.getElementById('k-cap').textContent=tc;
  document.getElementById('k-asgn').textContent=ta;
  document.getElementById('k-rem').textContent=Math.round((tl/Math.max(ta,1))*100)+'%';
  document.getElementById('k-rem-sub').textContent=tl+'h logged of '+ta+'h assigned';
  document.getElementById('k-util').textContent=tc>0?Math.round(tl/tc*100)+'%':'0%';
  document.getElementById('k-pto').textContent=tp;
  renderMembers(); renderAvail(); renderCal(); renderBurndown();
}

function renderAll() { renderTDO(); recalc(); }

async function refreshFromJira() {
  const btn=document.getElementById('refresh-btn');
  if(btn){btn.textContent='Ask Claude ↗';btn.disabled=false;}
  alert('To refresh sprint data on demand, ask Claude:\n"Refresh the WBS sprint dashboard"\n\nAutomatic refresh runs every hour.');
}

load();
