import { createInterface } from 'node:readline';
import { assertPublicUrl, BlackboardSession, rememberConnectedSites } from '../blackboard/session.js';
import { runCli } from './util.js';

/**
 * Sign in to an outside service (Google, Zoom, Microsoft, ...) once, in the
 * same dedicated browser the AI uses, so links that need a sign-in can be
 * read afterwards. Like `npm run login`, the student does every bit of typing
 * in a real window; this only opens the page and waits.
 *
 * Also takes a full link, for things like a Zoom recording passcode: open the
 * recording, type the passcode, close the window, and Zoom remembers it.
 */

const SERVICES: Record<string, { name: string; url: string }> = {
  google: { name: 'Google', url: 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fdrive.google.com%2F' },
  zoom: { name: 'Zoom (SU)', url: 'https://syracuseuniversity.zoom.us/signin' },
  microsoft: { name: 'Microsoft 365 (SU NetID)', url: 'https://www.office.com/login' },
  github: { name: 'GitHub', url: 'https://github.com/login' },
  box: { name: 'Box', url: 'https://account.box.com/login' },
  dropbox: { name: 'Dropbox', url: 'https://www.dropbox.com/login' },
};

function usage(): number {
  process.stdout.write(
    [
      '',
      'Usage: npm run connect -- <service or link>',
      '',
      `Services: ${Object.keys(SERVICES).join(', ')}`,
      'Or paste a full link, e.g. a Zoom recording that needs a passcode.',
      '',
      'Example: npm run connect -- zoom',
      '',
    ].join('\n'),
  );
  // Not an error worth npm's red failure block: the student just needs the usage.
  return 0;
}

async function main(): Promise<number> {
  const arg = process.argv[2]?.trim();
  if (!arg) return usage();
  const known = SERVICES[arg.toLowerCase()];
  let target: string;
  let name: string;
  if (known) {
    target = known.url;
    name = known.name;
  } else {
    try {
      target = assertPublicUrl(arg).toString();
      name = new URL(target).hostname;
    } catch {
      return usage();
    }
  }

  process.stdout.write(
    [
      '',
      `Sign in to ${name}`,
      '-'.repeat(`Sign in to ${name}`.length),
      'A browser window will open using the dedicated blackboard-mcp profile.',
      'Sign in there exactly as you normally would. This tool never sees or stores your password.',
      'When you are done, close that window (or press Enter here).',
      '',
      'If Google says "this browser or app may not be secure", it will not allow sign-in here.',
      'Ask the professor to share the file as "anyone with the link" instead.',
      '',
    ].join('\n'),
  );

  const session = await BlackboardSession.acquire({ headless: false });
  try {
    const page = await session.openPage(target);
    await page.bringToFront().catch(() => undefined);
    // Remember which sites this sign-in touched, so their cookies are kept
    // across restarts (many sign-ins, Zoom's included, are session cookies
    // that Chrome drops when it closes). The snapshot is refreshed while the
    // window is open, because once the student closes it there is nothing
    // left to read the cookies from.
    const remember = async (): Promise<void> => {
      await rememberConnectedSites(session.openPageHosts());
      await session.saveSnapshot();
    };
    await new Promise<void>((resolve) => {
      const rl = createInterface({ input: process.stdin });
      let finished = false;
      const done = (): void => {
        if (finished) return;
        finished = true;
        rl.close();
        clearInterval(poll);
        resolve();
      };
      rl.on('line', done);
      // Closing the last tab (or the window) means "finished".
      const poll = setInterval(() => {
        if (session.openPageCount() === 0) done();
        else void remember();
      }, 2000);
    });
    await remember();
    process.stdout.write(`\nDone. The AI can now read ${name} links you have access to. Reopen your AI app.\n`);
    return 0;
  } finally {
    await session.close();
  }
}

runCli(main);
