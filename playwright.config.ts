import { readFileSync } from 'node:fs';

import { defineConfig } from '@playwright/test';

/**
 * Browser tests against a running app — start `npm run dev:local` first.
 * Point APP elsewhere to drive a deployed instance.
 *
 * One worker, deliberately: every test drives the same backend, and the
 * suite's assertions are about ordering and row counts.
 */

// The frontend port is whatever Rayfin allocated for this checkout — read it
// rather than hardcode it, so a fork whose allocator picked differently does
// not start every test with connection-refused. `.env.local`'s VITE_PORT is
// what Vite will actually bind (strictPort); rayfin/.env holds the allocator's
// record but CLI rewrites can drop it; 5173 is the allocator's default.
const readPort = (file: string, pattern: RegExp) => {
  try {
    return readFileSync(file, 'utf8').match(pattern)?.[1];
  } catch {
    return undefined;
  }
};
const allocatedPort =
  readPort('.env.local', /^VITE_PORT=(\d+)$/m) ??
  readPort('rayfin/.env', /^RAYFIN_PUBLIC_FRONTEND_PORT=(\d+)$/m);

export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: process.env.APP ?? `http://localhost:${allocatedPort ?? 5173}`,
    viewport: { width: 1440, height: 900 },
    // A negative-UTC zone, on purpose: date-only values are UTC-anchored, and
    // an off-by-one-day rendering bug is invisible in UTC+ zones (this app
    // shipped one, found only by review). Running the whole suite west of
    // Greenwich makes that class of bug fail tests instead of users. A fixed
    // offset rather than a city: DST would flip the offset twice a year
    // (Etc/GMT+6 is UTC-6 — POSIX inverts the sign).
    timezoneId: 'Etc/GMT+6',
  },
  reporter: [['list']],
});
