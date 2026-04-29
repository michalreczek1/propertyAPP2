const { test, expect } = require('@playwright/test');

function currentPeriodISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function createPaymentFixture(request, prefix) {
  const suffix = `${prefix}_${Date.now()}`;
  const property = await request.post('/api/properties', {
    data: { name: suffix, district: 'Test', type: 'mieszkanie' },
  });
  expect(property.ok()).toBeTruthy();
  const propertyData = await property.json();

  const unit = await request.post('/api/units', {
    data: {
      property_id: propertyData.id,
      name: 'Mobile room',
      code: 'M1',
      base_rent: 1234,
      base_media: 321,
      status: 'vacant',
    },
  });
  expect(unit.ok()).toBeTruthy();
  const unitData = await unit.json();

  const tenant = await request.post('/api/tenants', {
    data: { name: suffix, status: 'active' },
  });
  expect(tenant.ok()).toBeTruthy();
  const tenantData = await tenant.json();

  const period = currentPeriodISO();
  const payment = await request.post('/api/payments', {
    data: {
      period,
      tenant_id: tenantData.id,
      unit_id: unitData.id,
      due_day: 10,
      rent_amount: 1234,
      media_amount: 321,
      total_paid: 0,
      status: 'pending',
    },
  });
  expect(payment.ok()).toBeTruthy();
  const paymentData = await payment.json();

  return { name: suffix, propertyId: propertyData.id, tenantId: tenantData.id, paymentId: paymentData.id };
}

async function cleanupPaymentFixture(request, fixture) {
  if (!fixture) return;
  await request.delete(`/api/payments/${fixture.paymentId}`).catch(() => {});
  await request.delete(`/api/tenants/${fixture.tenantId}`).catch(() => {});
  await request.delete(`/api/properties/${fixture.propertyId}`).catch(() => {});
}

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

test('payments table becomes readable cards on phone width', async ({ page, request }) => {
  const fixture = await createPaymentFixture(request, '__mobile_payment');
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#platnosci');
    await expect(page.getByText(fixture.name).first()).toBeVisible();

    const table = page.locator('table.t-responsive').first();
    await expect(table).toBeVisible();
    await expect(page.locator('td[data-label="Najemca"]').first()).toBeVisible();
    await expect(page.locator('td[data-label="Razem"]').first()).toBeVisible();

    const overflow = await page.evaluate(() => {
      const content = document.querySelector('.content');
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        contentWidth: content ? content.scrollWidth : 0,
        contentClient: content ? content.clientWidth : 0,
      };
    });
    expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);
    expect(overflow.contentWidth).toBeLessThanOrEqual(overflow.contentClient + 1);
  } finally {
    await cleanupPaymentFixture(request, fixture);
  }
});

test('tablet views keep large tables inside the app shell', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto('/#raporty');
  await expect(page.getByText('Szczegół per lokal')).toBeVisible();

  const overflow = await page.evaluate(() => {
    const content = document.querySelector('.content');
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      contentWidth: content ? content.scrollWidth : 0,
      contentClient: content ? content.clientWidth : 0,
    };
  });
  expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewportWidth + 1);
  expect(overflow.contentWidth).toBeLessThanOrEqual(overflow.contentClient + 1);
});
