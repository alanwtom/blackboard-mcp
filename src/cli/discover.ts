import { promises as fs } from 'node:fs';
import { BlackboardSession, BASE_URL } from '../blackboard/session.js';
import { hasSession, paths } from '../storage/session-store.js';
import { runCli } from './util.js';

interface SeenRequest {
  method: string;
  path: string;
  status: number;
  contentType: string;
  count: number;
}

/**
 * Endpoint discovery (development tool). Opens a visible browser on the
 * dedicated profile and records every /learn/api/ and /bbcswebdav/ request
 * Blackboard itself makes while you click around normally. Use this to verify
 * what the integration should call on this deployment — never guessing.
 */
async function main(): Promise<number> {
  if (!(await hasSession())) {
    process.stdout.write('No Blackboard session found. Run npm run login first.\n');
    return 1;
  }

  process.stdout.write(
    [
      'Blackboard traffic recorder',
      '--------------------------',
      `A Chrome window will open at ${BASE_URL}.`,
      'Browse Blackboard normally (courses, content, grades, calendar...).',
      'Every Blackboard API call will be recorded here.',
      'Press Ctrl+C when done.',
      '',
    ].join('\n') + '\n',
  );

  const session = await BlackboardSession.acquire({ headless: false });
  const seen = new Map<string, SeenRequest>();

  const page = await session.openPage(`${BASE_URL}/ultra/courses`);

  page.on('response', async (response) => {
    try {
      const url = new URL(response.url());
      if (!url.hostname.endsWith('blackboard.syr.edu')) return;
      const p = url.pathname;
      if (!p.startsWith('/learn/api/') && !p.startsWith('/bbcswebdav/') && !p.startsWith('/learn/api/public/')) return;
      const key = `${response.request().method()} ${p}`;
      const existing = seen.get(key);
      if (existing) {
        existing.count += 1;
        return;
      }
      const headers = response.headers();
      seen.set(key, {
        method: response.request().method(),
        path: p + (url.search || ''),
        status: response.status(),
        contentType: headers['content-type'] ?? '',
        count: 1,
      });
      process.stdout.write(`  [${response.status()}] ${response.request().method()} ${p}${url.search || ''}\n`);
    } catch {
      /* ignore teardown races */
    }
  });

  const waitForStop = new Promise<void>((resolve) => {
    process.on('SIGINT', () => resolve());
  });
  await waitForStop;

  const lines: string[] = [];
  for (const req of seen.values()) {
    lines.push(`${req.status}\t${req.method}\t${req.path}\t${req.contentType}`);
  }
  await fs.mkdir(paths.home, { recursive: true });
  await fs.writeFile(paths.lastDiscoverFile, lines.join('\n') + '\n', 'utf8');
  await session.close();
  process.stdout.write(`\nRecorded ${seen.size} unique requests. Saved to ${paths.lastDiscoverFile}\n`);
  return 0;
}

runCli(main);
