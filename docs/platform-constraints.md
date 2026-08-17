# Platform constraints, measured

What running this app taught us about Fabric Apps and the Rayfin SDK that the documentation
does not say. Every claim here was observed, not inferred; nothing repeats what the docs
already state.

**How to read this file.** Each section opens with a provenance line saying how far to trust
it:

- *Measured* — what the claims were observed against. The platform is a preview, so treat any
  claim as a hypothesis to re-verify once those versions move.
- *Shelf life* — what kind of fact it is: **architecture** means the behaviour follows from
  how the platform is built (no server-side code, a declarative schema diff, two roles) and
  should survive SDK releases; **preview state** means packaging, a bug, or an acknowledged
  gap of the current preview — exactly what a release fixes; **incident** means it happened
  once, the cause is open, and what is recorded is the recovery.

**Maintaining it.** Add findings the way they were made: state the claim in bold, stamp the
version and target, keep the one piece of evidence that lets a reader re-run the check. When a
claim dies, move its one-line corpse to [Corrected beliefs](#corrected-beliefs) instead of
deleting it — that section records claims this project once held that turned out false, kept
so nobody (human or model) re-derives them. Unless a claim says otherwise, everything here was
measured on 2026-08-15.

Sections, in rough order of how often they get consulted:

- [What the docs already say](#what-the-docs-already-say)
- [Modelling data](#modelling-data)
- [Changing a live schema](#changing-a-live-schema)
- [The local Docker stack](#the-local-docker-stack)
- [Sign-in from localhost](#sign-in-from-localhost)
- [Deploying](#deploying)
- [Several apps from one codebase](#several-apps-from-one-codebase)
- [Identity and permissions](#identity-and-permissions)
- [The data downstream](#the-data-downstream)
- [Incidents](#incidents)
- [Corrected beliefs](#corrected-beliefs)
- [Still untested](#still-untested)

## What the docs already say

Two documentation sets exist; this file repeats neither. The **Fabric Apps platform docs**
(<https://learn.microsoft.com/fabric/apps/>) define the permissions model, pricing and the
deployment boundary. The **Rayfin SDK docs** ship version-locked inside `node_modules`
(`npx rayfin docs list`, or the `rayfin` MCP server); read `known-limitations.md` and
`permissions.md` before touching an entity. Between them they already cover: two roles only,
`policy:` row filters, no `count()`, no many-to-many, `.execute()` returning one silent page,
`@text()` without `max` breaking every request, and the `{property}_id` foreign-key
convention.

## Modelling data

*Measured: CLI 1.34.0, local + Fabric. Shelf life: architecture.*

**One flat `dbo` schema, and a validation rule enforces it.** Any qualified entity name is
rejected (*"Entity name 'finance.Rate' contains a '.' — only the default database schema is
supported"*). Grouping has to come from somewhere else, and only one option also separates
access:

| Approach | Cost |
|---|---|
| Prefix the entity name (`FinanceCostCentre`) | Ugly, and downstream consumers see it |
| Group only in the UI | Presentation-layer grouping needs its own source of truth |
| One app per workspace | Real separation, including permissions, at a deployment each |

**Column defaults are real but constant-only; there is no server-side "now" or "current
user".** `{ default: value }` reaches SQL as a genuine `DEFAULT` constraint
(`default: (N'unknown')` observed), but the option's type is bound to the field's scalar, so
a SQL expression is a compile error (`@date({ default: 'SYSUTCDATETIME()' })` → TS2322). The
platform reserves the one expression default it needs for itself: `id` gets `(newid())`. With
no triggers and no deployable server code, the caller writes `createdAt/By` and `updatedAt/By`
on every write — audit values are attribution, not enforcement.

**Audit columns via inheritance work — but the base class must be a factory.** TC39 decorator
metadata inherits through the prototype chain, so decorated fields on a base class reach SQL.
The trap: entities sharing one base *class* share one metadata object, and a second entity's
registration merged its columns into the first's table. Silent schema corruption, invisible
until a second entity exists — which is why
[packages/shared/src/audit.ts](../packages/shared/src/audit.ts) is a factory returning a fresh
class per entity. Inherited fields order **before** the subclass's own in the generated
config — harmless, but know it before comparing schemas by eye.

**Field-level `exclude` is the finest real enforcement, and it protects updates only.** With
`@authenticated('update', { exclude: ['createdAt', 'createdBy'] })`, a hand-crafted mutation
touching an excluded field is refused whole (`"Unauthorized due to one or more fields"`, row
unchanged — verified against a real token). Creates cannot be protected this way, since the
app must write all four columns then; a row's *origin* is assertable by its creator, immutable
afterwards.

**Updates are partial: omitted columns are preserved, not nulled.** Verified by updating a row
while sending only three fields — `createdAt`/`createdBy` came through untouched. Plenty of
APIs treat missing as null; this one does not.

**Concurrent writes: last write wins per column, no optimistic concurrency** (measured with
two sessions racing one row on the local backend). A write based on a stale read is accepted
without complaint — no version check, no ETag, no conflict error, and same-field races
silently lose the earlier write. Because updates are partial, stale writes to *different*
columns of the same row **merge** rather than clobber: the data-loss window is per field, not
per row. An update to a deleted row fails with a clean "Could not find item" error, not a
silent no-op. That per-column merge is only available to an app that *sends* one column, so
this template's form submits the fields the user actually changed and two people editing
different columns of a row both keep their work; a form posting every field it holds would
silently overwrite the other's, whatever the platform allows. Detecting a genuine same-field
conflict remains the app's own job (e.g. compare `updatedAt` before writing); this template
does not.

**`@decimal()` without `scale` is `decimal(18,2)` and silently rounds.** The decorator accepts
the value, the API accepts the write, and the number is quietly truncated on the way in — a
unit-conversion table stored `0.001` three times as `0.00`. Give `precision` and `scale`
together; maximum precision is 28 (a Data API Builder limit, not SQL Server's).

**Table shapes beyond simple scalars have sharp edges.** Probed with temporary entities on the
local stack — re-verify against Fabric before relying on these:

- **A self-referential `@one` stores but cannot be traversed.** `parent_id` writes fine, but
  any dotted select touching it fails with *"Could not find relationship between self-joined
  entity"*. Hierarchies store and resolve client-side only.
- **Two `@one` relationships to the same target silently break both** —
  `select(['team.name'])` returns `team: null` for every row, no error, while the FK columns
  hold correct values. The failure mode is missing data, not a message.
- **`findById` returns only `{ id }`** despite its declared return type. Treat it as an
  existence check, or use `select(...).where({ id: { eq } })`.
- **`@many` dotted selects work**, and cursor pagination without `orderBy` produced distinct
  pages — though nothing guarantees stability at scale without one.
- **SQL reserved words are fine as column names** (`order`, `group` in create, `where`,
  `orderBy`).
- **A `RayfinClient` in a Node script never lets the process exit** — auth refresh timers
  hold the event loop even with `authStorage: false`. End scripts with `process.exit(0)`, or
  use `RayfinServerClient`, which has no auth module.

This template's UI is immune to both relationship bugs by design: it never uses dotted selects,
resolving FK columns against client-side lookup lists instead.

**`dbo.Users` exists in every project database, stays empty, and is not yours.** No entity
declares it, it never populated on Fabric or locally, and the real identity store is the
control-plane Postgres (`RayfinDB."Users"`). Read `Users` as a taken entity name, not as a
roster of who has used the app.

## Changing a live schema

*Measured: full lifecycle matrix against a seeded probe table, CLI 1.34.0, local server
cli-1.33.0, then re-run in full against a deployed Fabric database — identical behaviour in
every bucket, so the contract below is the platform's, not the local emulation's. Every CLI
claim corroborated against `sys.columns` and the rows themselves. Shelf life: architecture —
the diff is computed server-side from the submitted DAB config, so expect refinement, not
reversal.*

There are no migration files. Each apply submits the whole config; the server computes the
diff, runs it transactionally — a two-column apply that failed on one column left both
untouched — and increments a config version (`{"version":29,...}`). No down-migration exists,
and no data backfill can ride along with a schema change. Every change lands in one of three
buckets — silent apply, refusal naming the reason (the data-loss class is overridable with
`--force`, constraint violations are not), or a bare 500:

**1. Applies silently — sometimes rewriting stored data.** No flag, no prompt, no mention
that rows changed:

| Change | What happened to the data |
|---|---|
| Column added, optional | NULLs, as expected |
| Column added, required | Backfilled per type: text `''`, int `0`, bit `0`, datetime2 `0001-01-01` |
| Optional → required with a NULL stored | Applied; the NULL rewritten to `''` |
| Type change, convertible data (`int` → `text`) | Converted in place, values preserved |
| Text `max` widened; decimal precision widened | In place, nothing touched |
| Decimal scale narrowed (3 → 1) | **Applied and rounded every stored value**: `0.123` → `0.1`, `999999.999` → `1000000.0` — that last one changed the integer part |

If the platform can make the schema true by rewriting rows, it will, and nothing tells you it
did. The required-column case is the one that bites audit retrofits: adding the four audit
columns to a live table gives every pre-existing row empty-string attribution and a min-date
timestamp — an audit trail that looks populated and is uniformly false. The defaults persist
on the columns, so later inserts omitting them also succeed silently. If you must retrofit,
backfill deliberately and grep for `''` and `0001-01-01` afterwards; a constant default like
`new Date('1900-01-01')` at least makes the sentinel obviously a marker.

**2. Refused with the real reason (HTTP 400).** Constraint-violating changes run `WITH
CHECK`, so the server catches them, names them, and applies nothing: text narrowed below a
stored value (*"String or binary data would be truncated … column 'name'"*); `unique: true`
over duplicates (names the offending value); an enum value removed while a row stores it.
`--force` does not override the enum case — the replacement CHECK is always applied
`WITH CHECK`, so an in-use enum value is unremovable until the rows are migrated by hand.
Measured from CI against deployed Prod, the exact wording is
*"Migration failed due to a database constraint violation. Reason: The ALTER TABLE
statement conflicted with the CHECK constraint …"* — a third refusal wording, sharing no
marker with the data-loss class, which is why the pipeline's schema step routes anything
unrecognised to a loud failure instead of guessing.

**3. Refused as a bare 500, reason hidden.** A type change the data cannot convert
(`text` → `int` over `'Duplicate'`) returns *"500 Internal Server Error"*; the reason (SQL
error 245, *"Conversion failed converting the nvarchar value 'Duplicate'"*) surfaces only in
the webservice container's logs — `docker logs fabric-app-<instance>-webservice-1` (container
names derive from `rayfin.yml`'s `id:`).

**The data-loss guard is structural, and its message cannot be trusted either way.** Renames
are detected as renames (*"Performing Rename column 'note' to 'remark' … would result in data
loss"*), demand `--force`, then preserve every value — a true rename, not drop-and-add.
Dropping a column or table demands the same flag under the same wording and loses everything.
The guard refuses to drop a column from a table with **zero rows**, in that same sentence — it
never looks at data. Re-registering a dropped table's name creates a fresh empty table;
nothing lingers. Rename-plus-retype in one step was not probed.

**A successful apply is opaque: the output never says what it did.** On the local server
(probe column on `UnitOfMeasure`), a no-change apply, an additive column, and a
silent-bucket scale-narrowing all produce byte-identical success output: the server response
is only `{version, updatedAt}`, and `version` increments on every POST (38→39 on two
identical configs), a revision counter rather than a change signal. Only the refusal is
observable — exit code 1, the 400's operation text. Change detection must therefore come from
git (did the instance's entities, `packages/shared` or `rayfin.yml` change?), not from the
CLI. Nor can a preview stand in: `rayfin up -n/--dry-run` previews "without making API calls"
(help text) — it cannot show the server-computed migration plan.

**`--json` swallows the refusal reason.** The same forced-refusal run that prints
*"Performing Drop column … would result in data loss but force mode is not enabled"* in
plain mode exits 1 with **no error text at all** under `--json` — output stops after
"Applying configuration…". A pipeline must capture the plain-mode output to surface the
refusal; the machine-readable flag hides exactly the message automation needs (measured on
the local server).

## The local Docker stack

*Measured: CLI 1.34.0 with local server image cli-1.33.0. Shelf life: preview
state, all of it — this is the section to re-verify first after any SDK upgrade. The
mitigations live in [scripts/local.mjs](../scripts/local.mjs), where each workaround is
commented with the failure behind it; this section records the platform side.*

**The local stack is per `id:`, not per checkout — and `id:` now varies per instance.**
The compose project is named from `rayfin.yml`'s `id:`, not the directory, so two checkouts
of the *same instance* silently share containers, volumes and data: a fresh clone can come
up already populated, its schema applies hit the shared database, and its
`local:purge` **deletes the other checkout's data** (measured in the fresh-clone
walkthrough, when `id:` was a constant). Because `id:` interpolates `RAYFIN_INSTANCE`, two
*different* instances get separate stacks — also why the apply stamp is per instance — but
separate is not free: each stack measured ~1.4 GB (SQL Server 1.05 GB, webservice 338 MB,
admin db 33 MB). Stop one before starting another.

**`rayfin dev` is feature-flagged and barely documented** — hidden behind
`RAYFIN_FEATURE_FLAGS=docker-local-dev`, with a single guide page in the SDK doc set
(`preview/local-dev-docker.md`) and no CLI-reference entry.

**The default webservice image is private; the public mirror is the only route.** The CLI
pulls `ghcr.io/microsoft/project-rayfin/webservice`. Anonymous pull gets 401, and a real
outside account with `read:packages` gets `permission_denied`, so the documented GitHub-CLI
route cannot work outside Microsoft as shipped. The CLI's own source carries a TODO to
resolve the digest from the public registry "once the repo/package is public" —
acknowledged, and temporary. To check whether that has landed, run
`docker manifest inspect ghcr.io/microsoft/project-rayfin/webservice:cli-1.34.0`; if it
succeeds, delete `RAYFIN_WEBSERVICE_IMAGE_NAME` from `scripts/local.mjs`. The public mirror
also pulls anonymously from GitHub Actions runners (measured), which is what makes PR-stage
e2e against the local stack viable in CI. The private default stays private.

**The resulting version skew — local server 1.33.0 under a 1.34.0 CLI — is not worth
removing.** No observed problem is attributable to it, and pinning the CLI back to 1.33.0
would cost the newer CLI on both targets; one CLI serves local and Fabric alike.

**GraphQL variables are broken on the 1.33.0 image.** An input object passed as a GraphQL
*variable* fails to deserialise (`…must to be serialized as System.Object…`) and reaches
the client as `HTTP 200 {"errors":[{"message":"Internal server error"}]}`. Inline the same
input in the same mutation and it succeeds. The SDK's `GraphQLEntityClient` inlines, so the
app is unaffected; hand-written GraphQL is not. Possibly the skew rather than a real bug.

**A cold `rayfin dev` waits its full `--health-timeout` for a dashboard nothing needs.** The
Aspire dashboard's image ships no shell; its generated compose entry disables the
healthcheck; Docker reports its health as `unknown` — and the CLI's readiness filter counts
`unknown` as "has a health check", then waits for a state that never arrives. Cold start:
310 s at the default timeout, 16–29 s with the dashboard not started. The CLI's
"already running and healthy" reuse path never triggers either way (the always-on `telemetry`
profile fails its config-match), so every run re-allocates ports — which is what makes the
next item dangerous rather than theoretical.

**The port the CLI records is not the port Compose publishes.** Allocation probes with
`lsof -i` and writes the chosen port to `rayfin/.env`; Compose starts with no `--env-file`,
so it publishes the compose-file default regardless. When the two disagree, the
runtime-settings POST retries against a dead port for ~174 s and ends in `Error: fetch
failed`. The probe is unreliable in both directions: `lsof -i` counts an editor's ESTABLISHED
connection as "in use" — the normal state of a dev machine with the app open in a tab — and
cannot see Docker's root-owned listeners at all (verified: published ports read as free).
Recovery: free the port, or reset `RAYFIN_WEBSERVICE_HTTP_PORT` in `rayfin/.env` to the
compose default and re-run.

**`rayfin dev`, `rayfin up` and `rayfin env` all write `rayfin/.env`,** and Vite reads env
once at startup — see the env-flip incident below for what that does to a mixed session.

**`password.enabled: true` is required for local development.** It is how the *local* backend
authenticates the fixture account; disabling it as "Entra-only, so noise" leaves the local
project unconfigured and routes every apply nowhere. Every documented example enables it.

## Sign-in from localhost

*Measured: `npm run dev` against the deployed backend. Shelf life: architecture.*

**From localhost you get interactive Entra sign-in, not SSO — and the workflow is
supported.** Embedded in the portal, the host hands its session across by `postMessage` —
true SSO, no prompt. From localhost the SDK opens the portal as a broker and you
authenticate there, which is why spending the stored refresh token on load matters: without
it, every reload after token expiry prompts again. The shipped skill file's "Fabric SSO only
works inside the Fabric Portal" is correct about *SSO* but reads like a prohibition on the
whole workflow; the CLI reference and Microsoft's own template treat
localhost-against-deployed as the normal dev loop.

**The brokered sign-in needs a tenant hint the SDK does not supply.** The portal URL carries
no tenant parameter, so it resolves whichever Microsoft account the browser is already signed
into and fails with `HTTP Error 401 — Signed in as <the wrong account>`. That looks like an
app permissions problem, but the app was never reached. `fabricPortalUrl` preserves query
parameters, so pinning `ctid` fixes it; `portalUrlForTenant()` in
[src/rayfin.ts](../src/rayfin.ts) does exactly that.

## Deploying

*Measured: `rayfin up` against a real tenant, Australia East. Shelf life: mixed — the
rewrite behaviour is architecture; region support is preview state.*

**A personal workspace is enough.** "My workspace" with capacity hosted the item; one
`rayfin up`.

**`rayfin up` runs the DDL itself** — both tables carried the item's creation timestamp,
while later `db apply` calls only bumped the config version.

**`rayfin up` rewrites `rayfin.yml`, strips every comment, and appends the deployment's
hosting origin to `allowedRedirectUris`.** The file is regenerated from parsed values, so it
cannot document itself, and committing it as written puts one person's generated URL into a
repo others fork. `${VAR:-default}` interpolation, sourced from the gitignored `rayfin/.env`,
is the answer: the placeholder survives deploys — verified twice — and the CLI appends the
origin only when it is missing from the *resolved* list, which also proves resolution
happened. A fresh clone's first deploy appends a literal URL once; move the value into
`rayfin/.env` and delete the appended line — the placeholder itself survives.

**A CI checkout has no `rayfin/.env`, so the same interpolation flattens to its defaults**
(measured: the settings POST from CI carried only localhost in `allowedRedirectUris`). Fix it
with a per-job environment variable: shell env beats `rayfin/.env` in the CLI's resolution
order, so each deploy job injects `RAYFIN_HOSTING_URL` and every settings POST asserts its own
origin with nothing committed. The CLI also auto-appends the deployment's own hosting URL
after provisioning, so a missing variable self-heals for the item's own origin. Committing
origins as literals works too, but ships them into every fork's auth allow-list — rejected
(see "Designs that already lost" in CLAUDE.md).

**Schema apply is gated on item *ownership*, not workspace role** (measured from GitHub
Actions as a managed identity holding Contributor). The `applyconfig` endpoint returns
`403 — "Only AppBackend artifact owner can perform this operation"` for any identity that did
not create the item, while the same identity's runtime-settings POST returns 200 and static
deploy succeeds. Two consequences follow. The identity that will apply schema must be the
identity that *creates* the item — a pipeline adopting a human-created item cannot apply
schema until the pipeline identity recreates it. And once an item is pipeline-created, a
human's interactive `rayfin up` against it updates settings and static content but not schema;
the dev loop is local Docker by construction, not convention. The converse is also measured:
an item's creating identity applies schema cleanly (200) — the gate is ownership in both
directions.

**`rayfin up` exits 0 even when its schema apply fails** (measured in the same run).
The integrated database step printed "[rayfin up] Database apply failed: … 403 Forbidden"
plus a troubleshooting tip, retried five times, and the umbrella command still succeeded.
Automation must therefore run `rayfin up db apply` as its own step and gate on *that* exit
code; `rayfin up`'s own exit covers everything except the schema.

**`rayfin up status` reporting "Reachable — Warning: HTTP 404" is cosmetic.** Hand-probing
`/graphql` or `/health` 404s too; `RayfinClient` builds its own data-plane paths from the
base URL. Connect a real client before concluding anything from probes.

**Australia East works; there is no platform rollback** — to roll back, redeploy a previous
commit.

## Several apps from one codebase

*Measured: rayfin-cli 1.34.0, two instances deployed into one Fabric workspace and read back
through the SQL primary, 2026-08-16. Shelf life: preview state for the two CLI defects,
architecture for the rest.*

**Entity discovery reads a module's EXPORTS, never `schema.ts`.** The CLI takes one of two
routes: it imports the data package's `exports` entry, or it compiles `<dataRoot>/rayfin/` and
globs `.temp/compiled/data/*.js`. Either way it collects whatever `isRayfinEntity()` accepts,
and `collectEntities` takes a directly-exported class or an **array** of them — never an
exported **object**. A registry object therefore never put a table in a database; each entity
file's own `export class` did. Re-run: `node -e` over the built barrel, mirroring
`collectEntities`.

**`services.data.path` selects which entities deploy, and it works end to end.** Typed in
`@microsoft/rayfin-tools-common/dist/config/types.d.ts`; its sibling `buildCommand` builds the
package first. Two instances deployed from one checkout produced two databases — one with
`CostCentres, Countries, Currencies, UnitOfMeasures`, the other with `CostCodes, Currencies,
Invoices` — read from `INFORMATION_SCHEMA.TABLES` on each SQL primary.

**A shared entity class shares the shape, never the rows.** `Currency` re-exported by two
instances produced a `Currencies` table in each database, populated independently.

**`${VAR}` interpolation survives `rayfin up`'s rewrite, and substrings work.**
`interpolateString` is a global regex replace over every string value, so
`id: fabric-app-${RAYFIN_INSTANCE:-reference}` resolves. Read `rayfin/rayfin.yml` back after a
deploy: the `${…}` is still there. One coercion rule: a value is type-coerced only when the
*whole* string is one `${VAR}`, so the substring form cannot turn a numeric-looking id into a
number.

**`--env-file` does not reach `rayfin.yml` interpolation on the schema leg.**
`commands/up/up-db.js` calls `loadRayfinConfig(projectRoot, { silent: true })` with no
`envFile`, so the flag targets the deployment while interpolation falls back to `rayfin/.env`
plus the shell. Observed consequence: `rayfin up db apply --env-file <finance>` generated the
**default** instance's schema and applied it to the finance item, exit 0. Pass instance
selection in the **shell**. Env precedence is `.env` first, then shell overriding it
(`loadEnvironmentVariables`).

**`buildCommand` runs with cwd = the data package, not the project root.** `npm run build -w
packages/x` fails with "No workspaces found"; plain `npm run build` is correct.

**A second instance deployed into a workspace that already has one silently retargets the
first instance's item.** `upsertDeployment` keys `.deployments.json` by
`sanitizeWorkspaceName(workspaceName)`, and `rayfin up` resolves the target item from that
record; the `id` in `rayfin.yml` is consulted only when no record exists. Measured: deploying
instance B after instance A reported `Item: fabric-app-finance (494ee205…)` — the ID just
created for A — and tried to apply B's schema over A's tables. **The destructive-change refusal
was the only thing that prevented it**; compatible schemas would have merged two instances into
one database. Delete the stale record and the deploy creates the correct item. CI is naturally
safe (fresh checkouts have no registry); local repeat deploys are not.

This is a **local** hazard, not a reason to give every instance its own workspace — the
opposite of what this file first concluded. Deployed from fresh checkouts, two instances in one
workspace each create their own item by `id` and coexist correctly (measured: two apps with
disjoint tables in one workspace). What sharing a workspace costs is access control, not
deployment: workspace roles grant implied permissions on every item and a Viewer can read every
table over SQL, so per-app access has to come from sharing the app **item**.

**An entity's identity is its class NAME, so anything that renames classes rewires the schema —
and the two compilers disagree about how to keep it.** esbuild's decorator lowering writes the
name as a string literal (`ka(Lt,0,"Currency",…)`); tsc's refers to the class binding, which a
bundler then minifies. A shared entity reaching the UI through a **tsc-built `dist`** therefore
arrived with a mangled name: `name in entities` failed in `foreignKeys()`, and every lookup
column silently degraded to a raw UUID under an "…id" heading. Only in the production build —
the dev server was correct, so `npm run dev:local` and the e2e suite could not see it. Two
guards now: the UI resolves entity packages to **source**, and `esbuild.keepNames` is on.
Re-run: `npm run build && node scripts/check-bundle.mjs`. That script looks for the static
block `keepNames` emits — `this,"<Entity>")` — and **not** for the bare entity name, which is a
false pass: measured, a `keepNames: false` bundle still carries each name three times as label
text while the static block drops to zero.

**The filter API offers far more than `contains`/`in`/`isNull`, and range operators work.**
Verified against the running backend: `gte`/`lte` on numbers and dates, `startsWith`, `neq`.
That is what makes server-side range facets possible — the database answers "population
between 5M and 70M", not a page of loaded rows. Two nested-relationship capabilities also work:
`select(['code','currency.code'])` returns the related row inline, and
`where({currency:{code:{eq:'EUR'}}})` filters on it. Two do **not**:
`orderBy({currency:{code:'asc'}})` throws `direction?.toUpperCase is not a function` inside the
SDK, and `where({currency:{isNull:false}})` is rejected by DAB as an unknown field.

**A DataGrid header cell's `aside` slot already belongs to the resize handle.**
`useTableColumnSizing` renders `<TableResizeHandle>` into it, so passing your own `aside`
removes the handle and dragging a column silently stops working — no error, the drag just does
nothing. Compose instead: read `columnSizing_unstable.getTableHeaderCellProps(columnId)` via
`useDataGridContext_unstable` and render its `aside` alongside your own content. It is a Fluent
slot shorthand, not a `ReactNode`, so it can only be nested as children. Measured while adding
per-column filters; the e2e resize test caught it.

**The Fabric item's display name is the `id`, not `name`.** `name:` in `rayfin.yml` did not
appear on the item; the workspace listing showed the `id` verbatim, so `id` is what business
users see.

## Identity and permissions

*Measured: CLI 1.34.0, local server image cli-1.33.0, Fabric (Australia East).
Shelf life: architecture. The full model with diagrams, personas and official references is
in [auth-and-permissions.md](auth-and-permissions.md); this section keeps only the measured
claims.*

**Item permissions separate use from deploy; nothing separates users from each other.** The
two levels are easy to conflate and behave differently:

| Boundary | Granularity |
|---|---|
| Fabric item permission | **Run and interact** (open and use the app — all workspace members get it) vs **Edit** (deploy, apply schema) vs **Reshare**. "Workspace roles don't supersede item-level permissions" — so "people use it, only CI deploys it" is a real, enforced boundary. |
| Inside the app | `anonymous` vs `authenticated` — everyone signed in is equal |
| Per row | `claims.sub` / `claims.email` equality only |

**A second identity confirms the use/deploy boundary — and two gaps the docs omit.** With a
purpose-made, unprivileged Entra user: a *Run and interact* (Read+Execute) grant lets the user
invoke the app but not its deploy/write proxy (401); a scoped SQL role restricts a Read
grantee to exactly the tables granted. The gaps: *Run and interact* does **not** grant the
Fabric REST items-API `GET` — that needs *Write* — and item-permission propagation is slow.
A fresh item share took far longer than minutes to take effect, so budget the documented two
hours; workspace-*role* assignment propagated quickly. Full matrix and the granular-SQL
recipe: [auth-and-permissions.md](auth-and-permissions.md).

**`claims.role` can never carry an application role.** The docs show
`claims.role.eq('admin')` as a supported pattern; it compiles and cannot match. A decoded
token carries `sub, email, name, role, jti, iat, exp, nbf, iss, aud, sid`. Probing the
control-plane `Users.Role` column directly showed every value ≥ 1 collapsing to
`"Authenticated"` in the issued token (0 gives `"Anonymous"`). There is no third value and no
API to assign one. `customClaims` in `rayfin.yml` did not reach the token at all (local
1.33.0 server, not retested on Fabric); they would also be static per project, the same for
every user. An app can therefore express exactly two authorisation models: one named person,
or everyone signed in. No admin override, no read-only steward, no maker-checker. A read-only
tier needs a second app or workspace.

## The data downstream

*Measured: deployed app's database, Australia East. Latencies are single
measurements on an idle database — treat as orders of magnitude. Shelf life: architecture,
except the latencies.*

**The SQL analytics endpoint exists automatically and works end to end.** A `SQLEndpoint`
item appears alongside the database with no configuration. Full T-SQL reads work, joins
included, and app-written audit attribution flows downstream (`updatedBy` queryable in the
warehouse). Writes are refused (*"DML statements are not supported"*, error 24559).

**Discovery is by convention, not API.** The endpoint's connection string is in no API we
could find (`sqlDatabases/{id}` returns the primary only; the typed endpoint APIs 404). Take
the primary host and swap `.database.fabric.microsoft.com` for
`.datawarehouse.fabric.microsoft.com`; the catalog is the item's display name. Or read it
from the portal's Settings → Connection strings.

**Mirroring lands in under a minute on an idle database.** A row written at the SQL primary
appeared on the endpoint in 47 s; rows written through the deployed app in 27 s; deletions in
63 s.

**There is no total row count.** `PagedResult` declares `totalCount?: number` ("when provided
by the server"), and the server never provides it — measured against the local backend, where
a page result carries exactly `items`, `hasNextPage` and `endCursor`. The SDK docs list
`count()` as unsupported: the same gap seen from the client. A grid can say "100 loaded, more
available" but not "100 of 1,247"; the only route to a total is walking every page, which is
what `all()` does and why it is capped. Treat row counts as unavailable rather than expensive.

**A long-lived endpoint session never sees new data.** Sessions pin a snapshot: five minutes
of polling on one connection saw nothing, reconnecting saw the row at once. Anything polling
the endpoint must reconnect, or it will conclude mirroring is broken when it is not.

**ODBC Driver 18 cannot do interactive Entra sign-in on Linux — use an access token.** The
portal's ODBC string specifies `ActiveDirectoryInteractive`, which the driver does not
support on Linux: no browser opens, and it dies with `Login timeout expired`, which reads
like a network fault. What works: `az login`, then an access token for
`https://database.windows.net/` passed via the `SQL_COPT_SS_ACCESS_TOKEN` (1256) connection
attribute, with no `Authentication=` keyword.

**HEAD requests are broken platform-wide — probe with GET.** Any HEAD against the hosted app
returns a small JSON body instead of the asset's headers, so uptime checks and `curl -I` lie.

**The hosted app answers safely from outside** (unauthenticated surfaces, probe volumes
kept modest — rejections bill the capacity):

- Static assets sit behind Azure Front Door with immutable-cache headers and edge hits from
  the second fetch.
- Unknown paths serve `index.html` with 200, so client-side routing would work.
- The unauthenticated backend leaks nothing and fails fast: bare GraphQL 401 in ~190 ms,
  forged bearer 401.
- A signed-out boot settles on the sign-in screen in ~8 s, with zero console errors.
- SQL planes: the primary connects in ~0.7 s with joins ~19 ms median; the endpoint takes
  ~3.7 s to establish a session and ~4 s for a cold first query, settling to ~80 ms —
  budget the session start into anything interactive.

## Incidents

*Shelf life: incident — observed in anger (env flip) or once (publishable key); causes open;
recoveries verified.*

**The env flip.** After a `rayfin up status`, the next `rayfin env --framework vite` (run on
every warm start) regenerated `rayfin/.env` and `.env.local` with the **deployed** backend's
URL and key. Local dev then failed in two confusingly different ways: scripts hardcoding
`localhost:5168` kept working, while the app silently showed the sign-in screen with no error
(a deployed URL makes `isLocalBackend` false, and that path ends quietly at a button). It fired
again after a `rayfin up`, and `up switch` makes the rewrite routine — so `npm run dev:local`
now detects a deployed pointer while the local backend answers its healthcheck, and repairs
both the URL and the publishable key itself (`scripts/local.mjs`). Manual recovery, needed only
outside that path: set `RAYFIN_PUBLIC_API_URL=http://localhost:5168` in `rayfin/.env`, re-run
`npx rayfin env --framework vite`, restart Vite. Other values survive.

**The publishable key revert.** The local admin database's project row suddenly held
`PublishableKey = 'pk-commonSampleAppPKkey'` (a server-side sample default) while
`ConfigJson` stayed intact; every sign-in failed with *"The provided publishable key is
invalid"*. If sign-in fails everywhere with that message, check the `Projects` table first.
Recovery, verified:

```sh
docker exec fabric-app-<instance>-admin-db-1 psql -U postgres -d RayfinDB \
  -c "UPDATE \"Projects\" SET \"PublishableKey\" = '<the key from .env.local>';"
docker restart fabric-app-<instance>-webservice-1   # drops the server's settings cache
```

### Incident: new AppBackend items stopped provisioning their database (2026-08-16 to 17, open)

*Measured: CLI 1.34.0, Australia East, FT1 trial capacity. Shelf life: incident — the cause is
open and the recovery is "retry later".*

**A new AppBackend item is created, then fails runtime-settings sync with a 500 and never
provisions its SQLDatabase or SQLEndpoint.** The item appears in the workspace; the databases
never do. `rayfin up` reports `Runtime settings sync failed: 500 Internal Server Error /
Details: An internal error occurred.` about 60 seconds after creation.

**The failure is inside Fabric, one layer below Rayfin.** The CLI prints the correlation id
itself — `RootActivityId: <guid>`, on its own line after `Details:` — so read the whole failure
block rather than grepping for the message. It does *not* show the inner cause; POSTing the
same request by hand returns:

```
{"code":"InternalServerError","message":"An internal error occurred.","hresult":-2147467259,
 "details":[{"code":"RootActivityId","message":"9ebcb5fa-e363-4613-9902-45701d54b8c1"},
            {"code":"PowerBIApiErrorResponse",
             "message":"{\"error\":{\"code\":\"InternalServerError\",
                          \"message\":\"An internal execution error occured\"}}"}]}
```

So the BaaS workload's own call to the **Power BI API** fails; `hresult` is `0x80004005`
(E_FAIL) with no sub-code. `RootActivityId` also comes back as the `x-ms-root-activity-id`
header — quote it on a support ticket. To capture it, POST directly rather than reading the
CLI's summary; the deploy log prints the endpoint:

```sh
curl -sD- -X POST "<itemEndpoint>/__private/projectRuntimeSettings" \
  -H "Authorization: Bearer $(az account get-access-token \
       --resource https://api.fabric.microsoft.com --query accessToken -o tsv)" \
  -H 'Content-Type: application/json' -d '{"data":{"enabled":true,"dialect":"mssql"}}'
```

Second sensor: `GET <itemEndpoint>/healthcheck` returns **404** on the stuck item and **200**
on a working one — the item exists but no backend was ever stood up behind it.

**The discriminator is creation versus update, and tearing the estate down does not help.**
Creating an item fails on every combination tried; updating one succeeds on all of them:

| the deploy | identity | workspace | result |
| --- | --- | --- | --- |
| creates a new item | federated MI (CI) | new, dedicated | 500 |
| creates a new item | federated MI (CI) | shared, already hosting a working item | 500 |
| creates a new item | interactive admin, local `rayfin up` | brand-new scratch | 500 |
| **updates an existing item** | either | either | **200 in ~350 ms** |

In one run (31976768177) the same workflow, identity and capacity applied runtime settings to
*existing* items in **353 ms** and 500'd on the one item it had just created. Identity,
workspace, CLI, this repo's configuration: none of them is the variable. A workspace built by
hand from scratch fails exactly as the pipeline's does, and three distinct new items have
failed (`RootActivityId` `9ebcb5fa…`, `2581ee71…`, `b28cf7b1…`). Recreating the estate would
destroy the items that still work without being able to replace them.

Testing, not reasoning, ruled out four further hypotheses:

- a transient 500 → identical on rerun, four times;
- a stale hosting URL naming a different item → cleared both variables, identical;
- a half-provisioned item → deleted it and let CI recreate, identical;
- a database cap on the trial capacity → deleted two workspaces to free two databases,
  identical.

The same Prod path succeeded roughly thirteen hours before the first failure. Test deploys keep
succeeding throughout — but they *update* items that already exist, which the job log
distinguishes: an update logs "Runtime settings applied", a creation logs "Resource created
successfully" first.

**A full teardown and rebuild was tried, and it cost the whole estate.** On 2026-08-17 both
workspaces were deleted and recreated from scratch — fresh ids, capacity assigned, each
deploying identity granted Contributor again — on the theory that retargeting an instance
between workspaces had left something inconsistent. It had not: the first deploy into the new
workspaces failed at **Test**, for both instances, creating two AppBackends with no database
between them, and Prod was never reached. The rebuilt `reference` item fails exactly like the
rest (`RootActivityId aee31a44`).

That was the one action this fault makes irreversible. Until it was taken, `reference` served
Test and Prod normally — not because those workspaces were special, but because its items had
been *created before the fault began*, and updating an existing item still works. Deleting them
converted every deploy in the estate into a creation, which is the broken operation. There is
no way back until the platform recovers.

The hypothesis was already disproven before the teardown, by a cheaper test: an item created by
hand, with an admin token, in a workspace made seconds earlier and never deployed to, fails the
same way (`RootActivityId 223c4907`). A brand-new workspace *is* the clean slate — tearing down
a working one adds no evidence and removes the only apps that still answer.

**Capacity limits were investigated and do not explain it.** The trial reports `FT1`,
`state: Active` from both the Fabric and Power BI admin APIs. Three measurements argue against
a quota: the same capacity applied settings to *existing* items in 353 ms while refusing
creations in the same run, and exhaustion does not discriminate by operation type; creation
still failed with the estate completely empty — zero AppBackends and zero SQLDatabases — which
is the most permissive a cap could ever be; and Fabric reports capacity exhaustion explicitly
(429, `CapacityLimitExceeded`), not as a generic 500 wrapping a `PowerBIApiErrorResponse`. What
is *not* visible from the API is CU burn and throttling, which live in the Capacity Metrics
app, or the trial's expiry date.

**A Premium-Per-User capacity cannot host an AppBackend.** Assigning a workspace to a `PP3`
capacity succeeds, and `rayfin up` then fails at item creation with `403 Forbidden` — a
different failure from the 500 above, and the reason PPU cannot be used as a fallback capacity.

**Nobody else has reported it publicly, and Microsoft's escalation path for Rayfin is a dead
link.** The Fabric Apps troubleshooting page ends with "Check the GitHub repository for known
issues" pointing at `github.com/microsoft/project-rayfin`, which returns 404 — there is no
public issue tracker. The closest published analogue is a Fabric community thread on a
recurring 500 from `db apply` ("Failed to apply configuration to remote endpoint"): a different
call, the same shape, and its accepted answer is the same conclusion reached here — capture the
timestamp and correlation id and open a support ticket, because this class of failure needs
backend investigation. The `PowerBIApiErrorResponse` envelope itself is a known Power BI
backend wrapper, which corroborates that the error is being passed through rather than
generated by Rayfin. Nothing in the Fabric Apps FAQ documents a trial-capacity restriction or
any cap on app items per capacity.

**Everything a support ticket needs, in one place.** Seven creations failed, each with its own
`RootActivityId`; the routing hint was `host004_baas-002`:

| # | what was creating the item | `RootActivityId` |
| --- | --- | --- |
| 1 | CI, dedicated Prod workspace | `9ebcb5fa-e363-4613-9902-45701d54b8c1` |
| 2 | manual POST, shared Prod workspace | `2581ee71-ca7c-46d7-b956-4271e6e1c7bc` |
| 3 | local `rayfin up`, admin token, scratch workspace | `b28cf7b1-46c6-4dac-8ad6-56c813830a03` |
| 4 | CI, after deleting the half-provisioned item | `1524c14f-e1c2-44b2-bb4e-64001f683730` |
| 5 | manual POST to the half-provisioned item | `3f677afa-95e9-4780-9f99-2554f2786964` |
| 6 | local `rayfin up`, workspace created seconds earlier | `223c4907-467c-4663-907d-c3ad8f3514fb` |
| 7 | CI, into workspaces rebuilt from scratch | `aee31a44-91de-46ff-b515-a540aa671ce7` |

Recovery: none found, and now nothing to fall back on. The capacity reports `Active`; local
Docker development is unaffected. Nothing on this side can fix it — the failing call is the
BaaS workload's own call to the Power BI API — so the next step is a support ticket quoting the
ids above, not another deploy.

## Corrected beliefs

Claims this project (or its predecessor) once held, recorded so they are not re-derived. The
shared lesson: a workaround can be genuinely necessary and still be documented with the wrong
cause — which is exactly how it survives review.

- **"A Fluent `DatePicker` cannot live inside a `Popover`."** Held for about an hour while
  building the range facets. The observation was real — opening the calendar dismissed the
  filter panel and lost the typed bound — but the conclusion was too strong. The calendar
  renders in a **portal**, DOM-outside the popover; `DatePicker`'s `inlinePopup` prop renders
  it in place instead. With that one prop the picker works inside a popover: the panel stays
  open, the day is picked, the bound applies. The plain text input shipped first was
  unnecessary. Re-run: open the Filter panel on an entity with a date column and click a bound.
- **"A plain shared base class is the way to share audit columns."** Verified end to end —
  with one entity; a second merged its columns into the first's table. The fix is a factory
  per entity: see [Modelling data](#modelling-data).
- **"`rayfin dev` never posts runtime settings; a bootstrap POST is required."** The symptom
  was real; the cause was ours — `password.enabled: false` left the local project
  unconfigured. A 262-line workaround script shrank to almost nothing.
- **"`${VAR}` interpolation does not survive `rayfin up`."** It does; verified twice.
- **"Omitted `-w`, `rayfin up` defaults to My workspace."** True when researched; on CLI
  1.34 a clone with no recorded deployment is prompted for a workspace interactively, and
  refused in a non-interactive shell.
- **"`npm run dev:local -- db apply --force` forces the apply."** npm appends `--`-forwarded
  args to the end of a *compound* script, so they went to vite; the script's own fast path
  still applied the schema whenever stale, which kept the broken form looking functional for
  weeks. Use `npm run local:db -- --force`.
- **"`:latest` of the webservice image lacks `/api/applyconfig`; pin `cli-1.33.0`."** Same
  image, identical digests. The pin was necessary only to escape the private default
  repository.
- **The predecessor repo documented region gating, mirroring, Functions and Storage "with
  the confidence of measurement" while `~/.rayfin` held no credentials and no deploy had
  ever run.** Inherited notes are hypotheses; the load-bearing ones get re-verified here.
- **"Everyone who can open the app can edit it; Fabric has no read-only level."** Wrong at
  the item level — **Run and interact** vs **Edit** is real and enforced. The kernel of
  truth: *inside* the app there is still no read-only role.
- **"The registry test requires audit columns on every entity."** It did. It now applies the
  audit contract only to entities that opt in, and an unaudited entity works everywhere (the
  grid has no provenance column).

## Still untested

- **Functions** (`TYPESCRIPT is unsupported`) and **Storage** — both disabled here.
- **Rename-plus-retype in one step**, and rename detection limits generally.
- **Guest (B2B) users** inside the app — never exercised.
- **Unsupported-region behaviour** — documented as `403 FeatureNotAvailable`, never
  exercised from here; check the
  [official availability list](https://learn.microsoft.com/fabric/admin/region-availability),
  not a snapshot.
- **Capacity pause/resume** — what a paused capacity does to a running app (sign-in, API,
  static hosting) is unknown; the trial capacity here cannot be paused.
