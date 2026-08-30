import { BlackboardSession } from '../blackboard/session.js';
import { runCli } from './util.js';

/**
 * Interactive login. Opens a visible Chrome window on the dedicated project
 * profile; the student completes Syracuse SSO and Duo by hand. This tool never
 * sees, requests, or stores any credential — it only waits for the browser to
 * land back on Blackboard and verifies the session with an authenticated call.
 */
async function main(): Promise<number> {
  process.stdout.write(
    [
      '',
      'Blackboard login (Syracuse University)',
      '--------------------------------------',
      'A Chrome window will open using a dedicated blackboard-mcp profile.',
      'Sign in with your NetID and complete Duo exactly as you normally would.',
      'This tool never sees or stores your password, Duo codes, or MFA secrets.',
      'Waiting for you to finish (up to 15 minutes)...',
      '',
    ].join('\n') + '\n',
  );

  const session = await BlackboardSession.acquire({ headless: false });
  try {
    await session.focusLoginWindow();
    await session.markLoginWindow();
    // Go straight to the sign-in flow in the dedicated window; the student
    // types every credential there themselves.
    await session.startLoginFlow();
    // Keep the banner + window title applied as pages change.
    const bannerTimer = setInterval(() => {
      void session.markLoginWindow();
    }, 2500);
    let tickTimer: NodeJS.Timeout | undefined;
    const identity = await session.waitForLogin({
      timeoutMs: 15 * 60_000,
      onTick: (status) => {
        process.stdout.write(`${new Date().toLocaleTimeString()} — ${status}\n`);
        // Keep the student oriented while the page sits still.
        clearInterval(tickTimer);
        tickTimer = setInterval(
          () => process.stdout.write(`${new Date().toLocaleTimeString()} — still waiting (${status})\n`),
          30_000,
        );
      },
    });
    clearInterval(bannerTimer);
    if (tickTimer) clearInterval(tickTimer);
    const who = identity.displayName ?? identity.userName ?? 'your account';
    process.stdout.write(`\nLogin successful — signed in as ${who}.\n`);
    process.stdout.write('Session saved in ~/.blackboard-mcp/chrome-profile.\n');
    process.stdout.write('Next: run `npm run courses` to verify, then start the MCP server with `npm start`.\n');
    return 0;
  } finally {
    await session.close();
  }
}

runCli(main);
