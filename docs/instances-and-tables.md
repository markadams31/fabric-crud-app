# Instances, tables and imports

How to change what the app manages: add an app, add a table to one, share a table between
several, load rows in bulk. [operations.md](operations.md) covers deploying those changes;
this file is about making them.

- [What an instance is](#what-an-instance-is)
- [Adding an instance](#adding-an-instance)
- [Adding a table](#adding-a-table)
- [Sharing a table between instances](#sharing-a-table-between-instances)
- [Bulk import](#bulk-import)

## What an instance is

An **instance** is a Fabric app — its own tables, its own Fabric item, its own users — built
from this one codebase, so an improvement ships to every instance at once. The **item** is the
unit of separation, not the workspace: instances share the Test and Prod workspaces by
default, so adding one usually adds no Fabric estate at all. Two ship here: `reference` (the
sample tables) and `finance` (a smaller, entirely separate set — `Invoice` and `CostCode`).
Delete either with `rm -rf instances/<instance>` and drop its `tsconfig.json` reference.

Everything instance-specific lives under `instances/<instance>/`; nothing else knows an
instance exists. `RAYFIN_INSTANCE` selects one — unset means `reference`, so the default
needs no ceremony:

```sh
RAYFIN_INSTANCE=finance npm run dev:local   # or set it once in rayfin/.env
```

`packages/shared` holds what every instance needs: the audit contract. Entity classes can be
shared the same way, each instance getting its own table with its own rows — proven, but
deliberately not demonstrated, because it earns its place only when a table's *shape* is
standardised while each domain owns its *rows*.

**Instances coexist in one workspace.** Each is a separate Fabric item keyed by its `id`, with
its own database — measured, and the shipped estate runs that way. The one caveat is
**local**: the CLI's deployments registry is keyed by *workspace*, so a checkout that has
already deployed one instance retargets that item when you deploy a second. Remove the record,
or work on one instance at a time. CI never hits it — every job is a fresh checkout. See
[platform-constraints.md](platform-constraints.md#several-apps-from-one-codebase).

## Adding an instance

Four files and one line in the repo, two repository variables outside it, and a workspace pair
only if this one needs its own. The repo half is the part you do often, and the cheap one by
design.

**1. Create the directory.** Copy `instances/finance/`, the smaller of the two, then **change
three things the copy gets wrong** — or write the four files from scratch:

- `package.json`'s `name`: two workspaces called `@instance/finance` is an install error.
- the copied entity files: delete them, they are finance's tables, not yours.
- `seed.mjs`: its rows name tables your instance does not have, so seeding fails.

```
instances/<instance>/
  package.json    name "@instance/<instance>", "exports": "./dist/index.js", build "tsc -b tsconfig.json"
  tsconfig.json   extends ../../tsconfig.entities.json, references ../../packages/shared
  src/*.ts        your entity classes
  src/index.ts    the registry — see "Adding a table" below
  seed.mjs        optional sample rows
```

**2. Reference it in the root `tsconfig.json`:**

```jsonc
"references": [ … , { "path": "./instances/<instance>" } ]
```

Miss it and the instance is invisible to `tsc`: `npm run check` stays green while the instance
has type errors. A test asserts the entry exists, so you will be told.

**3. `npm install`** — it is an npm workspace, so this links it.

From here it runs locally: `RAYFIN_INSTANCE=<instance> npm run dev:local`, then
`RAYFIN_INSTANCE=<instance> npm run seed`. `npm run check` now covers it automatically.

**4. Point it at workspaces.** Usually there is nothing to do — by default an instance deploys
into the shared Test and Prod workspaces (`FABRIC_TEST_WORKSPACE_ID` /
`FABRIC_PROD_WORKSPACE_ID`) and needs no new one, for the reason given above: each is a
separate Fabric item keyed by its `id`.

Give an instance workspaces of its own only when it needs an isolation the item level cannot
give — see the caveat below. Create them, then set the overrides in step 5.

If you do create one: a portal-created workspace lands on **Pro** and must be on a **Fabric
capacity** for a data app to deploy into it, and it needs the matching deploying identity as
**Contributor** — the Test workspace gets the Test identity, Prod the Prod one. Those are the
identities named by the `MI_TEST_CLIENT_ID` / `MI_PROD_CLIENT_ID` variables; how they were
created is in [operations.md](operations.md#standing-the-pipeline-up-from-a-fork).

**The caveat that decides it.** Item-level sharing gives per-app access — the app item is
shareable to anyone in the org — but workspace **roles grant implied permissions on every
item**, and a workspace Viewer can read every table over SQL. So in a shared workspace, domain
users must get the **app item**, never a workspace role. Nothing in the platform enforces that.
An instance whose data must be separated structurally rather than by policy is the one that
earns its own workspace.

**5. Set its repository variables** — the two hosting URLs always, the two workspace ids only
if it should not use the defaults. Throughout this file `<instance>` is the directory name as
you created it (`finance`) and `<INSTANCE>` is that name **upper-cased, with anything outside
A–Z and 0–9 replaced by an underscore** — so `cost-centre` becomes `COST_CENTRE`. The workflow
derives it; you need it only to name the variables:

| variable | value |
| --- | --- |
| `FABRIC_TEST_WORKSPACE_ID_<INSTANCE>` | *only if it should not use the default* — overrides `FABRIC_TEST_WORKSPACE_ID` |
| `FABRIC_PROD_WORKSPACE_ID_<INSTANCE>` | *only if it should not use the default* — overrides `FABRIC_PROD_WORKSPACE_ID` |
| `FABRIC_TEST_HOSTING_URL_<INSTANCE>` | *leave unset for now* |
| `FABRIC_PROD_HOSTING_URL_<INSTANCE>` | *leave unset for now* |

The workspace override is a **grouping key, not a 1:1 escape hatch** — nothing requires the ids
to be distinct. One variable therefore covers three shapes: unset, for the default workspace;
the same value on several instances, for a group with a workspace of its own; a unique value,
for isolation. Grouping couples nothing either: the pipeline serialises on `deploy-<instance>`,
freezes on `deploy-freeze:<instance>` and diffs against `production-<instance>`, none of which
mention a workspace.

**6. Push.** The pipeline finds the new directory by itself — no workflow edit — and creates
the Fabric items. Let it: schema apply is **owner-gated**, so an item created by hand can never
be migrated by CI.

**Expect it to stop.** A new instance has no previous Prod deploy to compare against, so it
fails closed into the schema category and waits at the approval gate. That is not a fault;
approve it and the run continues to Prod. Other instances in the same run are unaffected.

**7. Set the two hosting URLs and push again.** The URLs do not exist until the first deploy;
until they are set, the app's allowed redirect list falls back to localhost and browser
sign-in from the deployed origin will not work. Each deploy job's summary prints its URL on an
"App loads:" line — take Test's from the Test job and Prod's from the Prod job.

## Adding a table

Once an instance exists, giving it a table is five steps.

1. Write an entity class in `instances/<instance>/src/` (see the example above). Extend
   `Audited()` for created/updated attribution; the parentheses matter, and
   [packages/shared/src/audit.ts](../packages/shared/src/audit.ts) explains why.
2. Register it in that instance's `src/index.ts` **twice** — the barrel's two consumers read
   it differently:

   ```ts
   import { Region } from './Region.js';

   export { Region };                              // ← the Rayfin CLI collects NAMED CLASS
                                                   //   exports. An exported object is
                                                   //   invisible to it, so a table listed
                                                   //   only below never reaches the database.
   export const entities = { Region } as const;    // ← the UI reads this, as an object literal
                                                   //   so the keys stay literal types.
   ```

   `src/instances.test.ts` fails the build if the two drift, in either direction.

   Which instance gets it is the whole decision: a table belongs to exactly one instance, and
   instances do not see each other's tables.
3. Apply the schema locally: `npm run local:db` while the stack is running (destructive
   changes need `npm run local:db -- --force`); `npm run dev:local` also applies it on
   startup. Deployed environments get schema through the pipeline.
4. Write to it through `db.Region.create({ … })`. The session stamps the audit columns;
   supplying them yourself is a compile error.
5. Add sample rows to that instance's `seed.mjs` if it has one — fixtures live with the
   instance because a seeder naming a table cannot run against an instance that lacks it.

`npm run check` (typecheck plus tests) catches the mistakes that otherwise fail silently at
runtime, across **every** instance rather than the active one: a table exported but not
registered (or the reverse), a `@text()` without `max`, a missing permission decorator, an
instance missing from the root `tsconfig.json`. Destructive schema changes require an explicit
`--force`.

## Sharing a table between instances

An instance can re-export an entity class from `packages/shared` rather than declare its own.
Both instances then get that table — **the same shape, their own rows**, because each instance
is a separate Fabric item with a separate database. Nothing is shared at run time.

The samples do not do this. When it is worth doing:

**Standardised shape, domain-owned rows.** Finance and HR each keep their own cost codes, but
the columns must match so their SQL analytics endpoints can be unioned into one semantic model
downstream. Sharing the class makes drift impossible — nobody can add `isActive` to one and
`active` to the other. The strongest case, and specific to Fabric: these tables surface
downstream precisely because they line up.

**A centrally governed column set.** An organisation requires every domain app to carry the
same `CostCentre` columns for consolidated reporting. The shared class *is* the standard,
enforced by the type checker rather than by a wiki page.

**One fix, every app.** Correct a validation rule once — a regex, a max length, a permission
grant — and it reaches every instance that re-exports the class, the same reason the app code
is shared at all.

**When not to.** Reference data with a single rightful owner — a currency list, a chart of
accounts — is the tempting case and the wrong one. Sharing the class copies the *rows* into
every database, leaving the organisation four answers to "which currencies exist" and no way
to reconcile them. That wants one instance owning the data and the others reading it through a
Fabric connector — a different mechanism, and a deliberate piece of design.

The rule of thumb: share when the **shape** is standard and the **rows** are genuinely each
domain's own. If two instances should hold identical rows, you want one owner, not two copies.

## Bulk import

Each table has an Import button. Download the CSV template, fill it in, choose the file; before
anything is written the dialog reports what the import would do: rows to add, rows to update
(matched on the entity's unique business key), and identical rows to skip. Columns absent from
the file are left untouched on updates.

Validation runs on every cell first: foreign keys resolve by id or by display value; dates must
be valid ISO (`YYYY-MM-DD`); booleans accept common spellings and reject anything else;
decimals are checked against the column's declared scale; unique values are checked against
both the table and the rest of the file.

The platform has no transactions, so the import writes one row at a time. If a write fails, the
dialog deletes the rows it created and restores the rows it updated, then reports which write
failed and why. Files are capped at 500 rows; each row is one metered API call.
