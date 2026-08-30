# blackboard-mcp

A **local-first, read-only MCP server** that lets an AI agent read the Blackboard data you
(the signed-in student) can already see. Initial target: **Syracuse University** —
`https://blackboard.syr.edu`.

It does **not** require a Blackboard REST application key or Syracuse administrator approval.
It uses your own authenticated Blackboard browser session: you log in once through a normal
Chrome window (completing Syracuse SSO + Duo yourself), and the server reuses that session for
low-volume, read-only requests.

```
you (Chrome window, once) ──► Syracuse SSO + Duo ──► Blackboard
                                                        │
blackboard-mcp (local) ── authenticated requests ───────┘
        │
        └── MCP over stdio ──► your AI agent (Claude Desktop, Claude Code, ...)
```

## What it does

Exposes nine tools to any MCP client:

| Tool | Purpose |
| --- | --- |
| `list_courses` | All currently visible courses (returns the course ids used everywhere else) |
| `get_course_content` | Course folders, documents, files, assignments, tests, links — light hierarchy expansion; `folder_id` for deeper dives |
| `get_announcements` | Course announcements, newest first, optional `since` |
| `get_assignments` | Assignments/assessments merged and deduplicated from course content, the gradebook, and the calendar; optional course scoping and due-date window |
| `get_grades` | Your grades for one course: score, points possible, percentage, feedback, grading status |
| `get_attachment` | Downloads a course file (PDF, DOCX, PPTX, TXT, images, …) into `~/.blackboard-mcp/downloads` and returns the local path |
| `get_upcoming_work` | Upcoming work across **all** courses sorted by due date (default next 7 days) |
| `get_recent_updates` | Announcements, new/changed content, changed assignments, new grades since a point in time |
| `get_assignment_context` | One package per assignment: instructions, due date, points, rubric (when available), attachments, your grade/status, related announcements |

## Security model

- **Local-first**: everything runs on your machine. No server, no account, no web UI.
- **Read-only**: the server only issues GET requests. It never submits assignments or quizzes,
  posts to discussions, sends messages, or touches any setting. There is no write code in the
  repository at all.
- **Student-scoped**: requests go through your own logged-in session, so the agent can never
  see anything Blackboard doesn't already show you. Permission-denied responses are surfaced
  as errors, never retried or bypassed.
- **Low-volume**: cached responses (5–10 minute TTLs), small delays between paginated requests,
  hard caps on pages/items per call, and one shared browser session that closes after 5 idle
  minutes.
- **No credential access**: the server never asks for, reads, stores, or types your NetID
  password, Duo codes, MFA secrets, or backup/recovery codes. Login is entirely manual in a
  visible Chrome window; the server just waits for you to land back on Blackboard.
- **No secret leakage**: cookies, tokens, and browser storage never leave the browser profile;
  they are never returned by tools or logged. Error messages are masked and truncated, and the
  transport refuses to fetch anything off `blackboard.syr.edu`.
- **Contained file access**: `get_attachment` only saves into `~/.blackboard-mcp/downloads`,
  with sanitized file names. It cannot read or write arbitrary paths.

## Installation

Requires Node.js 20+ and Google Chrome.

```bash
cd blackboard-mcp
npm install
```

## Login (one time, then rarely)

```bash
npm run login
```

1. A **visible Chrome window** opens using a dedicated profile (not your normal Chrome profile).
2. You sign in with your NetID and complete **Duo exactly as you normally would**.
3. The tool detects when you land back on Blackboard, verifies the session with one
   authenticated call, saves nothing but a timestamp, and closes the window.

The session itself lives in the dedicated browser profile at
`~/.blackboard-mcp/chrome-profile`, plus a cookie snapshot at
`~/.blackboard-mcp/browser-state.json` (mode 0600). Blackboard's session cookie does not
survive a browser restart, so the snapshot carries the session between runs — and when it
expires, the server follows Syracuse's SAML SSO entry silently: if your Microsoft session is
still valid, you're re-authenticated with zero interaction; you only ever re-run
`npm run login` when Microsoft itself demands credentials or Duo.

Syracuse detail worth knowing: Blackboard answers on two hostnames
(`blackboard.syr.edu` and `blackboard.syracuse.edu`) with separate cookie domains; the session
layer probes both and issues same-origin requests against whichever holds the session.

> **Why passwords and MFA are never stored:** the login step is *you typing in a real browser*.
> The automation only watches the URL bar and, once you're through, makes authenticated calls
> with the browser's own cookies. At no point does any code see a password field, a Duo push,
> or a backup code — there is nothing to store and nothing to leak.

## Session storage

Everything persistent lives under `~/.blackboard-mcp/` (outside the repo):

| Path | Contents |
| --- | --- |
| `chrome-profile/` | The dedicated Chromium profile — browser-format cookies/storage |
| `browser-state.json` | Snapshot of the authenticated cookies (mode 0600), restored into each new browser; this is what carries the session between runs |
| `downloads/` | Files saved via `get_attachment` |
| `session-meta.json` | Only `lastLoginAt` / `lastVerifiedAt`, your display name, and the working origin — no tokens |

Nothing session-related is ever written inside the repository, and `.gitignore` guards against
it anyway.

## CLI commands

```bash
npm run login      # interactive login (visible Chrome, SSO + Duo by hand)
npm run status     # does the stored session still work?
npm run courses    # print your currently visible courses (milestone check)
npm run discover   # dev tool: record the Blackboard API calls your own browsing makes
npm run logout     # wipe the dedicated profile from this machine
npm start          # run the MCP server on stdio
```

`npm run status` prints `Blackboard session expired. Run npm run login again.` when the session
is gone. It never attempts to renew MFA or re-authenticate on your behalf.

`npm run discover` is how the integration stays honest: browse Blackboard normally while it
records every `/learn/api/...` and `/bbcswebdav/...` request the Ultra UI itself makes, so the
endpoints used here can be verified against what Syracuse's deployment really serves instead of
guessed.

## MCP setup

The server speaks MCP over stdio. Example client configuration — point `args` at the built
`dist/index.js`:

```json
{
  "mcpServers": {
    "blackboard": {
      "command": "node",
      "args": ["/absolute/path/to/blackboard-mcp/dist/index.js"]
    }
  }
}
```

(Claude Desktop: `claude_desktop_config.json`; Claude Code: `claude mcp add blackboard -- node
/absolute/path/to/blackboard-mcp/dist/index.js`; any other MCP client: same shape.)

Start the server after logging in at least once. While idle it launches nothing; the first tool
call opens a headless Chrome on the dedicated profile and reuses it for subsequent calls.

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `BB_BROWSER_CHANNEL` | `chrome` | Browser channel used by Playwright |
| `BB_HEADLESS` | `1` | Set `0` to watch the headless session work (debugging) |
| `BLACKBOARD_MCP_HOME` | `~/.blackboard-mcp` | Where profile/downloads/meta live |

## Reconnecting after session expiration

When the session dies you'll get `BLACKBOARD_SESSION_EXPIRED: Blackboard session expired. Run
npm run login again.` from tools, and the exact same sentence from `npm run status`. The fix is
always the same manual flow:

```bash
npm run login    # complete SSO + Duo in the window that opens
npm run status   # confirm: "Blackboard session active"
```

The server drops its browser on the next call and picks up the fresh session automatically.
No MFA renewal is ever automated — by design.

## Supported tools

See the table above. All tools are annotated read-only and accept safe Blackboard identifiers
(course ids like `_26184_1` or course codes like `CIS.473`, content ids, file ids) — never
paths or URLs. Identifiers always come from earlier tool calls, starting with `list_courses`.

Errors are short, coded messages — `BLACKBOARD_SESSION_EXPIRED`, `NOT_LOGGED_IN`,
`COURSE_NOT_FOUND`, `CONTENT_NOT_AVAILABLE`, `PERMISSION_DENIED`,
`BLACKBOARD_REQUEST_FAILED`, `ATTACHMENT_NOT_FOUND`, `INVALID_INPUT` — never raw HTML dumps.

## Read-only restrictions (enforced by omission)

There is no code — and intentionally no tool — for: submitting assignments or quizzes, posting
to discussions, messaging instructors, changing grades, creating announcements, modifying
content, changing enrollments, editing user info, or deleting anything. Where Blackboard's own
APIs could write, only the read verb is implemented.

## Known limitations

- **Ultra-first**: built against Blackboard Ultra course pages (Syracuse's default). Classic
  ("Original") courses mostly work through the same APIs, but content shapes can differ.
- **Endpoints verified against live traffic**: the client uses `users/me`,
  `users/me/courses?expand=course` (enrollment + course in one call), course contents,
  announcements, the Ultra calendar, and the v2 gradebook — all confirmed against Syracuse's
  deployment on 2026-08-29 (`list_courses` returned 46 live courses). Paging is capped at 100
  per page (this deployment rejects higher limits). Attachment lookup tries the content-files
  endpoints before falling back to `/bbcswebdav` links embedded in content; run
  `npm run discover` to verify any endpoint against your own browsing.
- **Instructors and rubrics are best-effort**: course objects don't carry instructor names, and
  rubric data appears only where the deployment exposes it to students.
- **Grades cost one request per gradebook column** (cached for 5 minutes). This is the main
  place where low-volume pacing is visible.
- **`get_recent_updates` sweeps bounded** (max 12 courses per call) to stay gentle.
- Large attachments (>200 MB) are refused; small text files come back with an inline excerpt,
  everything else as a saved file path.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest: 60 tests, all network mocked — never touches Blackboard
npm run build       # compile to dist/
```

Unit tests cover course/assignment/announcement/content normalization, date parsing, duplicate
merging, pagination, session-expiration mapping, argument validation, error codes, and
attachment sanitization. MCP integration tests drive the real server over an in-memory
transport with a fake authenticated transport, so the domain code paths are exercised
end-to-end without a browser. Live Blackboard checks are deliberately manual (`npm run login`,
`npm run courses`, `npm run discover`) and never part of the test suite.

## Responsible use

This tool drives Blackboard through **your own** authenticated student session. That is
functionally the same as you clicking around in a browser, but an agent can do it faster than
a human — so keep a few things in mind:

- **Check your institution's acceptable-use policy** before using automated tooling against
  your student account. This project is not affiliated with or endorsed by Syracuse University
  or Anthology/Blackboard.
- **Keep request volume low.** The server caches aggressively, paces requests, and caps page
  counts — don't defeat those guards.
- **Your session, your responsibility.** Everything the agent can read is exactly what you can
  read in a browser. Never point the agent at data you shouldn't see, and never share your
  `~/.blackboard-mcp` directory — it contains your live session.

## Compatibility

Built and tested against **Syracuse University's Blackboard Ultra deployment** (August 2026).
Other institutions' Learn instances expose the same Learn REST API, but hostnames, the SSO
entry URL, paging limits, and response details differ. To adapt: set `BB_BASE_URL` (and
`BB_SSO_ENTRY_URL` if your school uses a SAML entry like Syracuse's), adjust
`BLACKBOARD_HOSTS` in `src/blackboard/hosts.ts`, and run `npm run discover` to verify
endpoints against your deployment before trusting the parsers.

## License

[MIT](LICENSE) — use it, fork it, fix it.
