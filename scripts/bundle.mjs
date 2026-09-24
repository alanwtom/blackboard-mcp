// Build the one-click Claude Desktop extension: release/blackboard-mcp.mcpb.
// Students download that single file and double-click it; Claude Desktop
// supplies Node.js itself, so they install nothing else.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, 'build', 'extension');
const out = path.join(root, 'release', 'blackboard-mcp.mcpb');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const f of ['dist', 'package.json', 'package-lock.json', 'LICENSE']) cpSync(path.join(root, f), path.join(stage, f), { recursive: true });
cpSync(path.join(root, 'extension', 'icon.png'), path.join(stage, 'icon.png'));

// One version number everywhere: the manifest takes package.json's.
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(root, 'extension', 'manifest.json'), 'utf8'));
manifest.version = pkg.version;
writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// Runtime packages only (no compiler or test tools), no install scripts.
run(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-fund', '--no-audit'], stage);

mkdirSync(path.dirname(out), { recursive: true });
rmSync(out, { force: true });
run('npx', ['-y', '@anthropic-ai/mcpb@2.1.2', 'validate', path.join(stage, 'manifest.json')]);
run('npx', ['-y', '@anthropic-ai/mcpb@2.1.2', 'pack', stage, out]);
console.log(`\nBuilt ${path.relative(root, out)}`);
