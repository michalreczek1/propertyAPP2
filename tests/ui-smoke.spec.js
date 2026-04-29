const { test, expect } = require('@playwright/test');

test('dashboard and expenses render without clipping the app shell', async ({ page }) => {
  await page.goto('/#dashboard');
  await expect(page.getByText('Przychód miesiąca')).toBeVisible();
  await expect(page.getByText('Netto właściciel').first()).toBeVisible();

  const shell = page.locator('.shell');
  const box = await shell.boundingBox();
  expect(box).not.toBeNull();
  expect(box.width).toBeLessThanOrEqual(1440);

  await page.goto('/#koszty');
  await expect(page.getByText('Obciążenia miesiąca')).toBeVisible();
  await expect(page.getByText('Razem obciążenia')).toBeVisible();
});

test('reports page exposes consistent finance cards', async ({ page }) => {
  await page.goto('/#raporty');
  await expect(page.getByText('Przychód brutto')).toBeVisible();
  await expect(page.getByText('Łączne koszty')).toBeVisible();
  await expect(page.getByText('Podatek (ryczałt)')).toBeVisible();
});

test('settings exposes guarded excel import controls', async ({ page }) => {
  await page.goto('/#ustawienia');
  await expect(page.getByText('Import danych z Excela')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sprawdź import' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Importuj zapis' })).toBeDisabled();
});
