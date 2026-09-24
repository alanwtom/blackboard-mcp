# AGENTS.md

## Long tasks: when to keep going, when to stop

These came from Anthropic's Opus 5.5 guidance (Sep 2026). They hold for any agent.

- **Keep going when a step doesn't need me.** Put status notes in the same message as your next
  action. Stop and ask only when you can't continue without me, or before anything destructive
  or outward-facing: deleting data, force-pushing, deploying to production, sending anything
  external, or changing anything outside this repository.
- **Know what "done" is before you start.** If the request doesn't define it, write the finish
  line down first (what works, what's gone, which checks pass) and work to it.
- **Keep the task list in a file, not in the conversation.** For work longer than one sitting,
  use the active goal in `.claude/goals/` if there is one, otherwise a `TASKS.md` checklist at
  the repo root (don't commit it). Tick items off as you go; re-read it after the conversation
  is summarized.
- **Split big audits and migrations across subagents.** Give each independent area its own
  subagent. When one reports back, check its evidence before you accept it.
- **Review your own diff before calling it done.** List only problems you'd block the merge
  for — where, why it's wrong, how to show it fails — and fix them.
- **Mark anything you couldn't confirm**, and say where you looked.
- **Lead the final message with what needs me.** Anything waiting on my input comes first (or
  say plainly that nothing is), then the summary.
- **Don't write "think hard" / "think carefully" into prompts, skills, goals or instructions.**
  The model already thinks before it replies; those lines only slow it down.

## Shipped build

- **`dist/` is committed on purpose.** Students run it directly, and setup installs only runtime
  packages (no compiler), which keeps their download small. After any change under `src/`, run
  `npm run build` and commit `dist/` in the same commit. `npm test` fails if it is stale.
