import { clearProfile, hasProfileData } from '../storage/session-store.js';
import { runCli } from './util.js';

/** Wipes the dedicated browser profile: the local logout. */
async function main(): Promise<number> {
  if (!(await hasProfileData())) {
    process.stdout.write('No stored Blackboard session to remove.\n');
    return 0;
  }
  await clearProfile();
  process.stdout.write('Blackboard session and dedicated browser profile removed from this machine.\n');
  return 0;
}

runCli(main);
