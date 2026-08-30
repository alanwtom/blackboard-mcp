# Blackboard MCP — your Blackboard, readable by your AI

This lets you ask an AI assistant things like:

> *"What do I have due this week?"*
> *"What did my professor post in Minds and Machines lately?"*
> *"What did I get on the last problem set, and was there feedback?"*
> *"Give me everything about the Essay assignment — instructions, files, and all."*

and get real answers from **your own Blackboard** — your courses, your assignments, your
grades, your class announcements. Nothing is invented, nothing is submitted, nothing leaves
your laptop.

It works by using **your own logged-in Blackboard session** — the same one your browser uses
— so it can only ever see what *you* can already see. It is **read-only**: it can look, but it
can never submit, post, message, delete, or change anything.

Whether you're a studio art major or a computer science major, setup takes about ten minutes
and you only do it once. If you've never opened a terminal before, just follow the steps
exactly — every command is copy-paste.

---

## What you need (check these three things)

1. **A Mac** (this guide is written for macOS; Windows works similarly but is untested).
2. **Google Chrome** — [get it free here](https://www.google.com/chrome/) if you don't have it.
3. **Node.js** — a free, safe program other software runs on.
   - Not sure if you have it? Open **Terminal** (press `Cmd + Space`, type `Terminal`, press
     Enter), type `node -v` and press Enter.
   - If you see something like `v20.9.0` or higher, you're set. If you see "command not
     found", download the **LTS** version from [nodejs.org](https://nodejs.org) and click
     through the installer.

## An AI assistant that can use it

This is a "MCP server" — a plug-in that lets AI assistants (like Claude) use outside tools.
You'll need one that supports MCP, for example **Claude Desktop** (free from
[claude.ai/download](https://claude.ai/download)) or **Claude Code**. Other MCP-capable apps
work too.

---

## Setup — do these five steps once

Open **Terminal** (Cmd + Space → type `Terminal` → Enter), then follow along. You can
copy-paste each command and press Enter after each one.

### Step 1 — Get the project

```bash
cd ~/Documents/Github
git clone https://github.com/alanwtom/blackboard-mcp.git
cd blackboard-mcp
```

> This downloads the project into your Documents → Github folder. If `git` says it's not
> installed, macOS will offer to install it — say yes, then run the command again.

### Step 2 — Install the pieces

```bash
npm install
```

> This fetches the building blocks the project needs. Takes a minute or two — you'll see some
> scrolling text. That's normal.

### Step 3 — Log in to Blackboard (the only step that involves you)

```bash
npm run login
```

A **Chrome window will open**. Sign in with your NetID and approve Duo, exactly like you
normally would. **Important: do this in the new window** — it has a big red banner across the
top and says "SIGN IN HERE" in its title, so you can't miss it.

When the tool sees you've landed back on Blackboard, it closes the window by itself and
confirms. **Your password and Duo codes are never seen, saved, or transmitted anywhere by
this project** — that part is always just you, typing in a real browser.

### Step 4 — Check that it worked

```bash
npm run courses
```

You should see your real course list, like:

```
PHI.378.M001.FALL26.Minds and Machines
CIS.473.M001.SPRING26.Automata and Computability
...
```

If you see your courses — congratulations, the hard part is done.

### Step 5 — Connect it to your AI assistant

These instructions are for **Claude Desktop**; other apps have a similar settings screen.

1. Open Claude Desktop → **Settings** → **Developer** → **Edit Config**. This opens a
   settings file.
2. Add this block (if the file already has content, add it inside the existing `{ }` —
   a friendly way to think of it: you're introducing your AI to a new helper):

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

3. **Change `/Users/yourname/...` to where you put the project.** Not sure? Type this in
   Terminal and copy what it prints:

   ```bash
   echo ~/Documents/Github/blackboard-mcp/dist/index.js
   ```

4. Save the file and **quit Claude Desktop completely** (Cmd + Q), then reopen it. You should
   see a hammer/tools icon in the message box — that's your new Blackboard connection.

> **Note:** Step 5 points your AI at the folder where YOU downloaded the project. The exact
> folder path is different on every computer — that's why Step 5.3 has you look yours up.

---

## Using it

Just talk to your AI like a person:

- *"What's due in the next 7 days across all my classes?"*
- *"Any new announcements in my courses this week?"*
- *"What's my current grade in Calculus?"*
- *"Find the Essay assignment and pull up the instructions and attached files."*
- *"Download the lecture slides from Week 3 so I can look at them."*

The first question may take 10–20 seconds (it's politely asking Blackboard for your data).
After that it's quick.

Files your AI downloads (like lecture slides) are saved to a folder on your Mac:
`~/.blackboard-mcp/downloads`. Your AI will tell you the exact location of each file.

## Troubleshooting — when things act up

| What you see | What to do |
| --- | --- |
| "Blackboard session expired. Run npm run login again." | Totally normal after a while. Run `npm run login` in Terminal and sign in again. Often you won't even need to — the tool quietly re-uses your school's sign-in on its own. |
| Login worked but a question still fails | Run `npm run status` to double-check, then ask again — Blackboard sometimes has brief hiccups. |
| The login window appeared but nothing happens | Make sure you're typing your NetID **in the window with the red banner**, not your usual Chrome. It's a separate, private browser just for this tool. |
| My AI doesn't show any Blackboard tools | Quit and reopen your AI app completely after editing the config, and double-check the folder path in Step 5. |
| A course shows no assignments or grades | Some older courses are archived by the university and can't be read by anyone (including in your browser). Brand-new courses may just not have anything posted yet. |

## What this will never do

By design, there is no code in this project that could:

- submit an assignment or a quiz,
- post in a discussion or message a professor,
- change a grade, delete anything, or edit your settings.

It only ever **reads**. And it only reads things **you can already see** when you log in —
it uses your session, not a special backdoor.

## Your privacy, in plain words

- Your **password and Duo codes are never requested, read, or stored** by this project.
  Login is you typing in a real Chrome window; the project just waits politely.
- Everything stays **on your Mac**. No server, no account, no analytics.
- Your sign-in lives in a private browser profile at `~/.blackboard-mcp/` on your computer.
  **Never share or back up that folder** — it's the equivalent of leaving your browser logged
  in.
- You can erase everything at any time: run `npm run logout`, or just delete the
  `~/.blackboard-mcp` folder.

## Being a good citizen

Use it for yourself, at a human pace. The tool is deliberately gentle with Blackboard's
servers (caching, small delays, request caps) — keep it that way, and check your
university's acceptable-use policy before using any automation with your student account.
This project is not affiliated with or endorsed by Syracuse University or
Anthology/Blackboard.

---

## For the technically curious

<details>
<summary><strong>Click to expand: architecture, configuration, and developer notes</strong></summary>

- **Stack**: TypeScript (ESM), Node 20+, Playwright (Chrome channel, dedicated profile),
  official MCP TypeScript SDK over stdio, Zod, Vitest.
- **Architecture**: MCP tool handlers call a Blackboard service layer; requests run as
  same-origin `fetch`es from a page on the Blackboard host, so they're identical to what the
  Ultra web app itself sends. Both `blackboard.syr.edu` and `blackboard.syracuse.edu`
  (separate cookie domains) are supported; the working origin is persisted.
- **Session resilience**: Learn's session cookie doesn't survive browser restarts, so the
  authenticated cookie set is snapshotted to `~/.blackboard-mcp/browser-state.json` (mode
  0600) and restored on launch; while the institution's SSO session lasts, the SAML entry is
  followed silently to re-establish Blackboard access with zero interaction.
- **Data sources** (verified against Syracuse's deployment, Aug 2026):
  `users/me`, `users/{id}/courses?expand=course`, course contents (flat listings with
  `parentId`; file data on `contentHandler.file`), course announcements, the Ultra calendar
  (`calendars/items`), and the v2 gradebook (`columns`, `columns/{id}/users/me`; due dates at
  `grading.due`, points at `score.possible`). Paging is capped at 100. Attachment downloads
  follow the item's `rel=alternate` `/ultra/redirect` link (the content-files endpoints 404
  on this deployment).
- **Tools**: `list_courses`, `get_course_content`, `get_announcements`, `get_assignments`,
  `get_grades`, `get_attachment`, `get_upcoming_work`, `get_recent_updates`,
  `get_assignment_context`. All annotated read-only; errors are short coded messages
  (`BLACKBOARD_SESSION_EXPIRED`, `COURSE_NOT_FOUND`, `PERMISSION_DENIED`, ...) with sensitive
  values masked.
- **Caching**: in-process TTLs (courses 10 min, most else 5 min), 150–200 ms courtesy delays
  between paged requests, hard caps on pages/items, and the shared browser closes after 5
  idle minutes.
- **Configuration**: `BB_BROWSER_CHANNEL` (default `chrome`), `BB_HEADLESS=0` to watch the
  browser work, `BLACKBOARD_MCP_HOME` (default `~/.blackboard-mcp`), `BB_BASE_URL` and
  `BB_SSO_ENTRY_URL` for other institutions (also update `BLACKBOARD_HOSTS` in
  `src/blackboard/hosts.ts`).
- **Development**: `npm run typecheck`, `npm test` (63 tests, all network mocked — live
  checks are never part of the suite), `npm run build`, `npm start`.
- **Endpoint discovery**: `npm run discover` opens the dedicated browser and records every
  Blackboard API call your normal clicking makes, so parsers can be verified against real
  traffic instead of guesses.
- **Compatibility**: built for Syracuse University's Blackboard Ultra (Aug 2026). Other
  schools: same Learn REST API, but set `BB_BASE_URL`/`BB_SSO_ENTRY_URL`, adjust
  `BLACKBOARD_HOSTS`, and verify with `npm run discover`. Windows untested.

</details>

## License

[MIT](LICENSE) — free to use, study, and improve. Made for students, by a student.
