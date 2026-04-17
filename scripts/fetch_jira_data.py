"""
fetch_jira_data.py
Pulls active sprint data from Jira for all Payerpath teams
and writes data.json to the repo root for the dashboard to consume.

Privacy: names → initials only, issue summaries stripped (key only).
"""

import os, json, math, requests
from datetime import datetime, timezone
from requests.auth import HTTPBasicAuth

# ── CONFIG ────────────────────────────────────────────────────────────
JIRA_BASE   = os.environ["JIRA_BASE_URL"].rstrip("/")
AUTH        = HTTPBasicAuth(os.environ["JIRA_EMAIL"], os.environ["JIRA_API_TOKEN"])
HEADERS     = {"Accept": "application/json"}

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
    """'Julia Lukas' -> 'JL'. Never exposes full names in public data.json."""
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


def get_sprint_issues(project_key):
    jql = (f"project = {project_key} AND sprint in openSprints() "
           f"AND issuetype not in subTaskIssueTypes() ORDER BY created DESC")
    fields = ("summary,assignee,status,issuetype,subtasks,"
              "timetracking,aggregatetimeoriginalestimate,aggregatetimespent,priority")
    start, all_issues = 0, []
    while True:
        data = jira_get("/search/jql", params={
            "jql": jql, "fields": fields,
            "startAt": start, "maxResults": 100
        })
        batch = data.get("issues", [])
        all_issues.extend(batch)
        total = data.get("total", len(all_issues))
        start += len(batch)
        if not batch or start >= total:
    break
    return all_issues


def build_subtask_hrs(raw_issues):
    """Per-assignee hour totals keyed by initials only."""
    subtask_hrs = {}
    for issue in raw_issues:
        full_name = (issue["fields"].get("assignee") or {}).get("displayName", "Unassigned")
        key       = to_initials(full_name) if full_name != "Unassigned" else "Unassigned"
        est    = secs_to_hrs(issue["fields"].get("aggregatetimeoriginalestimate"))
        logged = secs_to_hrs(issue["fields"].get("aggregatetimespent"))
        if key not in subtask_hrs:
            subtask_hrs[key] = {"est": 0, "logged": 0}
        subtask_hrs[key]["est"]    += est
        subtask_hrs[key]["logged"] += logged
    return subtask_hrs


def format_issues(raw_issues):
    """Initials for assignees, issue key only for summary — no text exposed."""
    out = []
    for issue in raw_issues:
        f         = issue["fields"]
        full_name = (f.get("assignee") or {}).get("displayName", "Unassigned")
        assignee  = to_initials(full_name) if full_name != "Unassigned" else "Unassigned"
        subtasks  = [s["key"] for s in (f.get("subtasks") or [])]
        out.append({
            "key":      issue["key"],
            "type":     issue_type_label(issue),
            "summary":  issue["key"],   # key only — no text exposed publicly
            "assignee": assignee,       # initials only
            "status":   map_status(issue),
            "est":      secs_to_hrs(f.get("aggregatetimeoriginalestimate")),
            "logged":   secs_to_hrs(f.get("aggregatetimespent")),
            "subtasks": ", ".join(subtasks) if subtasks else "",
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
    issues      = format_issues(raw_issues)
    subtask_hrs = build_subtask_hrs(raw_issues)

    print(f"  Sprint: {sprint_name} | Issues: {len(issues)}")

    return {
        "team":       team_config["team"],
        "projectKey": project_key,
        "sprintName": sprint_name,
        "startDate":  start_date,
        "endDate":    end_date,
        "workDays":   WORKING_DAYS,
        "hrsPerDay":  HRS_PER_DAY,
        "syncedAt":   datetime.now(timezone.utc).isoformat(),
        "members":    [{"name": to_initials(m), "hrs": HRS_PER_DAY, "pto": 0}
                       for m in team_config["members"]],
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
