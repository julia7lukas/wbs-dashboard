"""
fetch_jira_data.py

Pulls active sprint data from Jira for all Payerpath teams and writes
data.json to the repo root for the dashboard to consume.

Subtask hours: pulled directly from subtasks (not parent rollup).

IMPORTANT: On each run, any saved capacity edits in the existing data.json
(removed members, PTO days, hrs/day overrides, teamDays) are preserved.
Only Jira-sourced fields (issues, subtaskHrs, sprint dates) are refreshed.
"""

import os, json, math, requests
from datetime import datetime, timezone
from requests.auth import HTTPBasicAuth

# ── CONFIG ──────────────────────────────────────────────────────────────────
JIRA_BASE = os.environ["JIRA_BASE_URL"].rstrip("/")
AUTH      = HTTPBasicAuth(os.environ["JIRA_EMAIL"], os.environ["JIRA_API_TOKEN"])
HEADERS   = {"Accept": "application/json"}

# These are the DEFAULT rosters — only used when there is no existing data.json
# or when a team appears for the first time. Dashboard edits always take priority.
DEFAULT_ROSTERS = {
    "WBS": {
        "team": "Webslingers",
        "members": ["Julia Lukas", "David Swiezy", "Jeremy Goodman", "Joi Hepler",
                    "Matt Glick", "Suvarna Damarla", "Yudong He"],
    },
    "GIN": {
        "team": "Gingersnaps",
        "members": ["Adam Rossman", "Deepthi Manne", "Joel Wheeler", "Matt Glick",
                    "Michael Earley", "Michelle Streeter"],
    },
    "MOJO": {
        "team": "Mojo",
        "members": ["Mike Jessen", "Serguei Pozdniakov", "Ilya Dyakov", "Tanya Templer"],
    },
    "MAV": {
        "team": "Mavericks",
        "members": ["Peter Lobo", "Ajith Panicker", "Annasaheb Huchchannavar",
                    "Chethan Rangaswamy", "Kumar Kuppusamy", "Kumaraswamy Krishnan",
                    "Muthu Kumaran", "Mythily Nambiar", "Rohan Kiran", "Shamveel Ahmed",
                    "Sougata Das", "Vikas Hiremath", "Vikshani Chitlur"],
    },
    "AMGO": {
        "team": "Amigos",
        "members": ["Peter Lobo", "Akshay Kompelli", "Gaurav Jindal", "Harsh Jain",
                    "Kapil Darji", "Kashish Thakur", "Seetharamkumar Thummala",
                    "Shamveel Ahmed", "Yashodhara Kulal"],
    },
}

HRS_PER_DAY   = 6
WORKING_DAYS  = 10

# ── LOAD EXISTING data.json (to preserve saved edits) ───────────────────────
def load_existing_data():
    try:
        with open("data.json", "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}

# ── HELPERS ──────────────────────────────────────────────────────────────────
def jira_get(path, params=None):
    r = requests.get(f"{JIRA_BASE}/rest/api/3{path}",
                     auth=AUTH, headers=HEADERS, params=params)
    r.raise_for_status()
    return r.json()

def secs_to_hrs(secs):
    if not secs: return 0
    return math.ceil(secs / 3600)

def map_status(issue):
    cat = issue["fields"]["status"]["statusCategory"]["key"]
    if cat == "done":         return "Done"
    if cat == "indeterminate": return "In Progress"
    return "Open"

def issue_type_label(issue):
    return issue["fields"]["issuetype"]["name"]

def get_active_sprint(project_key):
    try:
        boards = requests.get(
            f"{JIRA_BASE}/rest/agile/1.0/board",
            auth=AUTH, headers=HEADERS,
            params={"projectKeyOrId": project_key, "type": "scrum"}
        ).json()
        if not boards.get("values"):
            print(f"  No scrum board found for {project_key}")
            return None
        board_id = boards["values"][0]["id"]
        sprints = requests.get(
            f"{JIRA_BASE}/rest/agile/1.0/board/{board_id}/sprint",
            auth=AUTH, headers=HEADERS,
            params={"state": "active"}
        ).json()
        if not sprints.get("values"):
            print(f"  No active sprint for {project_key}")
            return None
        return sprints["values"][0]
    except Exception as e:
        print(f"  Error fetching sprint for {project_key}: {e}")
        return None

def fetch_all_jql(jql, fields):
    all_issues, next_page_token = [], None
    while True:
        params = {"jql": jql, "fields": fields, "maxResults": 100}
        if next_page_token:
            params["nextPageToken"] = next_page_token
        data = jira_get("/search/jql", params=params)
        batch = data.get("issues", [])
        all_issues.extend(batch)
        if data.get("isLast", True) or not batch:
            break
        next_page_token = data.get("nextPageToken")
        if not next_page_token:
            break
    return all_issues

def get_sprint_issues(project_key):
    jql = (f"project = {project_key} AND sprint in openSprints() "
           f"AND issuetype not in subTaskIssueTypes() ORDER BY created DESC")
    fields = "summary,assignee,status,issuetype,subtasks,aggregatetimeoriginalestimate,aggregatetimespent"
    return fetch_all_jql(jql, fields)

def get_sprint_subtasks(project_key):
    jql = (f"project = {project_key} AND sprint in openSprints() "
           f"AND issuetype in subTaskIssueTypes() ORDER BY created DESC")
    fields = "assignee,timeoriginalestimate,timespent,status,parent,summary"
    return fetch_all_jql(jql, fields)

def build_subtask_hrs(subtasks):
    subtask_hrs = {}
    for issue in subtasks:
        f = issue["fields"]
        full_name = (f.get("assignee") or {}).get("displayName", "Unassigned")
        est    = secs_to_hrs(f.get("timeoriginalestimate"))
        logged = secs_to_hrs(f.get("timespent"))
        if full_name not in subtask_hrs:
            subtask_hrs[full_name] = {"est": 0, "logged": 0}
        subtask_hrs[full_name]["est"]    += est
        subtask_hrs[full_name]["logged"] += logged
    return subtask_hrs

def build_subtask_list_per_parent(subtasks):
    parent_map = {}
    for issue in subtasks:
        f   = issue["fields"]
        est    = secs_to_hrs(f.get("timeoriginalestimate"))
        logged = secs_to_hrs(f.get("timespent"))
        if est == 0 and logged == 0:
            continue
        parent_key = (f.get("parent") or {}).get("key", "")
        if not parent_key:
            continue
        if parent_key not in parent_map:
            parent_map[parent_key] = []
        assignee = (f.get("assignee") or {}).get("displayName", "Unassigned")
        parent_map[parent_key].append(
            f"{issue['key']} ({assignee}, {est}h est, {logged}h logged)"
        )
    return parent_map

def format_issues(raw_issues, subtask_map):
    out = []
    for issue in raw_issues:
        f         = issue["fields"]
        full_name = (f.get("assignee") or {}).get("displayName", "Unassigned")
        subtasks_with_hrs = subtask_map.get(issue["key"], [])
        out.append({
            "key":      issue["key"],
            "type":     issue_type_label(issue),
            "summary":  issue["key"],
            "assignee": full_name,
            "status":   map_status(issue),
            "est":      secs_to_hrs(f.get("aggregatetimeoriginalestimate")),
            "logged":   secs_to_hrs(f.get("aggregatetimespent")),
            "subtasks": ", ".join(subtasks_with_hrs) if subtasks_with_hrs else "",
        })
    return out

# ── MERGE: preserve saved capacity edits, refresh only Jira data ─────────────
def merge_with_saved(new_data, saved_team, sprint_name):
    """
    Given fresh Jira data and the previously saved team block, return a merged
    result that keeps dashboard edits (members list, teamDays) but uses fresh
    Jira data (issues, subtaskHrs, sprint dates).

    Rules:
    - If the sprint name changed → new sprint started, reset to fresh data
      (capacity edits no longer apply to the new sprint).
    - If same sprint → keep saved members list (respects removals/PTO/hrs edits)
      and saved teamDays. Only refresh issues + subtaskHrs.
    """
    if not saved_team:
        return new_data

    saved_sprint = saved_team.get("sprintName", "")

    # New sprint started — don't carry over old capacity edits
    if saved_sprint != sprint_name:
        print(f"  New sprint detected ({saved_sprint} → {sprint_name}), resetting capacity")
        return new_data

    # Same sprint — preserve saved members and teamDays
    print(f"  Same sprint ({sprint_name}), preserving saved capacity edits")
    new_data["members"]  = saved_team.get("members",  new_data["members"])
    new_data["teamDays"] = saved_team.get("teamDays", new_data["teamDays"])
    return new_data

# ── MAIN ─────────────────────────────────────────────────────────────────────
def process_team(project_key, team_config, existing_data):
    print(f"\nProcessing {project_key} ({team_config['team']})...")
    sprint = get_active_sprint(project_key)
    if not sprint:
        return None

    sprint_name = sprint.get("name", f"{project_key} Active Sprint")
    start_date  = sprint.get("startDate", "")[:10]
    end_date    = sprint.get("endDate",   "")[:10]

    raw_issues   = get_sprint_issues(project_key)
    subtasks     = get_sprint_subtasks(project_key)
    subtask_map  = build_subtask_list_per_parent(subtasks)
    issues       = format_issues(raw_issues, subtask_map)
    subtask_hrs  = build_subtask_hrs(subtasks)

    print(f"  Sprint: {sprint_name} | Issues: {len(issues)} | Subtasks: {len(subtasks)}")

    # Build fresh data using default roster
    default_members = [{"name": m, "hrs": HRS_PER_DAY, "pto": 0}
                       for m in team_config["members"]]

    fresh = {
        "team":        team_config["team"],
        "projectKey":  project_key,
        "sprintName":  sprint_name,
        "startDate":   start_date,
        "endDate":     end_date,
        "workDays":    WORKING_DAYS,
        "hrsPerDay":   HRS_PER_DAY,
        "syncedAt":    datetime.now(timezone.utc).isoformat(),
        "members":     default_members,
        "teamDays":    [],
        "issues":      issues,
        "subtaskHrs":  subtask_hrs,
    }

    # Merge: keep saved capacity edits if same sprint
    saved_team = existing_data.get(project_key)
    return merge_with_saved(fresh, saved_team, sprint_name)


def main():
    existing_data = load_existing_data()
    print(f"Loaded existing data.json with keys: {list(existing_data.keys()) or 'none'}")

    output = {}
    for key, config in DEFAULT_ROSTERS.items():
        result = process_team(key, config, existing_data)
        if result:
            output[key] = result
        else:
            print(f"  Skipping {key} — no active sprint found")

    with open("data.json", "w") as f:
        json.dump(output, f, indent=2)

    print(f"\n✅ data.json written with {len(output)} team(s): {', '.join(output.keys())}")


if __name__ == "__main__":
    main()
