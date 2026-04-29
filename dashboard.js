// ── SHARED DATA CONFIG ──────────────────────────────────────────────────────
// data.json is written daily by GitHub Actions (fetch_jira_data.py).
// Claude can also inject live data via window.__injectTeamData() for
// on-demand refreshes using the Chrome extension.
// On Save: changes persist to localStorage, Jira, and Confluence.
// GitHub data.json is updated only by the daily Action — never from the browser.
const REPO     = 'julia7lukas/wbs-dashboard';
const DATA_URL     = 'https://raw.githubusercontent.com/' + REPO + '/main/data.json?cb=' + Date.now();
const CAPACITY_URL = 'https://raw.githubusercontent.com/' + REPO + '/main/capacity.json?cb=' + Date.now();
const GITHUB_API   = 'https://api.github.com/repos/' + REPO + '/contents/capacity.json';
const ANTHROPIC_API  = 'https://api.anthropic.com/v1/messages';
const ATLASSIAN_MCP  = 'https://mcp.atlassian.com/v1/sse';
const CONFLUENCE_PAGE_IDS = { WBS:'6627524645', GIN:null, MOJO:null, MAV:null, AMGO:null };

let TEAMS = {};
let _planningMode = false; // true when planning view is active
let _planningTeam = null;  // which team is being planned
let _planningSprint = null; // which sprint is selected in planning

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
let _issueSnapshot = {};

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
function saveCapacity(projectKey, sprintName, members, teamDays, savedBy) {
  try {
    localStorage.setItem(cacheKey(projectKey, sprintName),
      JSON.stringify({
        sprintName,
        members: members.map(m=>({...m})),
        teamDays: teamDays.map(d=>({...d})),
        lastSavedBy: savedBy || 'Unknown',
        lastSavedAt: new Date().toISOString()
      }));
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


// ── SAVE CAPACITY TO GITHUB (shared persistence for all users) ───────────────
// Routes through Anthropic API → Claude → GitHub API → capacity.json
// This means ANY user's Save pushes to the repo so everyone sees it.
async function saveCapacityToGitHub(allCapacity) {
  if (!isAllowedOrigin()) throw new Error('Unauthorized origin');
  const prompt =
    'Using the GitHub API, update the file capacity.json in the repository ' + REPO + '. ' +
    'The file should contain exactly this JSON (do not modify it, use it verbatim):\n' +
    JSON.stringify(allCapacity, null, 2) + '\n\n' +
    'Steps: 1) GET https://api.github.com/repos/' + REPO + '/contents/capacity.json to get the current SHA. ' +
    '2) PUT https://api.github.com/repos/' + REPO + '/contents/capacity.json with the new content (base64 encoded), the SHA, and commit message "Update capacity.json". ' +
    'Use the github tool or make the API calls directly. Return only "OK" when done.';
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) throw new Error('Anthropic API error: ' + res.status);
  return 'OK';
}

// Build the full capacity object across all teams/sprints from localStorage
function buildAllCapacity() {
  const result = {};
  Object.keys(TEAMS).forEach(teamKey => {
    const SD = TEAMS[teamKey];
    const allSprints = SD.allSprints || [{ name: SD.sprintName }];
    result[teamKey] = {};
    allSprints.forEach(s => {
      const saved = loadSavedCapacity(SD.projectKey, s.name);
      if (saved) result[teamKey][s.name] = saved;
    });
  });
  return result;
}

// Load shared capacity.json and merge into localStorage
async function loadSharedCapacity() {
  try {
    const res = await fetch(CAPACITY_URL);
    if (!res.ok) return;
    const data = await res.json();
    let merged = 0;
    Object.keys(data).forEach(teamKey => {
      const SD = TEAMS[teamKey];
      if (!SD) return;
      Object.keys(data[teamKey]).forEach(sprintName => {
        const remote = data[teamKey][sprintName];
        const local  = loadSavedCapacity(SD.projectKey, sprintName);
        // Remote wins if newer or no local copy
        const remoteTime = remote.lastSavedAt ? new Date(remote.lastSavedAt) : new Date(0);
        const localTime  = local && local.lastSavedAt ? new Date(local.lastSavedAt) : new Date(0);
        if (remoteTime >= localTime) {
          saveCapacity(SD.projectKey, sprintName, remote.members, remote.teamDays, remote.lastSavedBy);
          merged++;
        }
      });
    });
    if (merged > 0) console.log('Loaded', merged, 'capacity entries from capacity.json');
  } catch(e) {
    console.log('capacity.json not found yet (will be created on first Save)');
  }
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
  setTimeout(initPlanningBanner, 0);
}

const AVC = ['#00d4aa','#4da6ff','#a78bfa','#f472b6','#fbbf24','#f87171','#34d399','#60a5fa'];
const AVB = AVC.map(c => c + '22');
function ini(n) { return (n||'').trim().split(/\s+/).map(w=>w[0]||'').join('').toUpperCase().slice(0,2)||'?'; }

let members, teamDays, charts = {};
function getSD()       { return TEAMS[currentTeam]; }
function parseDate(s)  { if (!s) return null; const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); }
function isoDate(d)    { return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }

// ── PLANNING VIEW ────────────────────────────────────────────────────────────────

function openPlanning() {
  _planningMode = true;
  _planningTeam = currentTeam;
  _planningSprint = null;
  document.querySelector('.main').style.display = 'none';
  document.getElementById('planning-view').style.display = 'block';
  document.getElementById('planning-btn').textContent = 'x Close';
  renderPlanningView();
}

function closePlanning() {
  _planningMode = false;
  document.querySelector('.main').style.display = '';
  document.getElementById('planning-view').style.display = 'none';
  document.getElementById('planning-btn').textContent = 'Select Sprint';
  renderAll();
}

function getAllSprintsForAllTeams() {
  var result = {};
  Object.keys(TEAMS).forEach(function(k) {
    var sd = TEAMS[k];
    var all = sd.allSprints || [{ name: sd.sprintName, startDate: sd.startDate, endDate: sd.endDate, state: 'active' }];
    result[k] = all;
  });
  return result;
}

function renderPlanningView() {
  var pv = document.getElementById('planning-view');
  if (!pv) return;

  var SD = TEAMS[_planningTeam];
  if (!SD) { pv.innerHTML = '<div style="padding:40px;color:var(--t3)">No team data loaded.</div>'; return; }

  var allSprints = SD.allSprints || [{ name: SD.sprintName, startDate: SD.startDate, endDate: SD.endDate, state: 'active' }];
  var selName = _planningSprint || SD.sprintName;
  var selSprint = allSprints.find(function(s){ return s.name === selName; }) || allSprints[0];
  if (!_planningSprint) _planningSprint = selSprint.name;

  var saved = loadSavedCapacity(SD.projectKey, selSprint.name);
  var planMembers = saved ? saved.members.map(function(m){ return Object.assign({},m); }) 
                          : SD.members.map(function(m){ return { name:m.name, hrs:6, pto:0 }; });
  var planDays = saved ? saved.teamDays.map(function(d){ return Object.assign({},d); }) : [];
  var wdays = 10;

  // Sprint dropdown — all teams, all active + future sprints
  var allTeamSprints = getAllSprintsForAllTeams();
  var sprintOptHtml = '';
  Object.keys(allTeamSprints).forEach(function(teamKey) {
    var sprints = allTeamSprints[teamKey];
    sprintOptHtml += '<optgroup label="' + teamKey + ' — ' + sanitize(TEAMS[teamKey].team) + '">';
    sprints.forEach(function(s) {
      var sel = (teamKey === _planningTeam && s.name === selSprint.name) ? ' selected' : '';
      sprintOptHtml += '<option value="' + teamKey + '||' + sanitize(s.name) + '"' + sel + '>'
        + sanitize(s.name) + ' (' + s.startDate + ' to ' + s.endDate + ')'
        + (s.state === 'active' ? ' · Active' : ' · Future') + '</option>';
    });
    sprintOptHtml += '</optgroup>';
  });

  // Saved by line
  var savedLine = '';
  if (saved && saved.lastSavedBy && saved.lastSavedAt) {
    var at = new Date(saved.lastSavedAt).toLocaleString('en-US',{dateStyle:'short',timeStyle:'short',timeZone:'America/Chicago'});
    savedLine = '<div style="font-size:11px;color:var(--t3);margin-top:10px">Last saved by <strong style="color:var(--t2)">'
      + sanitize(saved.lastSavedBy) + '</strong> · ' + at + '</div>';
  } else {
    savedLine = '<div style="font-size:11px;color:var(--amber);margin-top:10px">Not yet set for this sprint</div>';
  }

  // Member rows
  var memberRows = '';
  planMembers.forEach(function(m, i) {
    var net = Math.max(0, (wdays - planDays.length - (m.pto||0)) * (m.hrs||6));
    memberRows += '<tr class="dr">'
      + '<td><div class="mc"><div class="av" style="background:' + AVB[i%8] + ';color:' + AVC[i%8] + '">' + sanitize(ini(m.name)) + '</div>'
      + '<span style="font-size:13px;color:var(--t1)">' + sanitize(m.name) + '</span></div></td>'
      + '<td class="c"><input class="ni" type="number" min="1" max="12" value="' + (m.hrs||6) + '" oninput="onPlanMemberChange(' + i + ',\'hrs\',+this.value)"></td>'
      + '<td class="c"><input class="ni" type="number" min="0" value="' + (m.pto||0) + '" oninput="onPlanMemberChange(' + i + ',\'pto\',+this.value)"></td>'
      + '<td class="c netc" id="plan-net-' + i + '">' + net + 'h</td>'
      + '</tr>';
  });
  var totalCap = planMembers.reduce(function(a,m){ return a + Math.max(0,(wdays-planDays.length-(m.pto||0))*(m.hrs||6)); }, 0);

  // Team days off rows
  var tdoRows = '';
  planDays.forEach(function(d, i) {
    tdoRows += '<div class="dor">'
      + '<input type="date" class="si2" style="font-size:11px;padding:3px 5px" value="' + (d.date||'') + '" oninput="onPlanDayChange(' + i + ',\'date\',this.value)">'
      + '<select class="si2" style="font-size:11px;padding:3px 5px" onchange="onPlanDayChange(' + i + ',\'type\',this.value)">'
      + '<option ' + (d.type==='Holiday'?'selected':'') + '>Holiday</option>'
      + '<option ' + (d.type==='Recharge'?'selected':'') + '>Recharge</option>'
      + '<option ' + (d.type==='Company'?'selected':'') + '>Company</option>'
      + '</select>'
      + '<button class="rb" onclick="onPlanDayRemove(' + i + ')">x</button>'
      + '</div>';
  });

  pv.innerHTML = ''
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px">'
    +   '<div><div style="font-size:18px;font-weight:500;color:var(--t1)">Sprint Planning</div>'
    +   '<div style="font-size:11px;color:var(--t3);margin-top:2px">Select a sprint and set each member availability. Auto-saves as you edit.</div></div>'
    + '</div>'
    // Sprint selector card
    + '<div class="card" style="margin-bottom:16px;padding:14px 18px">'
    +   '<div style="display:grid;grid-template-columns:1fr 150px 150px 130px;gap:12px;align-items:end">'
    +     '<div class="field"><div class="fl">Sprint</div>'
    +       '<select class="fi" id="plan-sprint-select" onchange="onPlanSprintChange(this.value)">' + sprintOptHtml + '</select>'
    +     '</div>'
    +     '<div class="field"><div class="fl">Start date</div>'
    +       '<input class="fi" type="date" id="plan-start" value="' + selSprint.startDate + '" readonly style="opacity:.7">'
    +     '</div>'
    +     '<div class="field"><div class="fl">End date</div>'
    +       '<input class="fi" type="date" id="plan-end" value="' + selSprint.endDate + '" readonly style="opacity:.7">'
    +     '</div>'
    +     '<div class="field"><div class="fl">Working days</div>'
    +       '<input class="fi" type="number" id="plan-workdays" value="' + wdays + '" min="1" max="30" oninput="onPlanWorkdaysChange(+this.value)">'
    +     '</div>'
    +   '</div>'
    +   savedLine
    + '</div>'
    // Capacity + days off
    + '<div style="display:grid;grid-template-columns:1fr 280px;gap:12px">'
    +   '<div class="card">'
    +     '<div class="ctit" style="margin-bottom:12px">Member capacity</div>'
    +     '<table><thead><tr>'
    +       '<th>Member</th><th class="c">Hrs/day</th><th class="c">PTO days</th><th class="c">Net capacity</th>'
    +     '</tr></thead><tbody id="plan-members">' + memberRows + '</tbody>'
    +     '<tfoot><tr class="tr2"><td>Total</td><td></td><td></td>'
    +       '<td class="c netc" id="plan-total-cap">' + totalCap + 'h</td>'
    +     '</tr></tfoot></table>'
    +   '</div>'
    +   '<div class="card-sm">'
    +     '<div class="chd" style="margin-bottom:8px">'
    +       '<div><div class="ctit">Days off</div><div style="font-size:10px;color:var(--t3)">Deducted from all members</div></div>'
    +       '<span class="chip" id="plan-tdo-chip">' + planDays.length + ' day' + (planDays.length!==1?'s':'') + '</span>'
    +     '</div>'
    +     '<div style="display:grid;grid-template-columns:100px 90px 16px;gap:4px;margin-bottom:5px;padding-bottom:5px;border-bottom:1px solid var(--bdr)">'
    +       '<span class="clbl">Date</span><span class="clbl">Type</span><span></span>'
    +     '</div>'
    +     '<div id="plan-tdo-list">' + tdoRows + '</div>'
    +     '<button class="addl" onclick="onPlanDayAdd()">+ Add day</button>'
    +   '</div>'
    + '</div>';
}

// ── PLANNING EVENT HANDLERS ────────────────────────────────────────────────────
function getPlanState() {
  var SD = TEAMS[_planningTeam];
  var allSprints = SD.allSprints || [{ name: SD.sprintName, startDate: SD.startDate, endDate: SD.endDate }];
  var selSprint = allSprints.find(function(s){ return s.name === _planningSprint; }) || allSprints[0];
  var saved = loadSavedCapacity(SD.projectKey, selSprint.name);
  var planMembers = saved ? saved.members.map(function(m){ return Object.assign({},m); })
                          : SD.members.map(function(m){ return { name:m.name, hrs:6, pto:0 }; });
  var planDays = saved ? saved.teamDays.map(function(d){ return Object.assign({},d); }) : [];
  return { SD:SD, selSprint:selSprint, planMembers:planMembers, planDays:planDays };
}

function planAutoSave(planMembers, planDays) {
  var SD = TEAMS[_planningTeam];
  var allSprints = SD.allSprints || [];
  var selSprint = allSprints.find(function(s){ return s.name === _planningSprint; }) || { name: SD.sprintName };
  var savedBy = (TEAMS[_planningTeam] && TEAMS[_planningTeam].team) || 'Team member';
  saveCapacity(SD.projectKey, selSprint.name, planMembers, planDays, savedBy);
}

function recalcPlanTotals(planMembers, planDays) {
  var wdays = parseInt((document.getElementById('plan-workdays') && document.getElementById('plan-workdays').value) || 10);
  var total = 0;
  planMembers.forEach(function(m, i) {
    var net = Math.max(0, (wdays - planDays.length - (m.pto||0)) * (m.hrs||6));
    var el = document.getElementById('plan-net-' + i);
    if (el) el.textContent = net + 'h';
    total += net;
  });
  var tc = document.getElementById('plan-total-cap');
  if (tc) tc.textContent = total + 'h';
  var chip = document.getElementById('plan-tdo-chip');
  if (chip) chip.textContent = planDays.length + ' day' + (planDays.length!==1?'s':'');
}

function onPlanSprintChange(val) {
  // val = "TEAMKEY||SprintName"
  var parts = val.split('||');
  _planningTeam = parts[0];
  _planningSprint = parts.slice(1).join('||');
  renderPlanningView();
}

function onPlanMemberChange(idx, field, val) {
  var state = getPlanState();
  state.planMembers[idx][field] = Math.max(field==='pto'?0:1, val||0);
  planAutoSave(state.planMembers, state.planDays);
  recalcPlanTotals(state.planMembers, state.planDays);
}

function onPlanWorkdaysChange(val) {
  var state = getPlanState();
  recalcPlanTotals(state.planMembers, state.planDays);
}

function onPlanDayChange(idx, field, val) {
  var state = getPlanState();
  state.planDays[idx][field] = val;
  planAutoSave(state.planMembers, state.planDays);
  recalcPlanTotals(state.planMembers, state.planDays);
}

function onPlanDayRemove(idx) {
  var state = getPlanState();
  state.planDays.splice(idx, 1);
  planAutoSave(state.planMembers, state.planDays);
  renderPlanningView();
}

function onPlanDayAdd() {
  var state = getPlanState();
  var s = state.selSprint.startDate, e = state.selSprint.endDate;
  var ex = new Set(state.planDays.map(function(d){ return d.date; }));
  var cur = parseDate(s), end = parseDate(e), sg = '';
  while(cur && end && cur<=end) {
    var iso = isoDate(cur);
    if(cur.getDay()!==0 && cur.getDay()!==6 && !ex.has(iso)){ sg=iso; break; }
    cur.setDate(cur.getDate()+1);
  }
  state.planDays.push({ date:sg, type:'Holiday', note:'' });
  planAutoSave(state.planMembers, state.planDays);
  renderPlanningView();
}

// ── PLANNING BANNER ────────────────────────────────────────────────────────────
function updatePlanningBanner(savedBy) {
  var sd = getSD();
  var saved = sd ? loadSavedCapacity(sd.projectKey, sd.sprintName) : null;
  var banner = document.getElementById('planning-banner');
  if (!banner) return;
  var by = savedBy || (saved && saved.lastSavedBy);
  var atRaw = saved && saved.lastSavedAt;
  var at = atRaw ? new Date(atRaw).toLocaleString('en-US',{dateStyle:'short',timeStyle:'short',timeZone:'America/Chicago'}) : null;
  banner.style.display = 'flex';
  if (by && at) {
    banner.innerHTML = '<span style="font-size:12px;color:var(--t2)">Capacity last saved by <strong style="color:var(--green)">'
      + sanitize(by) + '</strong> &middot; ' + at + '</span>';
  } else {
    banner.style.display = 'none';
  }
}

function initPlanningBanner() {
  var sd = getSD();
  var saved = sd ? loadSavedCapacity(sd.projectKey, sd.sprintName) : null;
  updatePlanningBanner(saved && saved.lastSavedBy);
}


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
        // Load shared capacity.json first, then render
        await loadSharedCapacity();
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

  // 1. Save current sprint to localStorage immediately
  saveCapacity(s.projectKey, s.sprintName, members, teamDays,
    (TEAMS[currentTeam] && TEAMS[currentTeam].team) || 'Team');

  // 2. Push all teams' capacity to GitHub (shared persistence)
  let githubStatus = '';
  let confluenceStatus = '';
  const allCap = buildAllCapacity();

  await Promise.all([
    saveCapacityToGitHub(allCap)
      .then(()  => { githubStatus = ' · GitHub ✓'; })
      .catch(e  => { console.error('GitHub capacity save failed:', e); githubStatus = ' · GitHub ✗'; }),
    syncCapacityToConfluence()
      .then(()  => { confluenceStatus = ' · Confluence ✓'; })
      .catch(e  => { console.error('Confluence sync failed:', e); confluenceStatus = ' · Confluence ✗'; })
  ]);

  _removedMembers = [];

  if (btn) { btn.disabled = false; btn.textContent = '✓ Save changes'; }
  if (el)  el.textContent = (el.textContent||'').replace(/ · (Saving|Saved|Jira|GitHub|Confluence).*/g, '') +
    githubStatus + confluenceStatus + ' · Saved ✓';
}

// ── CAPACITY HELPERS ──────────────────────────────────────────────────────────
function wd()       { const v = parseInt(document.getElementById('work-days').value); return Math.max(1, isNaN(v) ? 10 : v); }
function hd()       { const v = parseInt(document.getElementById('hrs-day').value);  return Math.max(1, isNaN(v) ? 6  : v); }
function tdo()      { return teamDays.length; }
function cap(m)     { const domWd = parseInt(document.getElementById('work-days').value); const sd = getSD(); const days = (!isNaN(domWd) && domWd > 0) ? domWd : (sd && sd.workDays ? sd.workDays : 10); return Math.max(0, days-tdo()-(m.pto||0)) * (m.hrs||hd()); }
function asgnFor(n) { if (window._planningFutureSprint) return 0; const sd=getSD(); return sd&&sd.subtaskHrs ? (sd.subtaskHrs[n]||{}).est||0    : 0; }
function logFor(n)  { if (window._planningFutureSprint) return 0; const sd=getSD(); return sd&&sd.subtaskHrs ? (sd.subtaskHrs[n]||{}).logged||0 : 0; }


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
  // For future sprint planning — show all members even with 0 assigned hours
  const showAll = window._planningFutureSprint === true;
  tb.innerHTML = members.map((m, i) => ({m, i})).filter(({m}) => showAll || asgnFor(m.name) > 0).map(({m, i}) => {
    const c = cap(m);
    const asgn = asgnFor(m.name);
    const logged = logFor(m.name);
    const remaining = Math.max(0, asgn - logged);
    // Util = logged vs capacity (actual progress)
    // Remaining is amber when hours left, green when done
    const remCol = remaining > 0 ? 'var(--amber)' : 'var(--green)';
    return '<tr class="dr">'+
      '<td><div class="mc"><div class="av" style="background:'+AVB[i%8]+';color:'+AVC[i%8]+'">'+ini(m.name)+'</div>'+
      '<input style="background:transparent;border:none;color:var(--t1);font-family:var(--font);font-size:13px;width:130px" value="'+sanitize(m.name)+'" data-name-idx="'+i+'"></div></td>'+
      '<td class="c"><input class="ni" type="number" min="1" max="12" value="'+(m.hrs||hd())+'" data-hrs-idx="'+i+'"></td>'+
      '<td class="c"><input class="ni" type="number" min="0" value="'+(m.pto||0)+'" data-pto-idx="'+i+'"></td>'+
      '<td class="c netc" data-cap-idx="'+i+'">'+c+'h</td>'+
      '<td class="c" style="color:var(--blue)">'+asgn+'h</td>'+
      '<td class="c" style="color:var(--t2)">'+logged+'h</td>'+
      '<td class="c"><div style="font-size:12px;font-weight:600;color:'+remCol+'">'+remaining+'h</div></td>'+
      '<td><button class="rb" data-remove-idx="'+i+'">×</button></td></tr>';
  }).join('')+
  '<tr><td colspan="8" style="padding:6px 0"><button class="addl" id="add-member-btn">+ Add team member</button></td></tr>';

  // Totals only for members with assigned hours (hidden members excluded entirely)
  const activeMembers = (window._planningFutureSprint === true) ? members : members.filter(m => asgnFor(m.name) > 0);
  const tp = activeMembers.reduce((a,m) => a+(m.pto||0), 0);
  const tc = activeMembers.reduce((a,m) => a+cap(m), 0);
  const ta = activeMembers.reduce((s,m) => s+asgnFor(m.name), 0);
  const tl = activeMembers.reduce((s,m) => s+logFor(m.name), 0);
  const tr2 = Math.max(0, ta-tl);
  // Attach event listeners (CSP blocks inline onclick/oninput)
  tb.querySelectorAll('[data-remove-idx]').forEach(btn => {
    btn.addEventListener('click', () => removeMember(+btn.dataset.removeIdx));
  });
  tb.querySelectorAll('[data-hrs-idx]').forEach(inp => {
    inp.addEventListener('input', () => {
      const i = +inp.dataset.hrsIdx;
      members[i].hrs = Math.max(1, +inp.value || hd());
      const capCell = tb.querySelector('[data-cap-idx="'+i+'"]');
      if (capCell) capCell.textContent = cap(members[i]) + 'h';
      // Update KPI totals without full re-render
      const activeM = (window._planningFutureSprint === true) ? members : members.filter(m => asgnFor(m.name) > 0);
      const tc = activeM.reduce((a,m) => a+cap(m), 0);
      document.getElementById('k-cap').textContent = tc;
      document.getElementById('k-util').textContent = tc>0 ? Math.round(activeM.reduce((a,m)=>a+asgnFor(m.name),0)/tc*100)+'%' : '0%';
      document.getElementById('t-cap').textContent = tc+'h';
      autoSave();
    });
  });
  tb.querySelectorAll('[data-pto-idx]').forEach(inp => {
    inp.addEventListener('input', () => {
      const i = +inp.dataset.ptoIdx;
      members[i].pto = Math.max(0, +inp.value || 0);
      const capCell = tb.querySelector('[data-cap-idx="'+i+'"]');
      if (capCell) capCell.textContent = cap(members[i]) + 'h';
      const activeM = (window._planningFutureSprint === true) ? members : members.filter(m => asgnFor(m.name) > 0);
      const tc = activeM.reduce((a,m) => a+cap(m), 0);
      document.getElementById('k-cap').textContent = tc;
      document.getElementById('k-util').textContent = tc>0 ? Math.round(activeM.reduce((a,m)=>a+asgnFor(m.name),0)/tc*100)+'%' : '0%';
      document.getElementById('t-cap').textContent = tc+'h';
      autoSave();
    });
  });
  tb.querySelectorAll('[data-name-idx]').forEach(inp => {
    inp.addEventListener('change', () => {
      members[+inp.dataset.nameIdx].name = inp.value.trim();
      autoSave(); renderAll();
    });
  });
  const addBtn = document.getElementById('add-member-btn');
  if (addBtn) addBtn.addEventListener('click', addMemberPrompt);

  document.getElementById('t-pto').textContent = tp;
  document.getElementById('t-cap').textContent = tc+'h';
  const ea=document.getElementById('t-asgn'); if(ea) ea.textContent=ta+'h';
  const el=document.getElementById('t-log');  if(el) el.textContent=tl+'h';
  const er=document.getElementById('t-rem2'); if(er) er.textContent=tr2+'h';
}

// ── AUTO-SAVE — persists to localStorage instantly on every change ────────────
// This ensures changes survive tab close/open without needing to hit Save.
// Save button additionally pushes to Jira + Confluence.
function autoSave(savedBy) {
  const s = getSD();
  if (!s) return;
  saveCapacity(s.projectKey, s.sprintName, members, teamDays, savedBy);
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
    '<button class="rb" data-tdo-idx="'+i+'">×</button></div>'
  ).join('');
  document.getElementById('tdo-chip').textContent=teamDays.length+' day'+(teamDays.length!==1?'s':'');
  document.getElementById('tdo-list').querySelectorAll('[data-tdo-idx]').forEach(btn => {
    btn.addEventListener('click', () => { teamDays.splice(+btn.dataset.tdoIdx,1); autoSave(); renderTDO(); recalc(); });
  });
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
  const activeMembers = (window._planningFutureSprint === true) ? members : members.filter(m => asgnFor(m.name) > 0);
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

// ── SPRINT SELECTOR CHIPS ─────────────────────────────────────────────────────
function renderSprintChips() {
  const container = document.getElementById('sprint-chips');
  if (!container || !currentTeam) return;
  const SD = TEAMS[currentTeam];
  if (!SD) return;
  const allSprints = SD.allSprints || [{ name: SD.sprintName, startDate: SD.startDate, endDate: SD.endDate, state: 'active' }];
  const activePlanSprint = window._activePlanSprint || SD.sprintName;
  const buttons = allSprints.map((s, chipIdx) => {
    const isSelected = s.name === activePlanSprint;
    const isActive   = s.state === 'active';
    const saved = loadSavedCapacity(SD.projectKey, s.name);
    const hasSaved = saved && saved.lastSavedBy;
    const btn = document.createElement('button');
    btn.dataset.chipIdx = chipIdx;
    btn.style.cssText = 'padding:4px 10px;font-size:11px;font-weight:600;border-radius:6px;cursor:pointer;border:1px solid;font-family:var(--font);'
      + (isSelected
          ? 'background:var(--green);color:#000;border-color:var(--green);'
          : isActive
            ? 'background:var(--bg3);color:var(--t1);border-color:var(--bdr2);'
            : 'background:transparent;color:var(--t3);border-color:var(--bdr);opacity:.7;');
    btn.textContent = s.name + (isActive ? ' · Active' : '') + (hasSaved && !isActive ? ' ✓' : '');
    btn.addEventListener('click', function() { onSprintChipClick(chipIdx); });
    return btn;
  });
  container.innerHTML = '';
  buttons.forEach(b => container.appendChild(b));
}

function onSprintChipClick(idx) {
  const SD = TEAMS[currentTeam];
  if (!SD) return;
  const allSprints = SD.allSprints || [{ name: SD.sprintName, startDate: SD.startDate, endDate: SD.endDate, state: 'active' }];
  const sel = allSprints[idx];
  if (!sel) return;
  const sprintName = sel.name;
  window._activePlanSprint = sprintName;
  window._planningFutureSprint = sel.state !== 'active'; // flag for renderMembers
  const isActive = sel.state === 'active';

  if (isActive) {
    window._planningFutureSprint = false;
    members  = SD.members.map(m => ({...m}));
    teamDays = SD.teamDays ? SD.teamDays.map(d => ({...d})) : [];
    const saved = loadSavedCapacity(SD.projectKey, sprintName);
    if (saved) {
      const savedMap = Object.fromEntries(saved.members.map(m => [m.name, m]));
      members  = SD.members.map(m => savedMap[m.name] ? {...savedMap[m.name]} : {...m});
      teamDays = saved.teamDays.map(d => ({...d}));
    }
    document.getElementById('start-date').value = SD.startDate;
    document.getElementById('end-date').value   = SD.endDate;
    document.getElementById('sprint-name').value = SD.sprintName;
    document.getElementById('hdr-sprint').textContent = SD.sprintName;
  } else {
    // Future sprint — load saved or defaults, show all roster members for planning
    const saved = loadSavedCapacity(SD.projectKey, sprintName);
    if (saved) {
      members  = saved.members.map(m => ({...m}));
      teamDays = saved.teamDays.map(d => ({...d}));
    } else {
      members  = SD.members.map(m => ({ name:m.name, hrs:6, pto:0 }));
      teamDays = [];
    }
    document.getElementById('start-date').value = sel.startDate;
    document.getElementById('end-date').value   = sel.endDate;
    document.getElementById('sprint-name').value = sel.name;
    document.getElementById('hdr-sprint').textContent = sel.name;
  }
  renderSprintChips();
  renderAll();
}

// ── EFFORT SECTION ─────────────────────────────────────────────────────────────
function renderEffort() {
  const container = document.getElementById('effort-list');
  if (!container) return;
  const sd = getSD();
  if (!sd || !sd.issues || !sd.issues.length) {
    container.innerHTML = '<div style="color:var(--t3);font-size:12px;padding:8px 0">No story data available</div>';
    return;
  }

  // Only stories/epics (not subtasks), with story points > 0
  const stories = sd.issues.filter(i => i.type !== 'Subtask' && i.points > 0);
  const totalPts = stories.reduce((a,i) => a + (i.points||0), 0);

  if (!stories.length) {
    container.innerHTML = '<div style="color:var(--t3);font-size:12px;padding:8px 0">No story point estimates found in Jira</div>';
    return;
  }

  container.innerHTML = stories.map(s => {
    const statusCol = s.status === 'Done' ? 'var(--green)' : s.status === 'In Progress' ? 'var(--blue)' : 'var(--t3)';
    const pts = s.points || 0;
    const barW = totalPts > 0 ? Math.round(pts/totalPts*100) : 0;
    return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">'
      + '<div style="font-family:var(--mono);font-size:11px;color:var(--t3);width:60px;flex-shrink:0">' + sanitize(s.key) + '</div>'
      + '<div style="flex:1;min-width:0">'
      +   '<div style="font-size:12px;color:var(--t2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + sanitize(s.summary) + '</div>'
      +   '<div style="background:var(--bg3);border-radius:3px;height:3px;margin-top:3px;overflow:hidden">'
      +     '<div style="width:'+barW+'%;height:100%;background:'+statusCol+'"></div>'
      +   '</div>'
      + '</div>'
      + '<div style="font-size:12px;font-weight:600;color:var(--t1);width:32px;text-align:right;flex-shrink:0">' + pts + 'pt</div>'
      + '</div>';
  }).join('')
  + '<div style="display:flex;justify-content:space-between;padding-top:10px;margin-top:4px;border-top:1px solid var(--bdr)">'
  +   '<span style="font-size:11px;font-weight:600;color:var(--t3);text-transform:uppercase;letter-spacing:.08em">Total committed</span>'
  +   '<span style="font-size:16px;font-weight:600;color:var(--green)">' + totalPts + ' pts</span>'
  + '</div>';
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

  const activeMembers = (window._planningFutureSprint === true) ? members : members.filter(m => asgnFor(m.name) > 0);
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
  const isFuture = window._planningFutureSprint === true;
  const active = isFuture ? members : members.filter(m => asgnFor(m.name) > 0);
  const tc = active.reduce((a,m) => a+cap(m), 0);
  const ta = active.reduce((a,m) => a+asgnFor(m.name), 0);
  const tl = active.reduce((a,m) => a+logFor(m.name), 0);
  const tp = tdo();

  document.getElementById('k-cap').textContent=tc;
  document.getElementById('k-asgn').textContent=ta;
  document.getElementById('k-rem').textContent=Math.round((tl/Math.max(ta,1))*100)+'%';
  document.getElementById('k-rem-sub').textContent=tl+'h logged of '+ta+'h assigned';
  document.getElementById('k-util').textContent=tc>0?Math.round(ta/tc*100)+'%':'0%';
  document.getElementById('k-pto').textContent=tp;
  renderMembers(); renderAvail(); renderCal(); renderBurndown(); renderEffort(); renderSprintChips();
}

function renderAll() { renderTDO(); recalc(); }

async function refreshFromJira() {
  const btn=document.getElementById('refresh-btn');
  if(btn){btn.textContent='Ask Claude ↗';btn.disabled=false;}
  alert('To refresh sprint data on demand, ask Claude:\n"Refresh the WBS sprint dashboard"\n\nAutomatic refresh runs every hour.');
}

load();

// ── EVENT DELEGATION — survives re-renders (attaches once to stable containers) ──
document.addEventListener('DOMContentLoaded', function() {}, false);
// Use setTimeout to ensure DOM is ready after load()
setTimeout(function setupDelegation() {
  const tb = document.getElementById('mtbody');
  if (!tb) { setTimeout(setupDelegation, 200); return; }

  tb.addEventListener('input', function(e) {
    const hrsIdx = e.target.dataset && e.target.dataset.hrsIdx;
    const ptoIdx = e.target.dataset && e.target.dataset.ptoIdx;
    if (hrsIdx !== undefined) {
      const i = +hrsIdx;
      members[i].hrs = Math.max(1, +e.target.value || hd());
      const capCell = tb.querySelector('[data-cap-idx="'+i+'"]');
      if (capCell) capCell.textContent = cap(members[i]) + 'h';
      const activeM = (window._planningFutureSprint === true) ? members : members.filter(m => asgnFor(m.name) > 0);
      const tc = activeM.reduce((a,m) => a+cap(m), 0);
      const ta = activeM.reduce((a,m) => a+asgnFor(m.name), 0);
      document.getElementById('k-cap').textContent = tc;
      document.getElementById('k-util').textContent = tc>0 ? Math.round(ta/tc*100)+'%' : '0%';
      document.getElementById('t-cap').textContent = tc+'h';
      autoSave();
    }
    if (ptoIdx !== undefined) {
      const i = +ptoIdx;
      members[i].pto = Math.max(0, +e.target.value || 0);
      const capCell = tb.querySelector('[data-cap-idx="'+i+'"]');
      if (capCell) capCell.textContent = cap(members[i]) + 'h';
      const activeM = (window._planningFutureSprint === true) ? members : members.filter(m => asgnFor(m.name) > 0);
      const tc = activeM.reduce((a,m) => a+cap(m), 0);
      const ta = activeM.reduce((a,m) => a+asgnFor(m.name), 0);
      document.getElementById('k-cap').textContent = tc;
      document.getElementById('k-util').textContent = tc>0 ? Math.round(ta/tc*100)+'%' : '0%';
      document.getElementById('t-cap').textContent = tc+'h';
      autoSave();
    }
  });

  tb.addEventListener('change', function(e) {
    const nameIdx = e.target.dataset && e.target.dataset.nameIdx;
    if (nameIdx !== undefined) {
      members[+nameIdx].name = e.target.value.trim();
      autoSave(); renderAll();
    }
  });

  tb.addEventListener('click', function(e) {
    const removeIdx = e.target.dataset && e.target.dataset.removeIdx;
    if (removeIdx !== undefined) removeMember(+removeIdx);
  });
}, 1500);
