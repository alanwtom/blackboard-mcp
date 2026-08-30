# Blackboard MCP

Ask an AI assistant about your own Blackboard and get real answers: what's due, what your
grades are, what your professors posted, and the files for any assignment. It works with your
own logged-in Blackboard session, so it can only see what you can already see. It is
read-only: it can never submit, post, message, or change anything.

Setup takes about ten minutes and you only do it once. If you have never used a terminal,
just copy and paste each command exactly as written.

## What you need

1. A Mac (this guide is for macOS)
2. [Google Chrome](https://www.google.com/chrome/)
3. [Node.js](https://nodejs.org) version 20 or newer (get the LTS installer)
4. An AI app that supports MCP, such as [Claude Desktop](https://claude.ai/download)

Not sure if you have Node.js? Open Terminal (Cmd + Space, type "Terminal", press Enter), type
`node -v`, and press Enter. If you see `v20` or higher you are set.

## Setup (do once)

Open Terminal and run each command, one at a time.

**1. Download the project**

```bash
cd ~/Documents/Github
git clone https://github.com/alanwtom/blackboard-mcp.git
cd blackboard-mcp
```

If your Mac says `git` is not installed, agree to install it, then run the command again.

**2. Install the pieces**

```bash
npm install
```

Scrolling text is normal. This takes a minute or two.

**3. Log in to Blackboard**

```bash
npm run login
```

A Chrome window opens. Sign in with your NetID and approve Duo, exactly like usual. Use the
new window with the red banner, not your usual Chrome browser. When you land back on
Blackboard, the window closes by itself. Your password and Duo codes are never seen or saved
by this project: that part is always you typing in a real browser.

**4. Check that it worked**

```bash
npm run courses
```

You should see your real course list.

**5. Connect it to your AI app**

For Claude Desktop: open Settings, then Developer, then Edit Config, and add this block:

```json
{
  "mcpServers": {
    "blackboard": {
      "command": "node",
      "args": ["/Users/yourname/Documents/Github/blackboard-mcp/dist/index.js"]
    }
  }
}
```

Replace `yourname` with your Mac username. To check the exact path, run:

```bash
echo ~/Documents/Github/blackboard-mcp/dist/index.js
```

Save the file, quit Claude Desktop completely (Cmd + Q), and reopen it.

## Use it

Talk to your AI like a person:

- "What's due in the next 7 days?"
- "Any new announcements this week?"
- "What are my grades in Calculus?"
- "Pull up the Essay assignment: instructions and attached files."
- "Download the lecture slides from Week 3."

The first question takes 10 to 20 seconds. After that it is quick. Downloaded files are
saved in `~/.blackboard-mcp/downloads`.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| "Blackboard session expired" | Run `npm run login` and sign in again. This is normal after a while. |
| A question fails | Run `npm run status`, then try again. Blackboard has brief hiccups sometimes. |
| Login window confusion | Type your NetID in the window with the red banner. It is a separate private browser, not your usual Chrome. |
| AI shows no Blackboard tools | Quit and reopen the AI app completely, then check the path in step 5. |
| A course looks empty | Archived courses are locked by the university. New courses may have nothing posted yet. |

## Safety and privacy

- Read-only by design: this project contains no code that could submit work, post messages,
  or change anything.
- It only sees what you can see, because it uses your own session.
- Your password and Duo codes are never requested, read, or stored.
- Everything stays on your Mac. To erase it all, delete the `~/.blackboard-mcp` folder or run
  `npm run logout`. Never share that folder; it keeps you signed in.

## Being a good citizen

Use it for yourself at a human pace, and check your university's acceptable-use policy
before using any automation with your student account. Not affiliated with or endorsed by
Syracuse University or Anthology/Blackboard.

## For the technically curious

<details>
<summary><strong>Architecture, configuration, and development notes</strong></summary>

- **Stack**: TypeScript (ESM), Node 20+, Playwright (Chrome channel, dedicated profile),
  MCP TypeScript SDK over stdio, Zod, Vitest.
- **Data access**: Blackboard Learn REST API, called as same-origin requests from a page on
  the Blackboard host, so requests match what the Ultra web app itself sends. Both
  `blackboard.syr.edu` and `blackboard.syracuse.edu` (separate cookie domains) are supported.
- **Session resilience**: Learn's session cookie does not survive a browser restart, so the
  authenticated cookie set is snapshotted to `~/.blackboard-mcp/browser-state.json` (mode
  0600) and restored on launch. While the institution SSO session lasts, the SAML entry is
  followed silently to re-authenticate with no interaction.
- **Endpoints** (verified against Syracuse, Aug 2026): `users/me`,
  `users/{id}/courses?expand=course`, course contents (flat listings with `parentId`; file
  data on `contentHandler.file`), course announcements, `calendars/items`, and the v2
  gradebook (`columns`, `columns/{id}/users/me`; due dates at `grading.due`, points at
  `score.possible`). Paging caps at 100. Attachment downloads follow the item's
  `rel=alternate` `/ultra/redirect` link.
- **Tools**: `list_courses`, `get_course_content`, `get_announcements`, `get_assignments`,
  `get_grades`, `get_attachment`, `get_upcoming_work`, `get_recent_updates`,
  `get_assignment_context`. All read-only. Errors are short coded messages with sensitive
  values masked.
- **Low volume**: TTL caching, 150 to 200 ms delays between paged requests, hard request
  caps, and the shared browser closes after 5 idle minutes.
- **Configuration**: `BB_BROWSER_CHANNEL`, `BB_HEADLESS=0`, `BLACKBOARD_MCP_HOME`,
  `BB_BASE_URL`, `BB_SSO_ENTRY_URL`, and `BLACKBOARD_HOSTS` in `src/blackboard/hosts.ts`
  for other institutions.
- **Development**: `npm run typecheck`, `npm test` (63 tests, fully mocked), `npm run build`,
  `npm start`, and `npm run discover` (records real Blackboard traffic while you browse, to
  verify endpoints).
- **Compatibility**: built for Syracuse University Blackboard Ultra, Aug 2026. Other schools
  need the configuration above plus small parser checks. Windows untested.

</details>

## License

[MIT](LICENSE). Made for students, by a student.
