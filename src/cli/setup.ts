import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BlackboardSession } from '../blackboard/session.js';
import { isBlackboardError } from '../blackboard/errors.js';
import { hasProfileData, writeMeta } from '../storage/session-store.js';

const rl = createInterface({ input, output });

const ok = (msg: string): void => console.log(`  [ok] ${msg}`);
const warn = (msg: string): void => console.log(`  [ !! ] ${msg}`);
const say = (msg: string): void => console.log(`\n${msg}`);

async function askYesNo(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const answer = (await rl.question(`  ${question} ${hint}: `)).trim().toLowerCase();
  if (answer === '') return defaultYes;
  return answer === 'y' || answer === 'yes';
}

function projectRoot(): string {
  // dist/cli/setup.js -> project root is two levels up.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function checkNode(): boolean {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) {
    ok(`Node.js v${process.versions.node}`);
    return true;
  }
  warn(`Node.js v${process.versions.node} is too old (20 or newer required).`);
  console.log('       Download the LTS version from https://nodejs.org, then run setup again.');
  return false;
}

function checkChrome(): boolean {
  const candidates = ['/Applications/Google Chrome.app'];
  const found = candidates.some((p) => fs.existsSync(p));
  if (found) {
    ok('Google Chrome installed');
    return true;
  }
  warn('Google Chrome was not found.');
  console.log('       Install it from https://www.google.com/chrome/ and run setup again.');
  return false;
}

function checkBuilt(): boolean {
  const dist = path.join(projectRoot(), 'dist', 'index.js');
  if (fs.existsSync(dist)) {
    ok('Project is built');
    return true;
  }
  warn('Project is not built yet. Attempting to build (takes a moment)...');
  const result = spawnSync('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: projectRoot(), stdio: 'inherit' });
  const built = result.status === 0 && fs.existsSync(dist);
  if (built) ok('Project is built');
  return built;
}

function configureClaudeDesktop(): boolean {
  const configPath = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (!fs.existsSync(configPath)) {
    console.log('  [ -- ] Claude Desktop not found (skipping). You can install it from https://claude.ai/download');
    return false;
  }
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const entry = JSON.stringify(config.mcpServers?.blackboard ?? null);
    if (entry.includes('blackboard-mcp')) {
      ok('Claude Desktop already connected to blackboard-mcp');
      return true;
    }
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.blackboard = {
      command: 'node',
      args: [path.join(projectRoot(), 'dist', 'index.js')],
    };
    fs.copyFileSync(configPath, `${configPath}.bak-blackboard-setup`);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    ok('Claude Desktop connected (backup saved next to the config)');
    console.log('       Quit Claude Desktop completely (Cmd + Q) and reopen it to see the tools.');
    return true;
  } catch (err) {
    warn(`Could not update Claude Desktop config automatically: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown error'}`);
    return false;
  }
}

function configureClaudeCode(): boolean {
  const which = spawnSync('which', ['claude'], { encoding: 'utf8' });
  if (which.status !== 0 || !which.stdout.trim()) {
    console.log('  [ -- ] Claude Code not found (skipping).');
    return false;
  }
  const result = spawnSync(
    'claude',
    ['mcp', 'add', 'blackboard', '--', 'node', path.join(projectRoot(), 'dist', 'index.js')],
    { encoding: 'utf8' },
  );
  if (result.status === 0) {
    ok('Claude Code connected (run: claude, then type /mcp to confirm)');
    return true;
  }
  warn(`Could not add to Claude Code: ${(result.stderr || result.stdout || '').slice(0, 120)}`);
  return false;
}

async function checkSession(): Promise<boolean> {
  console.log('  Checking your Blackboard session (this can take up to a minute)...');
  const session = await BlackboardSession.acquire({ headless: true });
  try {
    const identity = await session.probe().catch(() => null);
    if (!identity) return false;
    await writeMeta({ lastVerifiedAt: new Date().toISOString() }).catch(() => undefined);
    const who = identity.displayName ?? identity.userName ?? 'you';
    ok(`Blackboard session active (signed in as ${who})`);
    return true;
  } finally {
    await session.close();
  }
}

async function runLogin(): Promise<boolean> {
  console.log('\n  Opening a Chrome window for you to sign in.');
  console.log('  Use the window with the RED BANNER. Sign in with your NetID and approve Duo.');
  console.log('  This tool never sees or stores your password or Duo codes.');
  const session = await BlackboardSession.acquire({ headless: false });
  try {
    await session.focusLoginWindow();
    await session.markLoginWindow();
    await session.startLoginFlow();
    const bannerTimer = setInterval(() => {
      void session.markLoginWindow();
    }, 2500);
    try {
      const identity = await session.waitForLogin({
        timeoutMs: 15 * 60_000,
        onTick: (status) => process.stdout.write(`  ... ${status}\n`),
      });
      const who = identity.displayName ?? identity.userName ?? 'you';
      ok(`Signed in as ${who}. Session saved.`);
      return true;
    } finally {
      clearInterval(bannerTimer);
    }
  } finally {
    await session.close();
  }
}

async function main(): Promise<number> {
  console.log('');
  console.log('  ===================================');
  console.log('  blackboard-mcp setup');
  console.log('  ===================================');
  console.log('  This walks you through everything: dependencies, your Blackboard');
  console.log('  login, and connecting your AI assistant. Nothing is submitted to');
  console.log('  Blackboard by this tool, and your password is never seen by it.');
  console.log('');

  console.log('Step 1 of 4: dependencies');
  const depsOk = checkNode() && checkChrome() && checkBuilt();

  console.log('\nStep 2 of 4: connecting your AI assistant');
  if (await askYesNo('Connect Claude Desktop automatically?')) configureClaudeDesktop();
  if (await askYesNo('Connect Claude Code too (if installed)?', false)) configureClaudeCode();

  console.log('\nStep 3 of 4: your Blackboard session');
  let active = false;
  if (await hasProfileData()) {
    try {
      active = await checkSession();
    } catch (err) {
      if (isBlackboardError(err) && err.code === 'BROWSER_PROFILE_BUSY') {
        warn('Another blackboard-mcp process is running. Close it, then answer the login step with no and run setup again.');
      }
      active = false;
    }
  } else {
    console.log('  [ -- ] No Blackboard session found (first time setup).');
  }
  if (!active) {
    if (await askYesNo('Open a browser to log in to Blackboard now?')) {
      active = await runLogin();
      if (active) {
        // Verify quietly so the summary is truthful.
        const session = await BlackboardSession.acquire({ headless: true });
        try {
          active = (await session.probe().catch(() => null)) !== null;
        } finally {
          await session.close();
        }
      }
    } else {
      console.log('  Skipping login. Run this setup again, or `npm run login`, whenever you like.');
    }
  }

  console.log('\nStep 4 of 4: done');
  if (!depsOk) {
    warn('Fix the dependency issues above and run `npm run setup` again.');
    rl.close();
    return 1;
  }
  if (!active) {
    warn('Login was not completed. Run `npm run setup` or `npm run login` before using the tools.');
  } else {
    ok('Everything is ready.');
  }
  say(
    [
      '  Next: quit and reopen your AI app (if it was connected), then try asking:',
      '    "What do I have due next week?"',
      '    "What are my grades in <course>?"',
      '',
      '  Downloads land in ~/.blackboard-mcp/downloads.',
      '  If a session ever expires: npm run login. That is usually all it takes.',
      '',
    ].join('\n'),
  );
  rl.close();
  return active ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\n  setup failed: ${err instanceof Error ? err.message : String(err)}`);
    rl.close();
    process.exit(1);
  });
