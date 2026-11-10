// Local job history: enforces the daily job limit and the retry backoff.

import fs from 'node:fs';
import path from 'node:path';
import { jobKey } from './decide.mjs';

export const BACKOFF_MS = 2 * 3_600_000;

export class Ledger {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  entries() {
    if (!fs.existsSync(this.file)) return [];
    return fs
      .readFileSync(this.file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  record(job, ok, now = new Date()) {
    fs.appendFileSync(this.file, JSON.stringify({ at: now.toISOString(), key: jobKey(job), kind: job.kind, ok }) + '\n');
  }

  /** Agent jobs (build/review/fix) started since local midnight. */
  jobsToday(now = new Date()) {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return this.entries().filter((e) => ['build', 'review', 'fix'].includes(e.kind) && new Date(e.at) >= midnight).length;
  }

  /** Keys of jobs that failed within the backoff window. */
  recentFailures(now = new Date()) {
    return new Set(
      this.entries()
        .filter((e) => !e.ok && now.getTime() - new Date(e.at).getTime() < BACKOFF_MS)
        .map((e) => e.key),
    );
  }
}
