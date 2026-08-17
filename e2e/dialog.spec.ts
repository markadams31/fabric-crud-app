import { expect, test, type Page } from '@playwright/test';

/**
 * The dialogs' guardrails. The default tests are residue-free — they never
 * save. The two write-path tests are opted into with E2E_WRITES=1 and clean
 * up after themselves: one creates a probe row, proves duplicate rejection
 * and the edit round-trip, then deletes it; the other bulk-imports rows,
 * proves the update-and-skip pass, and deletes them. Still think before pointing it at a
 * shared backend — the intermediate states are visible to other users.
 */

const caption = (page: Page) =>
  page.locator('span').filter({ hasText: /\b(row|rows|match|matches)\b/ }).first();

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('tab').first()).toBeVisible({ timeout: 20_000 });
  await expect(caption(page)).not.toContainText('Loading', { timeout: 20_000 });
});

test('an empty submit flags every required field at once', async ({ page }) => {
  await page.getByRole('button', { name: /^New / }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  await dialog.getByRole('button', { name: /^(Add|Save)$/ }).click();
  const complaints = await dialog.getByText(/is required/).count();
  expect(complaints).toBeGreaterThan(0);
  await expect(dialog).toBeVisible(); // nothing was sent

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

test('Escape closes an open listbox before it closes the dialog', async ({ page }) => {
  // An entity with a dropdown — enum or lookup — is needed; find one. Clamp
  // to the tabs that exist so a smaller fork skips instead of timing out.
  const tabCount = await page.getByRole('tab').count();
  for (const i of [0, 1, 2, 3].slice(0, tabCount)) {
    await page.getByRole('tab').nth(i).click();
    await expect(caption(page)).not.toContainText('Loading');
    await page.getByRole('button', { name: /^New / }).click();
    const dialog = page.getByRole('dialog');
    // Every combobox, not just the first: Fluent's DatePicker also reports
    // `role=combobox` but opens a CALENDAR, so picking the first one made this
    // test fail on any schema whose earliest dropdown-ish control is a date.
    // The sample schema hid that by putting an enum ahead of its dates.
    const combos = dialog.getByRole('combobox');
    for (let c = 0; c < (await combos.count()); c++) {
      await combos.nth(c).click();
      const listbox = page.getByRole('listbox');
      if (!(await listbox.isVisible().catch(() => false))) {
        await page.keyboard.press('Escape'); // a calendar, or nothing — try the next
        continue;
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible(); // the listbox went, the dialog stayed
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      return;
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }
  test.skip(true, 'no entity offers a dropdown');
});

test('editing opens populated and cancel discards changes', async ({ page }) => {
  const before = await page.getByRole('row').nth(1).innerText();
  await page.getByRole('row').nth(1).getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  const name = dialog.getByRole('textbox').nth(1);
  await expect(name).not.toHaveValue(''); // populated, not blank
  await name.fill('Discarded by cancel');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  expect(await page.getByRole('row').nth(1).innerText()).toBe(before);
});

test('create, duplicate rejection, edit round-trip, delete', async ({ page }) => {
  test.skip(!process.env.E2E_WRITES, 'writes are opt-in: E2E_WRITES=1');

  // Tab 0 is Currency in this app: code is 3 uppercase letters, unique.
  const probe = { code: 'ZZE', name: 'E2E probe currency' };
  const dialog = page.getByRole('dialog');
  const openNew = async () => {
    await page.getByRole('button', { name: /^New / }).click();
    await expect(dialog).toBeVisible();
  };
  const fill = async () => {
    await dialog.getByRole('textbox').nth(0).fill(probe.code);
    await dialog.getByRole('textbox').nth(1).fill(probe.name);
    await dialog.getByRole('spinbutton').first().fill('2');
  };

  const exists = await page
    .getByRole('row')
    .filter({ hasText: probe.name })
    .first()
    .isVisible()
    .catch(() => false);

  if (!exists) {
    await openNew();
    await fill();
    await dialog.getByRole('button', { name: /^Add$/ }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByRole('row').filter({ hasText: probe.name }).first()).toBeVisible();
  }

  // The same code again must be rejected by the server, readably.
  await openNew();
  await fill();
  await dialog.getByRole('button', { name: /^Add$/ }).click();
  await expect(dialog.getByText(/already exists|unique/i)).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Edit the probe row's name and back, proving update round-trips.
  const row = page.getByRole('row').filter({ hasText: probe.code }).first();
  await row.getByRole('button', { name: 'Edit' }).click();
  await dialog.getByRole('textbox').nth(1).fill(`${probe.name} (edited)`);
  await dialog.getByRole('button', { name: /^Save$/ }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.getByRole('row').filter({ hasText: '(edited)' }).first()).toBeVisible();

  const again = page.getByRole('row').filter({ hasText: probe.code }).first();
  await again.getByRole('button', { name: 'Edit' }).click();
  await dialog.getByRole('textbox').nth(1).fill(probe.name);
  await dialog.getByRole('button', { name: /^Save$/ }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });

  // Delete the probe — the suite leaves the database as it found it.
  // Addressed as `alertdialog`, not `dialog`: a destructive confirm declares
  // the stronger role, and the two do not match each other, so this locator
  // fails loudly if that ever regresses to a plain dialog.
  const target = page.getByRole('row').filter({ hasText: probe.code }).first();
  await target.getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('cannot be undone');
  await confirm.getByRole('button', { name: /^Delete$/ }).click();
  await expect(confirm).toBeHidden({ timeout: 15_000 });
  await expect(page.getByRole('row').filter({ hasText: probe.code })).toHaveCount(0, {
    timeout: 15_000,
  });
});

test('bulk import round-trips and cleans up', async ({ page }) => {
  test.skip(!process.env.E2E_WRITES, 'writes are opt-in: E2E_WRITES=1');

  const codes = ['ZZX', 'ZZY'];
  await page.getByRole('button', { name: 'Import' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('CSV file').setInputFiles({
    name: 'probe.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      `code,name,symbol,decimalPlaces,isActive\r\n` +
        `${codes[0]},E2E import probe one,,2,true\r\n` +
        `${codes[1]},E2E import probe two,,0,false\r\n`
    ),
  });
  await expect(dialog.getByText('2 to add.')).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Import 2 rows' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  // Both landed; then delete both so the suite leaves no residue.
  for (const code of codes) {
    await expect(page.getByRole('row').filter({ hasText: code }).first()).toBeVisible({
      timeout: 15_000,
    });
  }

  // Re-import with one row edited and one identical: the changed row updates,
  // the identical one is skipped, nothing errors.
  await page.getByRole('button', { name: 'Import' }).click();
  await dialog.getByLabel('CSV file').setInputFiles({
    name: 'probe2.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(
      `code,name,symbol,decimalPlaces,isActive\r\n` +
        `${codes[0]},E2E import probe one EDITED,,2,true\r\n` +
        `${codes[1]},E2E import probe two,,0,false\r\n`
    ),
  });
  await expect(dialog.getByText('1 to update · 1 unchanged.')).toBeVisible({ timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Import 1 row' }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole('row').filter({ hasText: 'probe one EDITED' }).first()).toBeVisible({
    timeout: 15_000,
  });
  for (const code of codes) {
    await page
      .getByRole('row')
      .filter({ hasText: code })
      .first()
      .getByRole('button', { name: 'Delete' })
      .click();
    await page.getByRole('alertdialog').getByRole('button', { name: /^Delete$/ }).click();
    await expect(page.getByRole('row').filter({ hasText: code })).toHaveCount(0, {
      timeout: 15_000,
    });
  }
});
