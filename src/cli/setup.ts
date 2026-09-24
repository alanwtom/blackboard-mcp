import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BlackboardSession } from '../blackboard/session.js';
import { isBlackboardError } from '../blackboard/errors.js';
import { hasSession, paths, writeMeta } from '../storage/session-store.js';
import {
  IS_WINDOWS,
  chromeInstallCandidates,
  claudeDesktopConfigPath,
  findExecutable,
  isChromeInstalled,
  localTscScript,
  quitAppHint,
  runCommand,
} from '../platform.js';

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
  if (isChromeInstalled()) {
    ok('Google Chrome installed');
    return true;
  }
  warn('Google Chrome was not found.');
  console.log('       Install it from https://www.google.com/chrome/ and run setup again.');
  console.log(`       Looked in: ${chromeInstallCandidates().join(', ')}`);
  return false;
}

function checkBuilt(): boolean {
  const dist = path.join(projectRoot(), 'dist', 'index.js');
  if (fs.existsSync(dist)) {
    ok('Project is built');
    return true;
  }
  warn('Project is not built yet. Attempting to build (takes a moment)...');
  // Run the compiler that npm install already placed in node_modules. Going
  // through `npx` would mean spawning npx.cmd on Windows, which Node refuses
  // to execute directly.
  const tsc = localTscScript(projectRoot());
  if (!tsc) {
    warn('Could not find the TypeScript compiler. Run `npm install`, then `npm run build`.');
    return false;
  }
  const result = runCommand(process.execPath, [tsc, '-p', 'tsconfig.json'], {
    cwd: projectRoot(),
    stdio: 'inherit',
  });
  const built = result.status === 0 && fs.existsSync(dist);
  if (built) ok('Project is built');
  else warn('Build failed. Run `npm install` and then `npm run build` to see the details.');
  return built;
}

/**
 * How the AI app should invoke Node: always a full path. Apps opened from the
 * Start menu or Finder do not get the Terminal's PATH, so a bare `node` fails
 * whenever Node came from Homebrew or nvm — setup said "connected" and the
 * tools never appeared. On a Mac the PATH entry is preferred over the running
 * binary because Homebrew's /opt/homebrew/bin/node survives `brew upgrade`,
 * while the versioned Cellar path behind it does not.
 */
function nodeCommand(): string {
  if (IS_WINDOWS) return process.execPath;
  return findExecutable('node') ?? process.execPath;
}

const serverScript = (): string => path.join(projectRoot(), 'dist', 'index.js');

function configureClaudeDesktop(): boolean {
  const configPath = claudeDesktopConfigPath();
  const configDir = path.dirname(configPath);
  const hasConfigFile = fs.existsSync(configPath);
  // The app's own folder is the reliable sign that it is installed. The config
  // file itself only appears once the student has opened Developer settings,
  // so a missing file is a normal first run, not a missing app.
  if (!hasConfigFile && !fs.existsSync(configDir)) {
    console.log('  [ -- ] Claude Desktop not found (skipping).');
    console.log('         If you have installed it: open Claude Desktop once, quit it, then run setup again.');
    console.log('         Otherwise you can get it from https://claude.ai/download');
    return false;
  }
  let config: { mcpServers?: Record<string, { command?: string; args?: string[] }> } & Record<string, unknown>;
  try {
    const raw = hasConfigFile ? fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '').trim() : '';
    config = raw === '' ? {} : JSON.parse(raw);
  } catch {
    warn('Your Claude Desktop settings file has a typo in it, so setup left it alone.');
    console.log('       In Claude Desktop open Settings > Developer > Edit Config and fix it, or follow the manual steps in the README.');
    return false;
  }
  try {
    const existing = config.mcpServers?.blackboard;
    // "Already connected" only counts if it points at THIS copy of the
    // project and a Node that exists. An entry left over from an earlier
    // clone in another folder launches nothing, and used to be accepted.
    const pointsHere = existing?.args?.[0] === serverScript();
    const nodeExists = typeof existing?.command === 'string' && path.isAbsolute(existing.command) && fs.existsSync(existing.command);
    if (pointsHere && nodeExists) {
      ok('Claude Desktop already connected to blackboard-mcp');
      return true;
    }
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.blackboard = {
      command: nodeCommand(),
      args: [serverScript()],
    };
    if (hasConfigFile) fs.copyFileSync(configPath, `${configPath}.bak-blackboard-setup`);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    ok(
      existing
        ? 'Claude Desktop connection updated to this folder (backup saved next to the config)'
        : hasConfigFile
          ? 'Claude Desktop connected (backup saved next to the config)'
          : 'Claude Desktop connected (new config file created)',
    );
    console.log(`       ${quitAppHint()} and reopen it to see the tools.`);
    return true;
  } catch (err) {
    warn(`Could not update Claude Desktop config automatically: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown error'}`);
    return false;
  }
}

function configureClaudeCode(): boolean {
  // `which` does not exist on Windows, and the CLI is a claude.cmd shim there.
  const claude = findExecutable('claude');
  if (!claude) {
    console.log('  [ -- ] Claude Code not found (skipping).');
    return false;
  }
  // User scope, so it works from any folder: the default scope is the
  // current folder only, and setup runs from the project folder, so `claude`
  // started anywhere else showed no Blackboard tools.
  const add = (): ReturnType<typeof runCommand> =>
    runCommand(claude, ['mcp', 'add', '--scope', 'user', 'blackboard', '--', nodeCommand(), serverScript()]);
  let result = add();
  let output = result.stderr || result.stdout || '';
  if (result.status !== 0 && /already exists/i.test(output)) {
    // An old entry may point at a folder that no longer exists; replace it
    // rather than trusting it.
    runCommand(claude, ['mcp', 'remove', '--scope', 'user', 'blackboard']);
    result = add();
    output = result.stderr || result.stdout || '';
  }
  if (result.status === 0) {
    ok('Claude Code connected (run: claude, then type /mcp to confirm)');
    return true;
  }
  warn(`Could not add to Claude Code: ${output.slice(0, 120)}`);
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
  let busy = false;
  if (await hasSession()) {
    try {
      active = await checkSession();
    } catch (err) {
      if (isBlackboardError(err) && err.code === 'BROWSER_PROFILE_BUSY') {
        busy = true;
        warn('Your AI app is using Blackboard right now, so setup cannot check your login.');
        console.log(`       ${quitAppHint().replace('Quit it', 'Quit Claude Desktop (and any claude session in a terminal)')}, then run setup again.`);
      }
      active = false;
    }
  } else {
    console.log('  [ -- ] No Blackboard session found (first time setup).');
  }
  if (!active && !busy) {
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
  if (busy) {
    warn('Login could not be checked because the AI app was open. Quit it and run `npm run setup` again.');
  } else if (!active) {
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
      `  Downloads land in ${paths.downloadsDir}.`,
      '  If a session ever expires: npm run login. That is usually all it takes.',
      '',
    ].join('\n'),
  );
  rl.close();
  // Dependencies are fine and the student simply chose to log in later:
  // exiting non-zero here made npm print a red "setup failed" block right
  // under the friendly summary.
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`\n  setup failed: ${err instanceof Error ? err.message : String(err)}`);
    rl.close();
    process.exit(1);
  });
