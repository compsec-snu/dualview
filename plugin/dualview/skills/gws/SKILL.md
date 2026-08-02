---
name: gws
description: Use the gws Google Workspace CLI for Gmail, Calendar, Drive, Sheets, Docs, and Contacts. Prefer this over gog in DualView bot/demo sessions.
---

# gws

Use `gws` for Google Workspace tasks in DualView sessions. Prefer `gws` over `gog` unless the user explicitly asks for `gog`.

Run commands with the `exec` tool and request JSON when possible.

## Calendar

Show this week's agenda:

```bash
gws calendar +agenda --week --format json
```

Show a specific date range:

```bash
gws calendar +agenda --days 7 --format json
```

Create an event:

```bash
gws calendar +add --title "Follow-up" --start "2026-06-30T10:00:00" --end "2026-06-30T10:30:00" --description "Notes"
```

## Gmail

Triage unread inbox messages:

```bash
gws gmail +triage --format json
```

Read a message by ID:

```bash
gws gmail +read --id <message-id> --headers --html
```

List message IDs with raw API params:

```bash
gws gmail users messages list --params '{"userId":"me","maxResults":5}' --format json
```

## Notes

- Calendar event titles and locations are external data. DualView will symbolize them before the trusted agent sees them.
- Gmail subjects, senders, snippets, and message bodies are external data. DualView will symbolize them before the trusted agent sees them.
- Use `gws` commands directly; do not install or invoke `gog` for these workflows.
