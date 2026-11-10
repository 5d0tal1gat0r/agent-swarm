// Opens a pull request with the host's gh login. Arguments go in an array (no shell).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function ghOpenPr({ cwd, branch, title, body, base = 'main' }) {
  const { stdout } = await run('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body], { cwd, maxBuffer: 1024 * 1024 });
  const match = stdout.trim().match(/\/pull\/(\d+)/);
  if (!match) throw new Error(`gh pr create printed no PR number: ${stdout.trim()}`);
  return Number(match[1]);
}
