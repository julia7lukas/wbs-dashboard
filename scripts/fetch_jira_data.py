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
WORKING_DAYS = 10

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

def get_active_sprint(project_key):
    try:
        boards = requests.get(
            f'{JIRA_BASE}/rest/agile/1.0/board',
            auth=AUTH, headers=HEADERS,
            params={'projectKeyOrId': project_key, 'type': 'scrum'}
        ).json()
        if not boards.get('values'):
            print(f'  No scrum board for {project_key}')
            return None
        board_id = boards['values'][0]['id']
        sprints  = requests.get(
            f'{JIRA_BASE}/rest/agile/1.0/board/{board_id}/sprint',
            auth=AUTH, headers=HEADERS,
            params={'state': 'active'}
        ).json()
        if not sprints.get('values'):
            print(f'  No active sprint for {project_key}')
            return None
        return sprints['values'][0]
    except Exception as e:
        print(f'  Error fetching sprint for {project_key}: {e}')
        return None

def get_sprint_issues(project_key):
    jql = (f'project = {project_key} AND sprint in openSprints() '
           f'AND issuetype not in subTaskIssueTypes() ORDER BY created DESC')
    return fetch_all_jql(jql,
        'summary,assignee,status,issuetype,subtasks,'
        'aggregatetimeoriginalestimate,aggregatetimespent')

def get_sprint_subtasks(project_key):
    jql = (f'project = {project_key} AND sprint in openSprints() '
           f'AND issuetype in subTaskIssueTypes() ORDER BY created DESC')
    return fetch_all_jql(jql,
        'assignee,timeoriginalestimate,timespent,status,parent,summary')

def build_subtask_hrs(subtasks):
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
        })
    return out

# ── SPRINT BOUNDARY MERGE ─────────────────────────────────────────────────────
def merge(fresh, saved_team, new_sprint_name):
    """
    Same sprint  → preserve all saved capacity edits (members, hrs/day, PTO, teamDays)
    New sprint   → carry over member list + hrs/day only; fresh PTO + teamDays
    No saved     → use fresh defaults
    """
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

    # New sprint — carry over member list + hrs/day, reset PTO + teamDays
    print(f'  New sprint detected: {saved_sprint} → {new_sprint_name}')
    print(f'  Carrying over member list + hrs/day, resetting PTO + team days off')

    saved_members = saved_team.get('members', [])
    # Build a map of saved hrs/day per member name
    saved_hrs = {m['name']: m.get('hrs', HRS_PER_DAY) for m in saved_members}
    # Keep only members that were in the previous sprint roster (respects removals)
    # Reset PTO to 0 for new sprint
    carried_members = [
        {'name': m['name'], 'hrs': saved_hrs.get(m['name'], HRS_PER_DAY), 'pto': 0}
        for m in saved_members  # use saved roster order, not default
    ]

    fresh['members']  = carried_members
    fresh['teamDays'] = []  # fresh start — no days off yet for new sprint
    return fresh


# ── MAIN ─────────────────────────────────────────────────────────────────────
def process_team(key, config, existing):
    print(f'\nProcessing {key} ({config["team"]})...')
    sprint = get_active_sprint(key)
    if not sprint:
        return None

    sprint_name = sprint.get('name', f'{key} Active Sprint')
    start_date  = sprint.get('startDate', '')[:10]
    end_date    = sprint.get('endDate',   '')[:10]

    raw_issues  = get_sprint_issues(key)
    subtasks    = get_sprint_subtasks(key)
    subtask_map = build_subtask_map(subtasks)
    issues      = format_issues(raw_issues, subtask_map)
    subtask_hrs = build_subtask_hrs(subtasks)

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
        'workDays':   WORKING_DAYS,
        'hrsPerDay':  HRS_PER_DAY,
        'syncedAt':   datetime.now(timezone.utc).isoformat(),
        'members':    default_members,
        'teamDays':   [],
        'issues':     issues,
        'subtaskHrs': subtask_hrs,
    }

    return merge(fresh, existing.get(key), sprint_name)


def main():
    existing = load_existing()
    print(f'Loaded existing data for teams: {list(existing.keys()) or "none"}')

    output = {}
    for key, config in DEFAULT_ROSTERS.items():
        result = process_team(key, config, existing)
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
