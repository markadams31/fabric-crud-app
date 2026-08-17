# CLAUDE.md

A CRUD app template on Microsoft Fabric, built on the Rayfin SDK: TypeScript entity classes
become a SQL database, a GraphQL API and a hosted UI, with the same tables queryable downstream
via the database's SQL analytics endpoint. One codebase deploys several **instances** — separate
Fabric apps with their own tables. The two shipped instances are a sample, not the point.
It exists to be read and forked, so **size is a feature** — prefer deleting to adding, and make
every file earn its place.

## Read before writing Rayfin code

- `AGENTS.md` → `.agents/skills/rayfin/SKILL.md`, plus the `rayfin` MCP server in `.mcp.json`. The
  SDK docs are **version-locked to `node_modules`**, so they match the installed packages.
  Without MCP: `npx rayfin docs list | search "<topic>" | get --id <id>` from the project root.
  **Where that skill and this repo disagree, this repo wins.** It is vendored, marked
  `rayfin-managed`, and describes the SDK's default single-instance shape. Everything it says
  about decorators, the client and the CLI still applies; three claims do not:
  - *Layout.* It puts entities in `rayfin/data/` and registers them in `rayfin/data/schema.ts`.
    Neither path exists here — entities live in `instances/<instance>/src/` and register in
    that instance's `index.ts`.
  - *An entity with no permission decorator.* Its Security rule calls such entities
    "inaccessible". Its own Anti-Patterns section says the opposite, and the opposite is what
    was measured: it fails **open** — full CRUD for any signed-in user.
  - *Fabric SSO.* "Do not attempt it in local development" is true of *SSO* specifically, but
    reads as a ban on the whole localhost loop — which is supported, and is what `npm run dev`
    does (`docs/platform-constraints.md`, "Sign-in from localhost").
- **"Designs that already lost"** below — check it before proposing a pipeline or
  deployment change; the alternative may already have lost on evidence.
- `docs/platform-constraints.md` — what running this taught us that the docs do **not** say.
  Every claim there was measured, and every section is stamped with what it was measured
  against and its shelf life (architecture / preview state / incident). Two rules keep it
  useful: add new findings in that same shape (claim in bold, stamp, one piece of re-runnable
  evidence — never append loose notes), and check its **Corrected beliefs** section before
  trusting an inherited claim or re-deriving one; disproven claims move there, they are not
  deleted.
- `docs/auth-and-permissions.md` — the five-layer identity model, the ownership carve-outs,
  and the measured sharing matrix; read before touching permissions or sharing.
- `docs/instances-and-tables.md` — adding an app, adding a table, when to share one, bulk import.
- `README.md` — what this is, local setup, and the file map. Deployment moved to
  `docs/operations.md`.

## Commands

```sh
npm run check          # tsc -b + vitest run — the gate before any commit
npm test               # vitest run
npx vitest run -t "declares permissions"   # a single test by name
npm run e2e            # Playwright browser tests against a running dev:local
npm run e2e:install    # once: downloads Chromium; E2E_WRITES=1 opts into write tests
npm run seed           # idempotent sample rows for the ACTIVE instance, from its own seed.mjs (CI e2e depends on it)
npm run dev:local      # Docker backend + Vite   (needs Docker)
npm run local:db       # apply schema to the running local server; `-- --force` if destructive
npm run local:stop     # stop containers, keep data
npm run local:purge    # drop volumes — also deletes the dev@contoso.com fixture account
npm run dev            # DEPLOYS backend + schema (`rayfin up`, minus static) to the ACTIVE deployment, then Vite
npm run rayfin:db      # apply schema to the *ACTIVE Fabric deployment* (prints which first)
npm run up             # deploy backend + schema + UI
npm run build          # tsc -b + vite build (also what rayfin.yml calls, twice — see below)
npm run preview        # serve the built bundle: the only way to LOOK at build-only defects
node scripts/check-bundle.mjs   # after a build: assert entity names survived minification
```

`rayfin.yml` names `npm run build` for **both** `services.data.buildCommand` and
`staticHosting.buildCommand`, and they are different builds: the data one runs with the
instance package as its working directory, so it builds that package's `tsc -b`; the static
one runs at the project root and builds the app. The CLI strips comments from `rayfin.yml`,
so the explanation has to live here.

`npm run dev:local` is not always a full start. If the backend already answers on the port in
`rayfin/.env` it skips `rayfin dev` (~3s), and applies the schema only when the active instance's
entities, `packages/shared` or `rayfin.yml` are newer than
`rayfin/.temp/local-apply.<instance>.stamp` — the script's own record of the last apply that
reached the *local* server (`dab-config.json` cannot serve: remote applies regenerate it too).
The stamp is per instance because each instance is a different `id`, so Compose gives it its own
containers and its own database. Do not delete the stamp casually.

`npm run check` is not a formality: `src/instances.test.ts` needs no backend, runs over **every**
instance rather than the active one, and guards the mistakes that otherwise fail silently at
runtime or in production. Set `RAYFIN_INSTANCE` on any command to work on a different instance —
the loop is otherwise unchanged.

**UI changes are expected to be verified in a real browser** against `npm run dev:local`, including
unhappy paths — most defects found here were invisible to the type checker and the tests.

**Anything touching entity metadata also needs `npm run build && npm run preview`.** The dev
server and the production bundle compile decorators differently, and one defect was visible
only in the build: minification renamed entity classes, so every lookup column degraded to a
raw UUID while `dev:local` and the whole e2e suite stayed green. `scripts/check-bundle.mjs`
now fails CI on exactly that regression, but it proves only that names survived — looking at
the built bundle in a browser is still the only way to see everything else.

## Architecture

One flow, and everything hangs off it:

```
instances/<instance>/src/*.ts  →  .../src/index.ts  →  src/entity.ts  →  src/db.ts  →  UI
  entity classes              the barrel          metadata →         all reads      renders from
  (decorators)                (the registry)      EntityView         and writes     EntityView alone
```

**One codebase, several apps.** An *instance* is a Fabric app: its own tables, its own Fabric item
and its own users. The **item** is the unit of separation — instances share the two environment
workspaces unless one is given its own, so a ten-instance estate is still two workspaces.
Everything instance-specific lives under `instances/<instance>/` and nothing
else knows an instance exists — deleting that directory deletes the instance. `RAYFIN_INSTANCE`
selects one (default `reference`); it is read by `instance.config.ts` for the UI and by
`rayfin.yml` for `id` and `services.data.path`, so the app and its database cannot disagree about
which instance is being worked on.

`packages/shared` holds the audit contract, which every instance and `src/db.ts` need. Entity
classes can be shared from there too — each instance then gets its own table with its own rows
— but the samples deliberately do not: two fully disjoint instances demonstrate the idea more
clearly, and the obvious shared table is the case where sharing is wrong.

- **`instances/<instance>/src/index.ts` is the registration point, and it exports twice on purpose.**
  Named class exports are what the Rayfin CLI collects (it scans a module's exports for
  `@entity()` classes; an exported **object** is invisible to it — which is why the old
  `schema.ts` never put a single table in a database). The `entities` object is what the frontend
  reads, as an object literal so keys stay literal types and `AppSchema`/`EntityName` are
  *derived*. `src/instances.test.ts` fails the build if the two drift.
- **Adding an instance is four files and one line** in the repo — `package.json`,
  `tsconfig.json`, `src/index.ts`, your entities, plus a `references` entry in the root
  `tsconfig.json` — and two `FABRIC_*_HOSTING_URL_<INSTANCE>` variables outside it. Full
  walkthrough in `docs/instances-and-tables.md`; the estate half is deliberate rather than
  incidental: instances share the two environment workspaces by default and only need their own
  when data must be separated structurally rather than by item-level sharing. The
  `FABRIC_*_WORKSPACE_ID_<INSTANCE>` override is a **grouping key, not a 1:1 escape hatch** —
  nothing requires the ids to be distinct, so several instances pointed at one id share a
  workspace apart from the default. Items must be created by the pipeline because schema apply
  is owner-gated.
- **`Audited()` is a mixin factory and the call is required.** A shared base *class* would give two
  entities the same metadata object and merge their schemas — one table's columns vanish into
  another's. `AUDIT_FIELDS` / `AUDIT_IMMUTABLE` declare the audit contract once.
- **`src/entity.ts` turns decorator metadata into `EntityView`/`FieldView`** — labels, columns,
  editable fields, foreign-key lookups, ordering, `describeRow` (how a lookup reads to a
  person), and the filters. `searchFilter()` OR-s `contains` across an entity's own text and
  enum fields; `facets()` offers closed sets as checkboxes — enums, booleans, and foreign keys
  by their **FK column**, which needs no relationship traversal — and `rangeFacets()` offers
  ordered columns, dates and numbers, as `gte`/`lte` bounds. Validation lives in
  `validate.ts`, display formatting in `columns.ts`.
- **`src/db.ts` is the only data access.** Writes stamp the audit columns from the session, because
  the platform has no server-side "now" or "current user". It owns `PAGE_SIZE`/`MAX_ROWS`, cursor
  paging (`page(fields, request)`, whose `where`/`order` must stay identical across a cursor walk), and full
  fetches (`all()`, used for lookups). `dynamic(name)` is the single, documented type-widening
  point — keep casts out of the UI. `src/db.contract.ts` is compile-time-only `@ts-expect-error`
  proof that the typed API refuses forged audit columns and ids; `npm run check` executes it.
- **`src/validate.ts` turns typed strings into entity values** — coercion (boolean spellings, enum
  canonicalisation), the strict ISO-date and decimal-scale gates, and validator messages rewritten
  for people. Shared by the form and the importer so a CSV cell cannot pass or fail differently
  from the same value typed into the form.
- **The app draws chrome only when nothing else does.** Embedded, the Fabric portal supplies the
  app bar, nav rail, breadcrumbs and page ground, so `App.tsx` renders none of its own and the
  grid card stays deliberately flat to match. Standalone that host is gone, and the same
  flatness reads as unstyled — so `isEmbedded` also gates an app bar, a `ground` background and
  a `surface` card. The ground is what fixes the empty space beside a `fit-content` table:
  capping the page width to centre it is a design that already lost, below.
- **UI:** `App.tsx` is the shell (theme, live session subscription, tabs); `EntityPage.tsx` owns one
  entity's grid, search and dialog state; `src/columns.ts` is the pure display code (content-fitted
  column widths, cell text, provenance labels, value formatting); the three dialogs each get a file
  (`RowDialog`, `DeleteDialog`, `ImportDialog`) and share one in-flight doctrine: primary button
  ref-guarded but never disabled while focused, dismissal blocked during a write, Cancel disabled to
  say so. `Field.tsx` picks one input from a field's constraints. Fluent UI React v9, styled with
  `makeStyles` + design tokens.
- **Filtering is per column, from its header** — the affordance enterprise tables use, and it
  scales where one stacked panel does not. `ColumnFilter` renders into the header cell's
  `aside` slot **beside Fluent's resize handle**, never instead of it: taking that slot removes
  the handle and dragging silently stops working.
- **Browser tests in `e2e/`** cover what tsc cannot: pagination, the tab-switch and search races,
  dialog guardrails. Read-only by default; tabs are addressed by index with skip guards for
  smaller registries; the import-gate tests, the sort-affordance canary and the
  `E2E_WRITES` tests pin the sample schema (Currency's CSV and form shape, Country's lookup
  column). `E2E_WRITES=1` adds two self-cleaning write round-trips: form
  create/duplicate/edit/delete, and a bulk import with an update-and-skip pass. The suite runs
  against any instance — tests needing a shape the schema lacks skip rather than fail.
- **The pipeline is two files and the split is load-bearing.** `deploy.yml` lists the
  `instances/` directories and fans out; `deploy-instance.yml` is the seven-job pipeline and
  runs once per instance. A *reusable workflow* rather than `strategy: matrix` on each job,
  because `needs` between matrix legs waits for every leg — one instance's failed Test deploy
  would then block another's Prod deploy. Freeze, baseline, concurrency and workspaces are all
  per instance. `RAYFIN_INSTANCE` reaches the CLI through the **shell**, never `--env-file`.
- **Platform limits that shape the design:** exactly two roles, `anonymous` and
  `authenticated` — application roles cannot ride on `claims.role` — and every table lands
  in one flat `dbo` schema.

Entities use **TC39 Stage 3 decorators** via `Symbol.metadata`. `tsconfig.json` must keep
`"lib": [… "ESNext.Decorators"]` and `useDefineForClassFields: true`; switching to
`experimentalDecorators` produces TS1238/TS1240 on every entity.

**The hard rule: runtime UI code names no entity, field, column or validation rule.** Everything is
derived from decorator metadata, so the frontend works against any Rayfin backend. A literal entity
or field name in `src/` executable code is a bug; comments may illustrate with the sample schema,
and the tests and `db.contract.ts` are exempt — they deliberately pin the sample schema.

**Stale responses are TanStack Query's problem, not hand-rolled guards'.** The one deliberate
library concession: `EntityPage.tsx` keys `useInfiniteQuery` on `['rows', entity, where, order]`
and lookups on `['lookups', entity]`, so a slow response lands in the cache entry it was asked
for; saves call `queryClient.invalidateQueries()` so cross-entity lookup lists refresh too; the
`key={view.name}` remount resets only UI state (search text, dialogs, measured widths). Three
generations of hand-rolled guards (request ids, a keyed remount, then a walk counter) each
shipped a real race before this design — do not reintroduce manual fetch state.

## Things that fail silently

These cost real time. `npm run check` catches the five marked ✓ — over **every** instance, not
just the active one. The one marked ✓ᶜⁱ needs a production build, so CI catches it — in the PR
gate and again before Prod — and `npm run check` never will. The rest are on you.

| | |
|---|---|
| ✓ `@text()` without `max` | Becomes `NVARCHAR(MAX)`. Deploys fine, then every request fails. |
| ✓ No permission decorator | Fails **open** — full CRUD for any signed-in user. |
| ✓ `@decimal()` without `scale` | Defaults to scale 2 and truncates on write. 0.001 stores as 0.00. |
| `.execute()` | Returns one page and never says more exist. Use `.first(n).executePaginated()`, then `.after(endCursor)`. |
| Adding a required column to a live table | Backfills `''`, `0` and `0001-01-01` with no warning and no `--force`. |
| Narrowing `@decimal` scale on a live table | Applies with no warning and rounds every stored value — `999999.999` became `1000000.0`. |
| `rayfin up` | Rewrites `rayfin.yml` and strips every comment. Keep reasoning in `docs/`, and keep deployment URLs in `rayfin/.env` via `${VAR:-default}`. |
| `rayfin up` (schema leg) | Exits **0** even when the schema apply fails, and the endpoint is **owner-gated**: only the item's creator can apply schema. `rayfin up db apply` is the honest-exit form. |
| ✓ A new instance without a `tsconfig.json` reference | Invisible to `tsc`; `npm run check` stays green while it has type errors. TypeScript has no glob for project references, so `src/instances.test.ts` asserts the entry exists. |
| ✓ An instance barrel exporting only the `entities` object | The CLI collects **classes and arrays**, never objects — the tables silently never deploy. Export both; the tests pin it. |
| `rayfin up ... --env-file` (schema leg) | The flag targets the deployment but never reaches `rayfin.yml` interpolation (`up-db.js` calls `loadRayfinConfig` without it), so the **wrong instance's schema** is generated for the right item. Pass `RAYFIN_INSTANCE` in the **shell**. |
| ✓ᶜⁱ An entity class reaching the UI through a tsc-built `dist` | Its class name — which IS its entity name — is minified away, so every lookup column degrades to a raw UUID. **Production build only**; dev and e2e are clean. The `@app/shared` source alias and `esbuild.keepNames` prevent it; `scripts/check-bundle.mjs` is what *catches* it, run by the `bundle` PR job and again in the Test deploy — nothing in `npm run check` reads a bundle. |
| `out=$(cmd); code=$?` in a workflow step | GitHub's `bash -e` shell eats the exit code at the assignment. Capture with `\|\| code=$?`. |
| An assertion chained with `&&` in a workflow step | A failure inside an `A && B` list counts as "checked", so the step never fails. The Prod smoke content check shipped unenforced until a rehearsal caught it. |
| Deleting a workspace to free its SQL databases | It does not. They stay `state=Active` against the capacity, invisible to every normal item listing, and keep consuming the quota. Ten accumulated this way and every new deploy then failed to provision a database. Only `admin/items?type=SQLDatabase` shows them; recovery is restore the workspace, delete the database, delete the workspace again (`docs/platform-constraints.md`). |
| A capacity at its SQL-database limit | Fabric refuses cleanly with `SqlDatabasePerCapacityLimitReached`, but `rayfin up` reports a generic `500 Internal Server Error` on runtime settings — so it reads as a platform fault, not a quota. Create a `SQLDatabase` item directly to see the real error. |
| A second instance deployed into a workspace that already has one | `.deployments.json` is keyed by **workspace**, and `rayfin up` resolves the target *item* from it — so the deploy silently retargets the first instance's item. **Local only** — every CI job is a fresh checkout. Remove the record, or work on one instance at a time. |

The ownership gate means deployed schema belongs to the pipeline: a human's `npm run dev` /
`rayfin:db` against a pipeline-owned item updates settings and static but silently skips
schema (docs/operations.md).

## Designs that already lost

Do not re-propose these without new evidence. Measurements behind them are in
`docs/platform-constraints.md`; the pipeline ones are rehearsed in `docs/operations.md`.

| Rejected | Because |
|---|---|
| Tag-triggered Prod deploys | Environment gates are the convention and give the same control; tags added ritual. |
| A schema-diff guard classifying changes safe/destructive | Fragile duplication of platform logic. The only honest signals are the git path diff and the CLI's own refusal. |
| A pre-deploy CSV export of every table | Adds nothing over the restore point plus the approval diff, except corruption noticed after 7 days. Residual risk accepted. |
| Per-environment origins as literals in `rayfin.yml` | Leaked this repo's origins into every fork, and put a comment in the one file `rayfin up` strips. Repo variables instead; shell env beats `rayfin/.env`. |
| A nested `rayfin/data/` barrel per instance (CLI "Strategy 2") | The CLI's own source prefers package `exports`; Strategy 2 forces `../../../../` imports and a tsconfig per instance. |
| Keeping `rayfin/data/` alongside `instances/` | Two places an entity could live is the ambiguity a reference implementation must not ship. |
| Decoupling the item id from the instance name | Lets the two disagree, and a deploy then targets the wrong item. One variable drives UI, schema path and id. |
| `strategy: matrix` on each pipeline job | `needs` waits for every matrix leg, so one instance's failed Test deploy would block another's Prod deploy. |
| A global deploy freeze | A failed migration's blast radius is one database. Freezing every domain destroys the benefit a shared codebase exists to give. |
| Demonstrating a shared entity class in the samples | It works and is documented, but the obvious example (a shared `Currency` list) is the case where sharing is *wrong* — that wants one owning instance and a connector. |

**Deliberate non-goals.** No load or scale testing: everything is measured at reference-data
scale, and grid behaviour at 10k+ rows, migration duration and CU burn are unknown by choice.
No separate application-security pass: the posture rests on the platform's model, documented
in `docs/auth-and-permissions.md`.

## Settled policy

Not rejected alternatives but decided questions — the ones that keep being reopened. The
measured evidence and the runbooks are in `docs/operations.md`.

- **The pipeline is the only *routine* path to Prod — not the only path.** The absolute form,
  "no human ever touches Prod", could not survive its own exceptions: a PITR restore is
  portal-only, and a broken pipeline cannot repair itself. One named break-glass Admin exists
  for exactly those, under the rules in
  [`docs/operations.md`](docs/operations.md#break-glass).
- **Artifact retention stays at GitHub's 90-day default.** Only the newest bundle can ever be a
  rollback target, so a longer window buys nothing. A gap over 90 days between successful Prod
  deploys degrades rollback to the rebuild fallback; past that, the answer is roll-forward.
- **An AI agent may approve the schema gate, but only when told to.** Approving as the user is
  a deliberate, scoped permission, never a default. The command must also be **standalone**:
  permission rules prefix-match the whole command string, so `gh api -X POST …` with anything
  prepended is refused.

## When bumping the SDK

The pipeline's refusal handling is coupled to CLI output text (two independent markers in
`deploy-instance.yml`, not `deploy.yml` — that file only fans out over instances):
"force mode is not enabled", "would result in data loss", either alone matching. After any `@microsoft/rayfin-*` version bump, before trusting a deploy:

1. Probe the refusal wording locally: add a temp optional column to an entity, apply, then
   remove it and apply again — the refusal text must still match a marker (measured
   procedure in `docs/platform-constraints.md`, "Changing a live schema").
2. Re-check the local-Docker section of platform-constraints — it is stamped as the first
   thing to go stale — and the webservice image tag in `scripts/local.mjs`.
3. Run one destructive rehearsal through the pipeline (see the rehearsal record in
   `docs/operations.md`) before the bump reaches anything that matters.

## When bumping the frontend stack

The SDK is exact-pinned and has the checklist above; React, Vite, TypeScript and Fluent float
on `^`. A committed `package-lock.json` plus `npm ci` in every CI job means that drift is never
ambient — it only ever arrives inside a deliberate bump commit. So the bump is the moment to
check the things types and tests cannot see:

1. **`vite` / esbuild** — `esbuild.keepNames` is what preserves the class name that IS an
   entity name. `scripts/check-bundle.mjs` asserts it by looking for the static block
   `keepNames` emits (`this,"<Entity>")`); if esbuild ever changes that emit shape it fails loudly,
   which is the intended failure mode — re-derive the pattern from a real bundle rather than
   relaxing the check.
2. **`@fluentui/react-components`** — `EntityPage.tsx` uses `useDataGridContext_unstable`, and
   the `_unstable` suffix is the library saying it may change in a minor. Removal is a tsc
   error; a silent *shape* change is caught by the column-resize e2e test, which is the only
   thing proving the filter did not take the resize handle's slot. Do not delete that test.
3. **`typescript`** — entities rely on TC39 Stage 3 decorators and `Symbol.metadata`. A change
   in lowering shows up as empty metadata, which the entity tests catch.

Run `npm run check`, then the PR pipeline, then look at `npm run preview` in a browser — in
that order, because each catches what the previous one cannot.

## Local Docker backend

`scripts/local.mjs` wraps `rayfin dev`, which is hidden behind a feature flag and defaults to a
private image. Each thing it does is commented with the failure that motivated it — read it before
changing it.

- **The CLI's port allocator cannot be trusted while anything is connected.** It probes with
  `lsof -i`, which counts an editor's established connection as "port in use" — and VS Code holds
  one whenever the app is open in a tab. It then allocates 5169, publishes on 5168 anyway (Compose
  is started with no `--env-file`), and posts runtime settings to a port nothing listens on for
  ~174s: `Error: fetch failed`. This is why the script prefers `/healthcheck` over a port probe, and
  why the schema path uses `rayfin dev db apply` — it posts to the running server and allocates
  nothing. The refusal that remains fires only when the port is held *and* no healthy backend
  answers, which is a genuine conflict.
- **`rayfin up` and `rayfin dev` both write `rayfin/.env`**, and Vite reads env once at startup, so
  alternating them can silently point the app at the wrong backend.
- **Checkouts running the same instance share one local Docker stack** — the compose project
  is named from `rayfin.yml`'s `id:`, which carries `RAYFIN_INSTANCE` and not the directory. A
  second clone of the same instance adopts the first's containers *and database*: `seed` finds
  rows already there, `local:stop` stops the other checkout's backend under it, and
  `local:purge` deletes its data (all measured). Different instances get separate stacks — at
  ~1.4 GB each, so stop one before starting another.
