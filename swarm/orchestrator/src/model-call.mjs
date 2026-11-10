// Review model through a command the owner configures. The command reads the
// prompt on stdin, prints the reply on stdout, and gets `--model <id>` appended.
// Argument arrays only, no shell. Nothing here is called in CI.
import { spawn } from 'node:child_process';

export function commandModel(argv, { timeoutMs = 10 * 60_000, maxBytes = 1024 * 1024, spawnFn = spawn } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('review command must be a non-empty argument array');
  return ({ model, prompt }) => new Promise((resolve, reject) => {
    const child = spawnFn(argv[0], [...argv.slice(1), '--model', model], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let size = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`review command timed out after ${timeoutMs} ms`)); }, timeoutMs);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(new Error('review reply too large'));
        return;
      }
      out += chunk;
    });
    child.stderr.on('data', (chunk) => { if (err.length < 2000) err += chunk; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`review command exit ${code}: ${err.trim().slice(0, 300)}`));
    });
    child.stdin.end(prompt);
  });
}
