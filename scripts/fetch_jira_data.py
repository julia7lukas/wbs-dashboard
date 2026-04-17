"""
fetch_jira_data.py
Pulls active sprint data from Jira for all Payerpath teams
and writes data.json to the repo root for the dashboard to consume.

Subtask hours: pulled directly from subtasks (not parent rollup).
"""

import os, json, math, requests
from datetime import datetime, timezone
from requests.auth import HTTPBasicAuth

# ── CONFIG ────────────────────────────────────────────────────────────
JIRA_BASE = os.environ["JIRA_BASE_URL"].rstrip("/")
AUTH      = HTTPBasicAuth(os.environ["JIRA_EMAIL"], os.environ["JIRA_API_TOKEN"])
HEADERS   = {"Accept": "application/json"}

TEAMS = {
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

HRS_PER_DAY  = 6
WORKING_DAYS = 10


# ── HELPERS ───────────────────────────────────────────────────────────
def jira_get(path, params=None):
    r = requests.get(f"{JIRA_BASE}/rest/api/3{path}", auth=AUTH,
                     headers=HEADERS, params=params)
    r.raise_for_status()
    return r.json()


def secs_to_hrs(secs):
    if not secs:
        return 0
    return math.ceil(secs / 3600)


def to_initials(name):
    return ''.join(w[0] for w in name.strip().split()).upper() if name else '?'


def map_status(issue):
    cat = issue["fields"]["status"]["statusCategory"]["key"]
    if cat == "done":          return "Done"
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
    """Fetch all issues using cursor-based pagination."""
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
    """Aggregate hours per assignee (full name) from subtasks directly."""
    subtask_hrs = {}
    for issue in subtasks:
        f         = issue["fields"]
        full_name = (f.get("assignee") or {}).get("displayName", "Unassigned")
        est    = secs_to_hrs(f.get("timeoriginalestimate"))
        logged = secs_to_hrs(f.get("timespent"))
        if full_name not in subtask_hrs:
            subtask_hrs[full_name] = {"est": 0, "logged": 0}
        subtask_hrs[full_name]["est"]    += est
        subtask_hrs[full_name]["logged"] += logged
    return subtask_hrs


def build_subtask_list_per_parent(subtasks):
    """Build a map of parent_key -> list of subtasks that have hours."""
    parent_map = {}
    for issue in subtasks:
        f      = issue["fields"]
        est    = secs_to_hrs(f.get("timeoriginalestimate"))
        logged = secs_to_hrs(f.get("timespent"))
        # Only include subtasks that have hours
        if est == 0 and logged == 0:
            continue
        parent_key = (f.get("parent") or {}).get("key", "")
        if not parent_key:
            continue
        if parent_key not in parent_map:
            parent_map[parent_key] = []
        assignee  = (f.get("assignee") or {}).get("displayName", "Unassigned")
        parent_map[parent_key].append(f"{issue['key']} ({assignee}, {est}h est, {logged}h logged)")
    return parent_map


def format_issues(raw_issues, subtask_map):
    out = []
    for issue in raw_issues:
        f         = issue["fields"]
        full_name = (f.get("assignee") or {}).get("displayName", "Unassigned")
        # Show only subtasks with hours for this parent
        subtasks_with_hrs = subtask_map.get(issue["key"], [])
        out.append({
            "key":      issue["key"],
            "type":     issue_type_label(issue),
            "summary":  issue["key"],
            "assignee": full_name,          # ← full name restored
            "status":   map_status(issue),
            "est":      secs_to_hrs(f.get("aggregatetimeoriginalestimate")),
            "logged":   secs_to_hrs(f.get("aggregatetimespent")),
            "subtasks": ", ".join(subtasks_with_hrs) if subtasks_with_hrs else "",
        })
    return out


# ── MAIN ──────────────────────────────────────────────────────────────
def process_team(project_key, team_config):
    print(f"\nProcessing {project_key} ({team_config['team']})...")
    sprint = get_active_sprint(project_key)
    if not sprint:
        return None

    sprint_name = sprint.get("name", f"{project_key} Active Sprint")
    start_date  = sprint.get("startDate", "")[:10]
    end_date    = sprint.get("endDate",   "")[:10]

    raw_issues  = get_sprint_issues(project_key)
    subtasks    = get_sprint_subtasks(project_key)
    subtask_map = build_subtask_list_per_parent(subtasks)
    issues      = format_issues(raw_issues, subtask_map)
    subtask_hrs = build_subtask_hrs(subtasks)

    print(f"  Sprint: {sprint_name} | Issues: {len(issues)} | Subtasks: {len(subtasks)}")

    return {
        "team":       team_config["team"],
        "projectKey": project_key,
        "sprintName": sprint_name,
        "startDate":  start_date,
        "endDate":    end_date,
        "workDays":   WORKING_DAYS,
        "hrsPerDay":  HRS_PER_DAY,
        "syncedAt":   datetime.now(timezone.utc).isoformat(),
        "members":    [{"name": m, "hrs": HRS_PER_DAY, "pto": 0}
                       for m in team_config["members"]],  # ← full names restored
        "teamDays":   [],
        "issues":     issues,
        "subtaskHrs": subtask_hrs,
    }


def main():
    output = {}
    for key, config in TEAMS.items():
        result = process_team(key, config)
        if result:
            output[key] = result
        else:
            print(f"  Skipping {key} — no active sprint found")

    with open("data.json", "w") as f:
        json.dump(output, f, indent=2)

    print(f"\n✅ data.json written with {len(output)} team(s): {', '.join(output.keys())}")


if __name__ == "__main__":
    main()
