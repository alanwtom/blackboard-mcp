import { BlackboardError, maskSensitive } from '../blackboard/errors.js';

export function runCli(main: () => Promise<number>): void {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      if (err instanceof BlackboardError) {
        process.stderr.write(`${err.code}: ${err.message}\n`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`BLACKBOARD_REQUEST_FAILED: ${maskSensitive(msg)}\n`);
      }
      process.exit(1);
    });
}
