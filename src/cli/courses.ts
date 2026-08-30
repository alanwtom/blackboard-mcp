import { listCourses } from '../blackboard/courses.js';
import { BlackboardSession } from '../blackboard/session.js';
import { SESSION_EXPIRED_MESSAGE } from '../blackboard/errors.js';
import { writeMeta } from '../storage/session-store.js';
import { runCli } from './util.js';

function courseLine(name: string, courseCode: string | undefined, id: string): string {
  const code = courseCode ?? id;
  // Avoid "CIS 473 - CIS 473 Intro" when the name already carries the code.
  return name.toLowerCase().includes(code.toLowerCase().replace(/\./g, ' ').slice(0, 8))
    ? name
    : `${code} - ${name}`;
}

/** Milestone 1: print the student's currently visible Blackboard courses. */
async function main(): Promise<number> {
  const session = await BlackboardSession.acquire({ headless: true });
  try {
    // Re-establish the session (silently via SSO when possible) first.
    const identity = await session.probe().catch(() => null);
    if (!identity) {
      process.stdout.write(`${SESSION_EXPIRED_MESSAGE}\n`);
      return 1;
    }
    const courses = await listCourses(session);
    await writeMeta({ lastVerifiedAt: new Date().toISOString() }).catch(() => undefined);
    if (courses.length === 0) {
      process.stdout.write('No currently visible courses found.\n');
      return 0;
    }
    for (const course of courses) {
      process.stdout.write(`${courseLine(course.name, course.courseCode, course.id)}\n`);
    }
    return 0;
  } finally {
    await session.close();
  }
}

runCli(main);
