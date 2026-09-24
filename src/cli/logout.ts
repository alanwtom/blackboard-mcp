import { clearProfile, hasSession, isProfileInUse, paths } from '../storage/session-store.js';
import { quitAppHint } from '../platform.js';
import { runCli } from './util.js';

/** Wipes the saved Blackboard session and dedicated browser profile: the local logout. */
async function main(): Promise<number> {
  // An open AI app would keep the browser running and save the session
  // right back after we deleted it, so stop and say so first.
  if (await isProfileInUse()) {
    process.stdout.write(
      `Your AI app is using Blackboard right now. ${quitAppHint().replace('Quit it', 'Quit Claude Desktop (and any claude session in a terminal)')}, then run npm run logout again.\n`,
    );
    return 1;
  }
  if (!(await hasSession())) {
    process.stdout.write('No stored Blackboard session to remove.\n');
  } else {
    try {
      await clearProfile();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EBUSY' || code === 'EPERM') {
        process.stdout.write(
          'Your saved login was removed, but some browser files are still in use. Quit your AI app completely, then run npm run logout again.\n',
        );
        return 1;
      }
      throw err;
    }
    process.stdout.write('Blackboard session and dedicated browser profile removed from this machine.\n');
  }
  process.stdout.write(`Downloaded course files are kept in ${paths.downloadsDir}. Delete that folder to remove them too.\n`);
  return 0;
}

runCli(main);
