#!/usr/bin/env node
/**
 * Start the local Rayfin backend in Docker.
 *
 * The warm path skips the full `rayfin dev`: a healthy backend on the
 * recorded port means repair the env pointer if a deploy moved it, apply the
 * schema only if the local stamp says it is stale, refresh `.env.local`, and
 * hand over to Vite in seconds. Every path sets two environment variables and
 * patches the generated compose file; the cold path then lets `rayfin dev`
 * start the containers, apply the schema, and emit `.env.local`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const COMPOSE = 'rayfin/.temp/docker-compose.yml';

/**
 * Which instance this stack serves. Each instance is a different Fabric item
 * with a different `id`, so Compose gives it its own containers and its own
 * database — the local stack is per-instance too, and so is the stamp below.
 * A single shared stamp read as "fresh" straight after switching instances,
 * which is the silent-stale failure schemaStale() exists to prevent.
 */
const INSTANCE = process.env.RAYFIN_INSTANCE || 'reference';
const STAMP = `rayfin/.temp/local-apply.${INSTANCE}.stamp`;

const env = {
  ...process.env,

  // `rayfin dev` is hidden behind this flag — without it the command does not
  // even appear in `rayfin --help`, and nothing hints the local path exists.
  RAYFIN_FEATURE_FLAGS: 'docker-local-dev',

  // The CLI defaults to ghcr.io/microsoft/project-rayfin/webservice:cli-1.34.0,
  // which is private. Verified: even a GitHub account holding `read:packages`
  // and a successful `docker login ghcr.io` gets `permission_denied:
  // read_package`. Rayfin's own source calls this temporary — check with
  //   docker manifest inspect ghcr.io/microsoft/project-rayfin/webservice:cli-1.34.0
  // and delete this line once it succeeds. Until then the local server is
  // 1.33.0 against a 1.34.0 CLI.
  RAYFIN_WEBSERVICE_IMAGE_NAME: 'ghcr.io/microsoft/rayfin/webservice:cli-1.33.0',
};

const rayfin = (...args) => spawnSync('npx', ['rayfin', ...args], { stdio: 'inherit', env });

/**
 * Stop the Aspire dashboard from starting.
 *
 * It is optional observability, and its image ships no shell, so its compose
 * entry sets `healthcheck: disable: true`. Docker then reports its health as
 * `unknown` rather than as absent — and the CLI treats any service with a
 * health value as one to wait on, so it waits for a container that can never
 * report healthy. Measured: the run takes `--health-timeout` and then continues
 * anyway. 310s against the 300s default, 102s against the 90s passed below, 29s
 * with this rename in place.
 *
 * Renaming its profile means the CLI's always-on `telemetry` profile no longer
 * matches it. Run it yourself if you want it:
 *   docker compose -f rayfin/.temp/docker-compose.yml --profile telemetry-optin up -d aspire-dashboard
 */
function disableDashboard(text) {
  return text.replace(/(aspire-dashboard:[\s\S]*?profiles:\s*)\["telemetry"\]/, '$1["telemetry-optin"]');
}

/**
 * Replace the webservice health probe.
 *
 * As generated it is:
 *
 *   apt-get update && apt-get install -y curl && curl -f http://localhost:8080/healthcheck
 *
 * which downloads a package from the internet on *every* probe, against a 10s
 * timeout. Measured at 6s on a fast connection — so it passes here and hangs
 * forever on a slower one, because a probe that times out never succeeds and the
 * container never reports healthy. `rayfin dev` then waits at
 * "Waiting for services to be ready... (4/4 running)" indefinitely.
 *
 * The image ships bash, so the same HTTP check can be done with no network and
 * no install at all.
 */
function patchHealthcheck() {
  if (!existsSync(COMPOSE)) return false;
  const before = readFileSync(COMPOSE, 'utf8');
  // Already patched — the no-change warning below is for a CLI that reshaped
  // the file, not for the normal warm start against our own earlier patch.
  if (before.includes('/dev/tcp/127.0.0.1/8080')) return true;

  // `bash`, not CMD-SHELL: /dev/tcp is a bash feature and the image's /bin/sh
  // is dash, which fails with "Directory nonexistent".
  const probe =
    "exec 3<>/dev/tcp/127.0.0.1/8080 && printf 'GET /healthcheck HTTP/1.0\\r\\n\\r\\n' >&3 && head -1 <&3 | grep -q 200";
  // The two patches are independent — a CLI upgrade can reshape one block and
  // not the other, and each miss has its own distinct regression (indefinite
  // hang on slow networks vs the 310s dashboard wait). Warn per patch, or a
  // partial miss hides behind the other patch's success.
  const health = before.replace(
    /\[\s*"CMD-SHELL",\s*"apt-get update && apt-get install -y curl && curl -f http:\/\/localhost:8080\/healthcheck \|\| exit 1",?\s*\]/,
    `["CMD", "bash", "-c", ${JSON.stringify(probe)}]`
  );
  if (health === before) {
    console.warn('⚠️  Health-probe patch found nothing to patch — the CLI reshaped the compose file; cold starts may hang on slow networks.');
  }
  const after = disableDashboard(health);
  if (after === health) {
    console.warn('⚠️  Dashboard patch found nothing to patch — the CLI reshaped the compose file; expect the ~100s dashboard wait on cold starts.');
  }
  if (after === before) return false;

  writeFileSync(COMPOSE, after);
  console.log('🩹 Patched docker-compose.yml: fast health probe, dashboard off by default');
  return true;
}

/**
 * Refuse to start when anything else holds the webservice port.
 *
 * The CLI picks that port with `lsof -i :<port>` and records what it picked in
 * `rayfin/.env`. But it starts Compose with no `--env-file`, so Compose never
 * reads that file and always publishes the default written into the compose
 * file. The two agree only while the port looks free. Anything holding it — a
 * browser tab or an editor's port forward left in CLOSE_WAIT is enough, since
 * `lsof -i` matches connections and not just listeners — makes the CLI record
 * the next port up, and it then POSTs the project's runtime settings to a port
 * nothing listens on. That is 30 retries over about 174s ending in
 * `Failed to apply project runtime settings` and `Error: fetch failed`.
 *
 * As an ordinary user `lsof` cannot see Docker's own listeners, so an already
 * running stack never trips this — only a genuine outside conflict does.
 */
function portConflict() {
  const port = readFileSync(COMPOSE, 'utf8').match(/\$\{RAYFIN_WEBSERVICE_HTTP_PORT:-(\d+)\}/)?.[1];
  if (!port) return null;
  const probe = spawnSync('lsof', ['-i', `:${port}`], { encoding: 'utf8' });
  if (probe.error) {
    console.warn('⚠️  lsof is not available; skipping the port-conflict check.');
    return null;
  }
  const held = probe.stdout?.trim();
  return held ? { port, held } : null;
}

/**
 * True when the backend is already up and answering on the recorded port.
 *
 * In that case `rayfin dev` has nothing to do, and re-running it is exactly
 * what invites the port failures: its allocator and our guard below both
 * probe with `lsof -i`, which counts an editor's ESTABLISHED connection as
 * "port in use" — and VS Code holds one to the API whenever the app is open
 * in a tab, which is most of the time on a dev machine. Probing the
 * webservice's own /healthcheck instead answers the question that actually
 * matters — is the right backend listening on the recorded port? — and lets
 * this script hand over to Vite in about a second.
 *
 * A healthy backend with `rayfin/.env` pointing at a *deployed* backend is
 * repaired, not rejected. Three commands rewrite that file (`rayfin up`,
 * `rayfin env`, `rayfin up switch`), and environment switching makes the
 * rewrite routine rather than accidental. Left alone, that state serves the
 * app a silent sign-in screen and sends this script down the slow path,
 * where the port guard misfires on the editor's own connections. This
 * command's meaning is "develop against the local backend" — so when the
 * local backend is the thing answering, the pointer follows the command,
 * not the other way around.
 */
async function backendAlreadyUp() {
  if (!existsSync('rayfin/.env')) return false;
  const dotenv = readFileSync('rayfin/.env', 'utf8');
  const get = (name) => dotenv.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]?.trim();
  const port =
    get('RAYFIN_WEBSERVICE_HTTP_PORT') ??
    readFileSync(COMPOSE, 'utf8').match(/\$\{RAYFIN_WEBSERVICE_HTTP_PORT:-(\d+)\}/)?.[1];
  if (!port) return false;
  try {
    const res = await fetch(`http://localhost:${port}/healthcheck`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  const api = get('RAYFIN_PUBLIC_API_URL') ?? '';
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/.test(api)) repairEnvPointer(dotenv, port);
  return true;
}

/**
 * Point `rayfin/.env` back at the healthy local stack.
 *
 * The publishable key is deployment-specific too — after `up switch` the file
 * holds the other environment's key, and the local backend rejects it with
 * "The provided publishable key is invalid". The local key's home is the admin
 * database's project row, so read it from there; if that container is not
 * running yet, the URL alone still fixes sign-in for the common case.
 */
function repairEnvPointer(dotenv, port) {
  // Find the admin database of *this* stack, not any stack: name substrings
  // match every checkout on the machine (a second clone's -admin-db-1
  // included), and another project's key would reproduce the exact failure
  // this repair exists to fix. The compose project that publishes our healthy
  // port is ours by construction.
  const project = spawnSync(
    'docker',
    ['ps', '--filter', `publish=${port}`, '--format', '{{.Label "com.docker.compose.project"}}'],
    { encoding: 'utf8' }
  ).stdout?.trim().split('\n')[0];
  const admin = project
    ? spawnSync(
        'docker',
        ['ps', '--filter', `label=com.docker.compose.project=${project}`,
          '--filter', 'label=com.docker.compose.service=admin-db', '--format', '{{.Names}}'],
        { encoding: 'utf8' }
      ).stdout?.trim().split('\n')[0]
    : '';
  const pk = admin
    ? spawnSync(
        'docker',
        ['exec', admin, 'psql', '-U', 'postgres', '-d', 'RayfinDB', '-t', '-A', '-c',
          'SELECT "PublishableKey" FROM "Projects" LIMIT 1'],
        { encoding: 'utf8' }
      ).stdout?.trim()
    : '';
  let next = dotenv.replace(
    /^RAYFIN_PUBLIC_API_URL=.*$/m,
    `RAYFIN_PUBLIC_API_URL=http://localhost:${port}`
  );
  if (pk) {
    next = next.replace(/^RAYFIN_PUBLIC_PUBLISHABLE_KEY=.*$/m, `RAYFIN_PUBLIC_PUBLISHABLE_KEY=${pk}`);
  }
  writeFileSync('rayfin/.env', next);
  console.log(
    '✅ rayfin/.env pointed at a deployed backend (a deploy or `up switch` rewrote it) — repointed to the healthy local stack.'
  );
}

/**
 * True when an entity file or `rayfin.yml` is newer than the last generated
 * DAB config — i.e. `db apply` has something to do.
 *
 * Every apply rewrites `rayfin/.temp/dab-config.json`, so its mtime marks the
 * last time the schema reached the server. Without this check the fast path
 * below would be the silent failure this repo's docs warn about: add a column,
 * see "backend already running", and every query against it fails with no
 * hint the DDL never ran. Test files are excluded — they never reach codegen.
 */
function schemaStale() {
  // The stamp is this script's own record of the last apply that reached the
  // LOCAL server. `dab-config.json`'s mtime cannot serve: `rayfin up db apply`
  // regenerates the same file while targeting a *deployed* backend, so after
  // "edit entity → rayfin:db → dev:local" it reads as fresh while the local
  // schema is stale — precisely the silent failure this check exists to stop.
  // The dab-config fallback covers checkouts from before the stamp existed.
  const marker = existsSync(STAMP) ? STAMP : 'rayfin/.temp/dab-config.json';
  if (!existsSync(marker)) return true;
  const applied = statSync(marker).mtimeMs;
  // The active instance's own entities AND the shared package: an edit to a
  // shared class changes this instance's tables just as much as one to its own.
  const sources = [
    'rayfin/rayfin.yml',
    ...[`instances/${INSTANCE}/src`, 'packages/shared/src'].flatMap((dir) =>
      existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
            .map((f) => `${dir}/${f}`)
        : []
    ),
  ];
  return sources.some((f) => existsSync(f) && statSync(f).mtimeMs > applied);
}

/** Record that the LOCAL server has the current schema — see schemaStale. */
function stampLocalApply() {
  if (!existsSync('rayfin/.temp')) mkdirSync('rayfin/.temp', { recursive: true });
  writeFileSync(STAMP, new Date().toISOString());
}

// The CLI writes the compose file only when it is missing or stale, and `--down`
// writes it without starting anything — so a fresh clone gets it patched before
// the first container ever runs.
if (!existsSync(COMPOSE)) rayfin('dev', '--down');
patchHealthcheck();

const args = process.argv.slice(2);

// A plain start against a healthy stack: apply the schema only if it changed
// (`db apply` posts to the running server — no port allocation, so editor
// connections cannot trip it), refresh .env.local, and hand over to Vite.
if (args.length === 0 && (await backendAlreadyUp())) {
  if (schemaStale()) {
    console.log('✅ Backend already running — applying schema changes, skipping full `rayfin dev`.');
    const apply = rayfin('dev', 'db', 'apply');
    // A refusal here is meaningful (e.g. a destructive change needs --force:
    // `npm run local:db -- --force`) — stop so it can be read. Forcing must go
    // through `local:db`: npm appends `--`-forwarded args to the END of a
    // compound script, so `npm run dev:local -- db apply --force` hands the
    // args to vite, not to this script.
    if (apply.status) process.exit(apply.status);
    stampLocalApply();
  } else {
    console.log('✅ Backend already running, schema unchanged — skipping `rayfin dev`.');
  }
  rayfin('env', '--framework', 'vite');
  process.exit(0);
}

// Only starting the stack allocates a port — teardown and `db` subcommands
// (API calls against the running server) are never blocked by one.
const startsStack = !args.some((a) => ['--down', '--stop', '--purge'].includes(a)) && args[0] !== 'db';
const conflict = startsStack ? portConflict() : null;
if (conflict) {
  // Reaching here means the backend did NOT answer its healthcheck (a healthy
  // stack skips `rayfin dev` above), yet something holds its port — a dead
  // server's lingering connections, or another process squatting on it.
  console.error(`\n❌ Port ${conflict.port} is held, but no healthy backend answered on it.`);
  console.error('   `rayfin dev` would spend ~3 minutes applying runtime settings to the');
  console.error('   wrong port and fail with "fetch failed", so stopping here instead.\n');
  console.error('   Close whatever holds the port (below), or reset the stack first —');
  console.error('   `npm run dev:local -- --stop` drops the connections along with the');
  console.error('   containers, and starting again then works.\n');
  console.error(conflict.held);
  process.exit(1);
}

// 300s was the CLI's own suggestion and is far longer than anything here needs.
const { status } = rayfin('dev', ...(args.length ? args : ['--health-timeout', '90']));
// A full `rayfin dev` and a `db` subcommand both apply the schema locally on
// success; teardown flags do not.
if (!status && (args.length === 0 || args[0] === 'db')) stampLocalApply();
process.exit(status ?? 1);
