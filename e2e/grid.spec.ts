import { expect, test, type Page } from '@playwright/test';

/**
 * The grid behaviours that were each, at some point, a real bug found in a
 * browser: pagination duplicating rows, one table's response landing under
 * another's headers, a search racing an in-flight "Load more". Everything
 * here is read-only — no test writes a row. Tabs are addressed by position
 * and tests SKIP when the registry has fewer entities than they need, so most
 * of the file works against any fork unchanged. The two import-gate tests and
 * the sort-affordance canary are the exceptions — they pin the sample schema
 * (Currency's CSV shape, Country's lookup column) and fail loudly on a fork:
 * rewrite them alongside your entities, the way importer.test.ts's fixtures
 * are rewritten.
 */

/** First-column values, which this app's entities keep unique. */
async function firstCells(page: Page): Promise<string[]> {
  const rows = await page.getByRole('row').all();
  return Promise.all(
    rows.slice(1).map(async (r) => (await r.getByRole('gridcell').first().innerText()).trim())
  );
}

const caption = (page: Page) =>
  page.locator('span').filter({ hasText: /\b(row|rows|match|matches)\b/ }).first();

/**
 * Switch to the nth tab, or skip the test on a registry too small to have
 * one. Without the guard a two-entity fork would TIME OUT here and read as an
 * app bug; a skip says what it means.
 */
async function useTab(page: Page, n: number) {
  test.skip((await page.getByRole('tab').count()) <= n, `needs at least ${n + 1} entities`);
  await page.getByRole('tab').nth(n).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // The local backend signs in silently; tabs appearing means it worked.
  await expect(page.getByRole('tab').first()).toBeVisible({ timeout: 20_000 });
  await expect(caption(page)).not.toContainText('Loading', { timeout: 20_000 });
});

test('pagination loads every page once and withdraws the button', async ({ page }) => {
  await useTab(page, 1);
  await expect(caption(page)).not.toContainText('Loading');

  const more = page.getByRole('button', { name: /Load more/ });
  for (let i = 0; i < 10 && (await more.isVisible().catch(() => false)); i++) {
    await more.click();
    // Settled means either re-enabled (more pages) or gone (exhausted).
    // Visibility first: isEnabled() auto-waits for a matching element, so
    // asking it about a button that no longer exists blocks, not answers.
    await expect(async () => {
      if (!(await more.isVisible().catch(() => false))) return; // gone = settled
      expect(await more.isEnabled({ timeout: 500 }).catch(() => false)).toBe(true);
    }).toPass({ timeout: 15_000 });
  }

  await expect(more).toBeHidden(); // exhausted, not merely disabled
  const cells = await firstCells(page);
  expect(new Set(cells).size, 'no row appears twice').toBe(cells.length);
  await expect(caption(page)).not.toContainText('more available');
});

test('a page arriving after a tab switch is discarded', async ({ page }) => {
  await useTab(page, 1);
  await expect(caption(page)).not.toContainText('Loading');
  const more = page.getByRole('button', { name: /Load more/ });
  test.skip(!(await more.isVisible().catch(() => false)), 'needs more than one page of rows');

  await more.click();
  await useTab(page, 2); // while that request is in flight
  await expect(caption(page)).not.toContainText('Loading');
  const settled = await firstCells(page);

  // The stale response lands (or is discarded) within this window.
  await page.waitForTimeout(2_500);
  const after = await firstCells(page);
  expect(after, 'rows unchanged after the stale window').toEqual(settled);
  expect(new Set(after).size).toBe(after.length);
});

test('search narrows server-side, reports honestly, and recovers', async ({ page }) => {
  await useTab(page, 1);
  await expect(caption(page)).not.toContainText('Loading');
  const box = page.getByRole('searchbox');
  test.skip(!(await box.isVisible().catch(() => false)), 'entity has no searchable fields');

  // A fragment that matches something — from a column the search actually
  // covers. `searchFilter` spans text and enum columns only, so a value taken
  // from a number or date cell matches nothing and the test fails for a reason
  // that says nothing about search. Try the first few cells and use whichever
  // is searchable; a schema with none is skipped, not failed.
  let matched = false;
  for (const cell of [0, 1, 2]) {
    const sample = (await page.getByRole('row').nth(1).getByRole('gridcell').nth(cell).innerText())
      .trim()
      .slice(0, 4);
    if (!sample) continue;
    await box.fill(sample);
    await expect(caption(page)).not.toContainText('Loading', { timeout: 10_000 });
    if ((await firstCells(page)).length > 0) {
      matched = true;
      break;
    }
  }
  test.skip(!matched, 'no visible column is covered by this entity’s search filter');
  await expect(caption(page)).toContainText(/match/, { timeout: 10_000 });

  await box.fill('zzzzzz');
  await expect(page.getByText('No matches')).toBeVisible({ timeout: 10_000 });

  await box.fill('');
  await expect(caption(page)).toContainText(/rows/, { timeout: 10_000 });
});

test('a search fired during Load more ends with a pure result set', async ({ page }) => {
  await useTab(page, 1);
  await expect(caption(page)).not.toContainText('Loading');
  const more = page.getByRole('button', { name: /Load more/ });
  const box = page.getByRole('searchbox');
  test.skip(
    !(await more.isVisible().catch(() => false)) || !(await box.isVisible().catch(() => false)),
    'needs a second page and a search box'
  );

  const sample = (await page.getByRole('row').nth(1).getByRole('gridcell').nth(1).innerText())
    .trim()
    .slice(0, 4);
  await more.click();
  await box.fill(sample); // races the in-flight page
  await expect(caption(page)).toContainText(/match/, { timeout: 10_000 });
  await page.waitForTimeout(2_000); // let any stale append attempt land

  const cells = await firstCells(page);
  expect(new Set(cells).size, 'no spliced or duplicated rows').toBe(cells.length);
  await expect(caption(page)).toContainText(/match/);
});

test('sorting re-queries the server and covers the whole result set', async ({ page }) => {
  await useTab(page, 1);
  await expect(caption(page)).not.toContainText('Loading');
  const before = await firstCells(page);

  // Ascending on the first column: the order changes and holds server-wide —
  // codes are unique here, so ascending means strictly increasing.
  await page.getByRole('columnheader').first().click();
  await expect(caption(page)).not.toContainText('Loading');
  await expect(async () => {
    const cells = await firstCells(page);
    expect(cells).not.toEqual(before);
    const sorted = [...cells].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    expect(cells).toEqual(sorted);
  }).toPass({ timeout: 10_000 });

  // Second click flips to descending.
  await page.getByRole('columnheader').first().click();
  await expect(async () => {
    const cells = await firstCells(page);
    const sorted = [...cells].sort((a, b) => b.localeCompare(a, undefined, { sensitivity: 'base' }));
    expect(cells).toEqual(sorted);
  }).toPass({ timeout: 10_000 });

  // Load more continues the sorted walk rather than restarting it.
  const more = page.getByRole('button', { name: /Load more/ });
  if (await more.isVisible().catch(() => false)) {
    await more.click();
    await expect(async () => {
      const cells = await firstCells(page);
      expect(new Set(cells).size, 'no duplicates across sorted pages').toBe(cells.length);
    }).toPass({ timeout: 15_000 });
  }
});

test('the CSV template downloads the editable columns and nothing else', async ({ page }) => {
  await page.getByRole('button', { name: 'Import' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download template' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/-template\.csv$/);

  const file = await download.path();
  const { readFile } = await import('node:fs/promises');
  const text = (await readFile(file!, 'utf8')).replace(/^\ufeff/, '');
  const headers = text.trim().split(',');
  expect(headers.length).toBeGreaterThan(1);
  expect(headers).not.toContain('id');
  expect(headers.filter((h) => /^(created|updated)/.test(h))).toEqual([]);
});

test('the import gate blocks a file with errors and names them', async ({ page }) => {
  // Currency: a bad code (lowercase fails the pattern) and the same new code
  // twice. Read-only: the gate must refuse before anything is written.
  await page.getByRole('button', { name: 'Import' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('CSV file').setInputFiles({
    name: 'bad.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      'code,name,symbol,decimalPlaces,isActive\r\n' +
        'xx,Bad Code,,2,true\r\n' +
        'ZZM,First,,2,true\r\n' +
        'ZZM,Second,,2,true\r\n'
    ),
  });
  await expect(dialog.getByText(/rows need fixing/)).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText(/appears twice in the file/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: /^Import( \d+ rows?)?$/ })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('a file matching an existing row reads as an update, not an error', async ({ page }) => {
  // Read-only: the verdict is checked, nothing is imported.
  const row = page.getByRole('row').nth(1);
  const code = (await row.getByRole('gridcell').first().innerText()).trim();
  await page.getByRole('button', { name: 'Import' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('CSV file').setInputFiles({
    name: 'update.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      `code,name,symbol,decimalPlaces,isActive\r\n${code},A different name,,2,true\r\n`
    ),
  });
  await expect(dialog.getByText(/1 to update/)).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByRole('button', { name: 'Import 1 row' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('a lookup column offers no sort affordance (sample-pinned canary)', async ({ page }) => {
  // Sortability rides on Fluent's compare-arity check (see EntityPage.tsx):
  // an undocumented internal a library bump could change. If every sort
  // button vanishes, the sorting test above fails; this canary catches the
  // other direction — a lookup column silently growing a dead sort button.
  // Sample-pinned: Country's Currency column is the lookup.
  //
  // "No buttons at all" was the old assertion, and it stopped meaning what it
  // said the moment headers gained filter icons. Name what is actually
  // forbidden — a SORT affordance — so the canary keeps failing for the reason
  // it was written for, and not for every future header affordance.
  await useTab(page, 1);
  await expect(caption(page)).not.toContainText('Loading');
  const lookupHeader = page.getByRole('columnheader', { name: 'Currency' });
  test.skip(!(await lookupHeader.isVisible().catch(() => false)), 'sample Country tab not present');
  const sortSlot = '[class*="HeaderCell__button"][role="button"]';
  // A sortable column: the first one is plain text and carries the affordance.
  await expect(page.getByRole('columnheader').first().locator(sortSlot)).toHaveCount(1);
  // The lookup: filterable, so it has a filter button — but must not be sortable.
  await expect(lookupHeader.locator(sortSlot)).toHaveCount(0);
  await expect(lookupHeader.getByRole('button', { name: /^Filter / })).toHaveCount(1);
});

test('opening a column filter does not sort that column', async ({ page }) => {
  // Shipped broken. The filter lives in the header cell's `aside` slot, and
  // Fluent puts the sort's onClick on the header cell DIV — not on a button —
  // so the filter's click bubbled straight into the sort and silently
  // reordered the table under the person who only wanted to filter it.
  // Neither the type checker nor any other test could see it: the popover
  // opened correctly, so the filter itself looked fine.
  const sortStates = () =>
    page.$$eval('[role=columnheader]', (hs) => hs.map((h) => h.getAttribute('aria-sort') ?? 'none'));

  await useTab(page, 0);
  await expect(caption(page)).not.toContainText('Loading');
  const filter = page.getByRole('button', { name: /^Filter / }).first();
  test.skip(!(await filter.isVisible().catch(() => false)), 'no filterable column in this schema');

  const before = await sortStates();
  await filter.click();
  // The popover must actually open — otherwise this passes for the wrong reason.
  await expect(page.getByRole('button', { name: /^Filter / }).first()).toHaveAttribute(
    'aria-expanded',
    'true'
  );
  expect(await sortStates()).toEqual(before);
});

test('columns resize by dragging and hold their width', async ({ page }) => {
  await page.getByRole('tab').nth(0).click();
  await expect(caption(page)).not.toContainText('Loading');
  await page.waitForTimeout(500); // measured widths settle once after load

  const header = page.getByRole('columnheader').nth(1);
  const before = (await header.boundingBox())!;
  await page.mouse.move(before.x + before.width - 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width + 100, before.y + before.height / 2, { steps: 10 });
  await page.mouse.up();

  const after = (await header.boundingBox())!;
  expect(after.width).toBeGreaterThan(before.width + 60);
});

test('filters and search survive a tab switch, per entity', async ({ page }) => {
  // The `key={view.name}` remount resets per-mount presentation; filters live
  // above it deliberately. Someone who narrows a table, glances at another tab
  // and comes back should not have to do the work twice — and the entity they
  // glanced at must not inherit the filter.
  await useTab(page, 1);
  await expect(caption(page)).not.toContainText('Loading');
  const filterIcon = page.getByRole('button', { name: /^Filter / }).first();
  test.skip(!(await filterIcon.isVisible().catch(() => false)), 'no facetable column here');

  await filterIcon.click();
  const box = page.getByRole('checkbox').first();
  await box.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /Remove filter/ })).toHaveCount(1);
  const narrowed = await page.getByRole('row').count();

  await useTab(page, 0);
  await expect(caption(page)).not.toContainText('Loading');
  // The other entity is its own: it must not show this filter.
  await expect(page.getByRole('button', { name: /Remove filter/ })).toHaveCount(0);

  await useTab(page, 1);
  await expect(caption(page)).not.toContainText('Loading');
  await expect(page.getByRole('button', { name: /Remove filter/ })).toHaveCount(1);
  await expect(page.getByRole('row')).toHaveCount(narrowed);
});
