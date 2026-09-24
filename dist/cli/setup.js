import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlackboardSession } from '../blackboard/session.js';
import { isBlackboardError } from '../blackboard/errors.js';
import { hasSession, paths, writeMeta } from '../storage/session-store.js';
import { BROWSER_NAMES, IS_WINDOWS, claudeDesktopConfigPath, findExecutable, installedBrowsers, isBrowserInstalled, localTscScript, quitAppHint, runCommand, } from '../platform.js';
const rl = createInterface({ input, output });
const ok = (msg) => console.log(`  [ok] ${msg}`);
const warn = (msg) => console.log(`  [ !! ] ${msg}`);
const say = (msg) => console.log(`\n${msg}`);
async function askYesNo(question, defaultYes = true) {
    const hint = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = (await rl.question(`  ${question} ${hint}: `)).trim().toLowerCase();
    if (answer === '')
        return defaultYes;
    return answer === 'y' || answer === 'yes';
}
function projectRoot() {
    // dist/cli/setup.js -> project root is two levels up.
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}
function checkNode() {
    const major = Number(process.versions.node.split('.')[0]);
    // 22, not 20: the PDF reader needs it, and on older Node every PDF would
    // quietly come back "unreadable". Node 20 stopped getting updates in 2026.
    if (major >= 22) {
        ok(`Node.js v${process.versions.node}`);
        return true;
    }
    warn(`Node.js v${process.versions.node} is too old (22 or newer required).`);
    console.log('       Download the LTS version from https://nodejs.org, then run setup again.');
    return false;
}
/**
 * A browser the tool can drive: Chrome or Edge if either is installed (every
 * Windows PC has Edge), otherwise offer to download a private Chromium that
 * only this tool uses — the usual case for a Safari-only Mac.
 */
async function checkBrowser() {
    const found = installedBrowsers();
    if (found.length > 0) {
        ok(`Browser: ${BROWSER_NAMES[found[0]]}`);
        return true;
    }
    warn('Neither Google Chrome nor Microsoft Edge is installed.');
    console.log('       blackboard-mcp can download its own copy of Chromium (the open-source base of Chrome).');
    console.log('       It is used only by this tool, never as your everyday browser. A 150 MB download (about 360 MB on disk), one time.');
    if (!(await askYesNo('Download it now?'))) {
        console.log('       Or install Google Chrome from https://www.google.com/chrome/, then run setup again.');
        return false;
    }
    const cli = path.join(projectRoot(), 'node_modules', 'playwright', 'cli.js');
    // --no-shell: the tool runs the full browser even when hidden, so the
    // separate "headless shell" download would be wasted space.
    const result = runCommand(process.execPath, [cli, 'install', '--no-shell', 'chromium'], { cwd: projectRoot(), stdio: 'inherit' });
    if (result.status === 0 && isBrowserInstalled('chromium')) {
        ok(`Browser: ${BROWSER_NAMES.chromium}`);
        return true;
    }
    warn('The download did not finish. Check your internet connection and run setup again, or install Google Chrome.');
    return false;
}
function checkBuilt() {
    const dist = path.join(projectRoot(), 'dist', 'index.js');
    if (fs.existsSync(dist)) {
        ok('Project is built');
        return true;
    }
    // The built files ship with the project, so this only happens in a copy
    // that lost them; students get only the runtime packages, not the compiler.
    warn('Project is not built yet. Attempting to build (takes a moment)...');
    // Run the compiler that npm install already placed in node_modules. Going
    // through `npx` would mean spawning npx.cmd on Windows, which Node refuses
    // to execute directly.
    const tsc = localTscScript(projectRoot());
    if (!tsc) {
        warn('The project files look incomplete. Download the project again (or run `npm install`, then `npm run build`).');
        return false;
    }
    const result = runCommand(process.execPath, [tsc, '-p', 'tsconfig.json'], {
        cwd: projectRoot(),
        stdio: 'inherit',
    });
    const built = result.status === 0 && fs.existsSync(dist);
    if (built)
        ok('Project is built');
    else
        warn('Build failed. Run `npm install` and then `npm run build` to see the details.');
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
function nodeCommand() {
    if (IS_WINDOWS)
        return process.execPath;
    return findExecutable('node') ?? process.execPath;
}
const serverScript = () => path.join(projectRoot(), 'dist', 'index.js');
/** Whether the one-click Blackboard extension is already installed in Claude Desktop. */
function hasBlackboardExtension(configDir) {
    try {
        return fs.readdirSync(path.join(configDir, 'Claude Extensions')).some((name) => name.includes('blackboard-mcp'));
    }
    catch {
        return false;
    }
}
function configureClaudeDesktop() {
    const configPath = claudeDesktopConfigPath();
    const configDir = path.dirname(configPath);
    // Adding it here as well would make every Blackboard tool appear twice.
    if (hasBlackboardExtension(configDir)) {
        ok('Claude Desktop already has the Blackboard extension installed');
        return true;
    }
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
    let config;
    try {
        const raw = hasConfigFile ? fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '').trim() : '';
        config = raw === '' ? {} : JSON.parse(raw);
    }
    catch {
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
        if (hasConfigFile)
            fs.copyFileSync(configPath, `${configPath}.bak-blackboard-setup`);
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
        ok(existing
            ? 'Claude Desktop connection updated to this folder (backup saved next to the config)'
            : hasConfigFile
                ? 'Claude Desktop connected (backup saved next to the config)'
                : 'Claude Desktop connected (new config file created)');
        console.log(`       ${quitAppHint()} and reopen it to see the tools.`);
        return true;
    }
    catch (err) {
        warn(`Could not update Claude Desktop config automatically: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown error'}`);
        return false;
    }
}
function configureClaudeCode() {
    // `which` does not exist on Windows, and the CLI is a claude.cmd shim there.
    const claude = findExecutable('claude');
    if (!claude) {
        console.log('  [ -- ] Claude Code not found (skipping).');
        return false;
    }
    // User scope, so it works from any folder: the default scope is the
    // current folder only, and setup runs from the project folder, so `claude`
    // started anywhere else showed no Blackboard tools.
    const add = () => runCommand(claude, ['mcp', 'add', '--scope', 'user', 'blackboard', '--', nodeCommand(), serverScript()]);
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
async function checkSession() {
    console.log('  Checking your Blackboard session (this can take up to a minute)...');
    const session = await BlackboardSession.acquire({ headless: true });
    try {
        const identity = await session.probe().catch(() => null);
        if (!identity)
            return false;
        await writeMeta({ lastVerifiedAt: new Date().toISOString() }).catch(() => undefined);
        const who = identity.displayName ?? identity.userName ?? 'you';
        ok(`Blackboard session active (signed in as ${who})`);
        return true;
    }
    finally {
        await session.close();
    }
}
async function runLogin() {
    console.log('\n  Opening a browser window for you to sign in.');
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
        }
        finally {
            clearInterval(bannerTimer);
        }
    }
    finally {
        await session.close();
    }
}
async function main() {
    console.log('');
    console.log('  ===================================');
    console.log('  blackboard-mcp setup');
    console.log('  ===================================');
    console.log('  This walks you through everything: dependencies, your Blackboard');
    console.log('  login, and connecting your AI assistant. Nothing is submitted to');
    console.log('  Blackboard by this tool, and your password is never seen by it.');
    console.log('');
    console.log('Step 1 of 4: dependencies');
    const depsOk = checkNode() && (await checkBrowser()) && checkBuilt();
    console.log('\nStep 2 of 4: connecting your AI assistant');
    if (await askYesNo('Connect Claude Desktop automatically?'))
        configureClaudeDesktop();
    if (await askYesNo('Connect Claude Code too (if installed)?', false))
        configureClaudeCode();
    console.log('\nStep 3 of 4: your Blackboard session');
    let active = false;
    let busy = false;
    if (await hasSession()) {
        try {
            active = await checkSession();
        }
        catch (err) {
            if (isBlackboardError(err) && err.code === 'BROWSER_PROFILE_BUSY') {
                busy = true;
                warn('Your AI app is using Blackboard right now, so setup cannot check your login.');
                console.log(`       ${quitAppHint().replace('Quit it', 'Quit Claude Desktop (and any claude session in a terminal)')}, then run setup again.`);
            }
            active = false;
        }
    }
    else {
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
                }
                finally {
                    await session.close();
                }
            }
        }
        else {
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
    }
    else if (!active) {
        warn('Login was not completed. Run `npm run setup` or `npm run login` before using the tools.');
    }
    else {
        ok('Everything is ready.');
    }
    say([
        '  Next: quit and reopen your AI app (if it was connected), then try asking:',
        '    "What do I have due next week?"',
        '    "What are my grades in <course>?"',
        '',
        `  Downloads land in ${paths.downloadsDir}.`,
        '  If a session ever expires: npm run login. That is usually all it takes.',
        '',
    ].join('\n'));
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
