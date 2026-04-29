"""
fetch_jira_data.py

Runs every hour via GitHub Actions.
Pulls active sprint data from Jira for all Payerpath teams.

Sprint boundary behavior:
- New sprint detected → carry over member list + hrs/day from previous sprint
                      → fresh start for teamDays, PTO, issues, subtaskHrs
- Same sprint        → preserve all saved capacity edits (members, hrs/day, PTO, teamDays)
"""

import os, json, math, requests
from datetime import datetime, timezone
from requests.auth import HTTPBasicAuth

# ── CONFIG ────────────────────────────────────────────────────────────────────
JIRA_BASE = os.environ['JIRA_BASE_URL'].rstrip('/')
AUTH      = HTTPBasicAuth(os.environ['JIRA_EMAIL'], os.environ['JIRA_API_TOKEN'])
HEADERS   = {'Accept': 'application/json'}

HRS_PER_DAY  = 6
WORKING_DAYS = 10  # fallback only

def calc_working_days(start_str, end_str):
    """Count working days (Mon-Fri) between two date strings inclusive."""
    from datetime import date, timedelta
    if not start_str or not end_str:
        return WORKING_DAYS
    try:
        s = date.fromisoformat(start_str[:10])
        e = date.fromisoformat(end_str[:10])
        count = 0
        cur = s
        while cur <= e:
            if cur.weekday() < 5:
                count += 1
            cur += timedelta(days=1)
        return count if count > 0 else WORKING_DAYS
    except Exception:
        return WORKING_DAYS

# Default rosters — used only on first ever run per team (no existing data.json)
DEFAULT_ROSTERS = {
    'WBS': {
        'team': 'Webslingers',
        'members': ['Julia Lukas', 'David Swiezy', 'Jeremy Goodman', 'Joi Hepler',
                    'Matt Glick', 'Suvarna Damarla', 'Yudong He'],
    },
    'GIN': {
        'team': 'Gingersnaps',
        'members': ['Adam Rossman', 'Deepthi Manne', 'Joel Wheeler', 'Matt Glick',
                    'Michael Earley', 'Michelle Streeter'],
    },
    'MOJO': {
        'team': 'Mojo',
        'members': ['Mike Jessen', 'Serguei Pozdniakov', 'Ilya Dyakov', 'Tanya Templer'],
    },
    'MAV': {
        'team': 'Mavericks',
        'members': ['Peter Lobo', 'Ajith Panicker', 'Annasaheb Huchchannavar',
                    'Chethan Rangaswamy', 'Kumar Kuppusamy', 'Kumaraswamy Krishnan',
                    'Muthu Kumaran', 'Mythily Nambiar', 'Rohan Kiran', 'Shamveel Ahmed',
                    'Sougata Das', 'Vikas Hiremath', 'Vikshani Chitlur'],
    },
    'AMGO': {
        'team': 'Amigos',
        'members': ['Peter Lobo', 'Akshay Kompelli', 'Gaurav Jindal', 'Harsh Jain',
                    'Kapil Darji', 'Kashish Thakur', 'Seetharamkumar Thummala',
                    'Shamveel Ahmed', 'Yashodhara Kulal'],
    },
}

# ── HELPERS ───────────────────────────────────────────────────────────────────
def load_existing():
    try:
        with open('data.json', 'r') as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

def jira_get(path, params=None):
    r = requests.get(f'{JIRA_BASE}/rest/api/3{path}',
                     auth=AUTH, headers=HEADERS, params=params)
    r.raise_for_status()
    return r.json()

def secs_to_hrs(secs):
    return math.ceil(secs / 3600) if secs else 0

def map_status(issue):
    cat = issue['fields']['status']['statusCategory']['key']
    if cat == 'done':          return 'Done'
    if cat == 'indeterminate': return 'In Progress'
    return 'Open'

def fetch_all_jql(jql, fields):
    all_issues, token = [], None
    while True:
        params = {'jql': jql, 'fields': fields, 'maxResults': 100}
        if token: params['nextPageToken'] = token
        data  = jira_get('/search/jql', params=params)
        batch = data.get('issues', [])
        all_issues.extend(batch)
        if data.get('isLast', True) or not batch: break
        token = data.get('nextPageToken')
        if not token: break
    return all_issues

def get_sprints(project_key):
    """Returns (active_sprint, all_sprints) where all_sprints = active + future."""
    try:
        boards = requests.get(
            f'{JIRA_BASE}/rest/agile/1.0/board',
            auth=AUTH, headers=HEADERS,
            params={'projectKeyOrId': project_key, 'type': 'scrum'}
        ).json()
        if not boards.get('values'):
            print(f'  No scrum board for {project_key}')
            return None, []
        board_id = boards['values'][0]['id']

        # Fetch active sprints
        active = requests.get(
            f'{JIRA_BASE}/rest/agile/1.0/board/{board_id}/sprint',
            auth=AUTH, headers=HEADERS,
            params={'state': 'active'}
        ).json().get('values', [])

        # Fetch future sprints
        future = requests.get(
            f'{JIRA_BASE}/rest/agile/1.0/board/{board_id}/sprint',
            auth=AUTH, headers=HEADERS,
            params={'state': 'future'}
        ).json().get('values', [])

        all_sprints = active + future
        if not all_sprints:
            print(f'  No active or future sprints for {project_key}')
            return None, []

        active_sprint = active[0] if active else None
        return active_sprint, all_sprints
    except Exception as e:
        print(f'  Error fetching sprints for {project_key}: {e}')
        return None, []

def get_active_sprint(project_key):
    """Legacy wrapper — returns active sprint only."""
    sprint, _ = get_sprints(project_key)
    return sprint

def get_sprint_issues(project_key):
    jql = (f'project = {project_key} AND sprint in openSprints() '
           f'AND issuetype not in subTaskIssueTypes() ORDER BY created DESC')
    return fetch_all_jql(jql,
        'summary,assignee,status,issuetype,subtasks,parent,'
        'aggregatetimeoriginalestimate,aggregatetimespent,'
        'timeoriginalestimate,timespent,customfield_10016')

def get_sprint_subtasks(project_key):
    """Get all issues/subtasks in the sprint with time data."""
    jql = (f'project = {project_key} AND sprint in openSprints() '
           f'AND issuetype in subTaskIssueTypes() ORDER BY created DESC')
    return fetch_all_jql(jql,
        'assignee,timeoriginalestimate,timespent,status,parent,summary')

def get_all_assigned_hours(project_key):
    """
    Query ALL issues in the sprint by assignee to capture hours regardless
    of whether they are logged on subtasks or parent issues.
    This is the most accurate way to get per-member hours.
    """
    jql = (f'project = {project_key} AND sprint in openSprints() '
           f'AND assignee is not EMPTY ORDER BY assignee ASC')
    return fetch_all_jql(jql,
        'assignee,timeoriginalestimate,timespent,aggregatetimeoriginalestimate,'
        'aggregatetimespent,issuetype,summary,status')

def build_subtask_hrs_from_parents(parent_issues):
    """
    Build per-member hour totals from PARENT issue aggregate fields.
    This is correct for Jira setups where time is logged on parent issues
    (aggregatetimeoriginalestimate / aggregatetimespent) rather than subtasks.
    Falls back to subtask-level fields only if parent has no aggregate data.
    """
    hrs = {}
    for iss in parent_issues:
        f    = iss['fields']
        name = (f.get('assignee') or {}).get('displayName', 'Unassigned')
        if name == 'Unassigned':
            continue  # skip unassigned — won't show on dashboard anyway
        # Prefer aggregate (rolls up subtask hours), fall back to direct fields
        est = secs_to_hrs(f.get('aggregatetimeoriginalestimate') or f.get('timeoriginalestimate'))
        log = secs_to_hrs(f.get('aggregatetimespent') or f.get('timespent'))
        if est == 0 and log == 0:
            continue
        if name not in hrs:
            hrs[name] = {'est': 0, 'logged': 0}
        hrs[name]['est']    += est
        hrs[name]['logged'] += log
    return hrs

def build_subtask_hrs(subtasks):
    """Legacy: subtask-level time tracking. Used only if subtasks have time data."""
    hrs = {}
    for st in subtasks:
        f    = st['fields']
        name = (f.get('assignee') or {}).get('displayName', 'Unassigned')
        est  = secs_to_hrs(f.get('timeoriginalestimate'))
        log  = secs_to_hrs(f.get('timespent'))
        if name not in hrs:
            hrs[name] = {'est': 0, 'logged': 0}
        hrs[name]['est']    += est
        hrs[name]['logged'] += log
    return hrs

def build_hours_by_assignee(all_issues):
    """
    Build per-member hour totals from subtasks only.
    Subtasks are the single source of truth — parent issues roll up from subtasks
    so including both would double-count. Hours are on the subtask direct fields.
    """
    hrs = {}
    for iss in all_issues:
        f = iss['fields']
        # Subtasks only — skip parent issues entirely
        if not f.get('issuetype', {}).get('subtask', False):
            continue
        name = (f.get('assignee') or {}).get('displayName', 'Unassigned')
        est = secs_to_hrs(f.get('timeoriginalestimate'))
        log = secs_to_hrs(f.get('timespent'))
        if est == 0 and log == 0:
            continue
        if name not in hrs:
            hrs[name] = {'est': 0, 'logged': 0}
        hrs[name]['est']    += est
        hrs[name]['logged'] += log
    return hrs

def build_subtask_map(subtasks):
    parent_map = {}
    for st in subtasks:
        f          = st['fields']
        est        = secs_to_hrs(f.get('timeoriginalestimate'))
        log        = secs_to_hrs(f.get('timespent'))
        parent_key = (f.get('parent') or {}).get('key', '')
        if not parent_key or (est == 0 and log == 0): continue
        assignee   = (f.get('assignee') or {}).get('displayName', 'Unassigned')
        parent_map.setdefault(parent_key, []).append(
            f"{st['key']} ({assignee}, {est}h est, {log}h logged)"
        )
    return parent_map

def format_issues(raw_issues, subtask_map):
    out = []
    for iss in raw_issues:
        f    = iss['fields']
        name = (f.get('assignee') or {}).get('displayName', 'Unassigned')
        subs = subtask_map.get(iss['key'], [])
        out.append({
            'key':      iss['key'],
            'type':     f['issuetype']['name'],
            'summary':  f.get('summary', iss['key']),
            'assignee': name,
            'status':   map_status(iss),
            'est':      secs_to_hrs(f.get('aggregatetimeoriginalestimate')),
            'logged':   secs_to_hrs(f.get('aggregatetimespent')),
            'subtasks': ', '.join(subs) if subs else '',
            'points':   f.get('customfield_10016') or 0,
        })
    return out

# ── SPRINT BOUNDARY MERGE ─────────────────────────────────────────────────────
def merge(fresh, saved_team, new_sprint_name, planned_capacity={}):
    """
    Same sprint  → preserve all saved capacity edits (members, hrs/day, PTO, teamDays)
    New sprint   → load from capacity.json if Scrum Master planned it; else defaults
    No saved     → use fresh defaults
    """
    # Check capacity.json for pre-planned capacity for this sprint
    planned = planned_capacity.get(new_sprint_name)
    if planned:
        print(f'  Found pre-planned capacity for {new_sprint_name} in capacity.json')
        fresh['members']  = planned.get('members',  fresh['members'])
        fresh['teamDays'] = planned.get('teamDays', [])
        return fresh

    if not saved_team:
        print(f'  No previous data — using defaults')
        return fresh

    saved_sprint = saved_team.get('sprintName', '')

    if saved_sprint == new_sprint_name:
        # Same sprint — preserve everything the team edited
        print(f'  Same sprint ({new_sprint_name}) — preserving saved edits')
        fresh['members']  = saved_team.get('members',  fresh['members'])
        fresh['teamDays'] = saved_team.get('teamDays', fresh['teamDays'])
        return fresh

    # New sprint with no planned capacity — use defaults
    print(f'  New sprint detected: {saved_sprint} → {new_sprint_name} (no planned capacity found)')
    fresh['members']  = fresh['members']  # default 6h/day, 0 PTO
    fresh['teamDays'] = []
    return fresh


# ── MAIN ─────────────────────────────────────────────────────────────────────
def process_team(key, config, existing, capacity={}):
    print(f'\nProcessing {key} ({config["team"]})...')
    sprint, all_sprints = get_sprints(key)
    if not sprint:
        return None

    sprint_name = sprint.get('name', f'{key} Active Sprint')
    start_date  = sprint.get('startDate', '')[:10]
    end_date    = sprint.get('endDate',   '')[:10]

    # Build sprint list for planning dropdown
    all_sprints_data = [
        {
            'name':      s.get('name', ''),
            'startDate': s.get('startDate', '')[:10],
            'endDate':   s.get('endDate', '')[:10],
            'state':     s.get('state', 'future'),
            'id':        s.get('id')
        }
        for s in all_sprints
    ]

    raw_issues  = get_sprint_issues(key)
    subtasks    = get_sprint_subtasks(key)
    subtask_map = build_subtask_map(subtasks)
    issues      = format_issues(raw_issues, subtask_map)
    # Query all assigned issues to get accurate per-member hours
    # This captures hours whether logged on subtasks OR parent issues
    all_assigned = get_all_assigned_hours(key)
    subtask_hrs = build_hours_by_assignee(all_assigned)
    total_est = sum(v['est'] for v in subtask_hrs.values())
    total_log = sum(v['logged'] for v in subtask_hrs.values())
    print(f'  Hours by assignee: {total_est}h est, {total_log}h logged across {len(subtask_hrs)} members')

    print(f'  Sprint: {sprint_name} | Issues: {len(issues)} | Subtasks: {len(subtasks)}')

    default_members = [
        {'name': m, 'hrs': HRS_PER_DAY, 'pto': 0}
        for m in config['members']
    ]

    fresh = {
        'team':       config['team'],
        'projectKey': key,
        'sprintName': sprint_name,
        'startDate':  start_date,
        'endDate':    end_date,
        'workDays':   calc_working_days(start_date, end_date),
        'hrsPerDay':  HRS_PER_DAY,
        'syncedAt':   datetime.now(timezone.utc).isoformat(),
        'members':    default_members,
        'teamDays':   [],
        'issues':     issues,
        'subtaskHrs': subtask_hrs,
        'allSprints':  all_sprints_data,
    }

    return merge(fresh, existing.get(key), sprint_name, capacity.get(key, {}))


def load_capacity_json():
    """Load shared capacity.json — contains planned capacity per team per sprint."""
    try:
        if os.path.exists('capacity.json'):
            with open('capacity.json') as f:
                data = json.load(f)
            print(f'Loaded capacity.json for teams: {list(data.keys())}')
            return data
    except Exception as e:
        print(f'Could not load capacity.json: {e}')
    return {}


def main():
    existing = load_existing()
    print(f'Loaded existing data for teams: {list(existing.keys()) or "none"}')
    capacity = load_capacity_json()

    output = {}
    for key, config in DEFAULT_ROSTERS.items():
        result = process_team(key, config, existing, capacity)
        if result:
            output[key] = result
        else:
            # No active sprint — keep previous data so dashboard doesn't go blank
            if key in existing:
                print(f'  Keeping previous data for {key} (no active sprint)')
                output[key] = existing[key]

    with open('data.json', 'w') as f:
        json.dump(output, f, indent=2)

    print(f'\n✅ data.json written — {len(output)} team(s): {", ".join(output.keys())}')


if __name__ == '__main__':
    main()
