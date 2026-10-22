import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Students run the built files in dist/ directly (setup no longer installs
 * the compiler), so dist/ is committed. This fails the moment it no longer
 * matches the source: run `npm run build` and commit dist/ with the change.
 */
function files(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(root, full) : [path.relative(root, full)];
  });
}

describe('shipped build', () => {
  it('dist/ matches a fresh build of src/', () => {
    const repo = path.resolve(__dirname, '..');
    const out = mkdtempSync(path.join(os.tmpdir(), 'bb-dist-'));
    try {
      execFileSync(process.execPath, [path.join(repo, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json', '--outDir', out], { cwd: repo });
      const fresh = files(out).sort();
      expect(files(path.join(repo, 'dist')).sort()).toEqual(fresh);
      // Git stores LF, but a Windows checkout with autocrlf writes CRLF, so compare
      // line endings as LF: the content is what matters, not the newline style.
      const lf = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
      for (const f of fresh) {
        expect(lf(path.join(repo, 'dist', f)), `dist/${f} is out of date — run npm run build`).toBe(lf(path.join(out, f)));
      }
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});
