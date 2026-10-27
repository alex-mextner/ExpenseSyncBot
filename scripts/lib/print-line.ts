/** Writes one line to stdout, the way `process.stdout.write` is used by the other CLI scripts. */
export function printLine(line = ''): void {
  process.stdout.write(`${line}\n`);
}
