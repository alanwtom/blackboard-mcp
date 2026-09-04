import { BlackboardSession } from '../blackboard/session.js';
import { isBlackboardError } from '../blackboard/errors.js';
import { hasSession, readMeta, writeMeta } from '../storage/session-store.js';
import { runCli } from './util.js';

/** Reports whether the stored Blackboard session still works. */
async function main(): Promise<number> {
  if (!(await hasSession())) {
    process.stdout.write('No Blackboard session found. Run npm run login first.\n');
    return 1;
  }

  const session = await BlackboardSession.acquire({ headless: true });
  try {
    const identity = await session.probe();
    if (identity) {
      await writeMeta({ lastVerifiedAt: new Date().toISOString() });
      const who = identity.displayName ?? identity.userName;
      process.stdout.write(who ? `Blackboard session active (signed in as ${who}).\n` : 'Blackboard session active.\n');
      return 0;
    }
    process.stdout.write('Blackboard session expired. Run npm run login again.\n');
    return 1;
  } catch (err) {
    if (isBlackboardError(err) && err.code === 'NOT_LOGGED_IN') {
      process.stdout.write('Blackboard session expired. Run npm run login again.\n');
      return 1;
    }
    throw err;
  } finally {
    await session.close();
  }
}

void readMeta;
runCli(main);
