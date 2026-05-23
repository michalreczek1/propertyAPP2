const { test, expect } = require('@playwright/test');

function currentPeriodISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function createPaymentFixture(request, prefix, options = {}) {
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
    data: {
      name: suffix,
      status: 'active',
      phone: options.phone || null,
      sms_consent: options.smsConsent ? 1 : 0,
      sms_disabled: options.smsDisabled ? 1 : 0,
    },
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
      status: options.status || 'pending',
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
  await expect(page.getByText('Raport podatkowy')).toBeVisible();
});

test('AI assistant explains tax from the topbar', async ({ page }) => {
  await page.goto('/#dashboard');
  await page.getByRole('button', { name: 'AI' }).click();
  await expect(page.getByText('AI komendy')).toBeVisible();
  await page.locator('#assistant-message').fill('Ile wynosi podatek za ten miesiąc?');
  await page.getByRole('button', { name: 'Sprawdź' }).click();
  await expect(page.getByText(/Podatek za/)).toBeVisible();
  await expect(page.getByText('Podstawa')).toBeVisible();
  await expect(page.getByText('Razem')).toBeVisible();
});

test('AI assistant confirms and marks a payment as paid', async ({ page, request }) => {
  const fixture = await createPaymentFixture(request, '__ai_paid');
  try {
    await page.goto('/#platnosci');
    await page.getByRole('button', { name: 'AI' }).click();
    await page.locator('#assistant-message').fill(`${fixture.name} zapłacił`);
    await page.getByRole('button', { name: 'Sprawdź' }).click();
    await expect(page.getByText('Oznaczyć płatność jako opłaconą?')).toBeVisible();
    await page.locator('#assistant-execute').click();
    await expect(page.getByText('Oznaczono płatność jako opłaconą')).toBeVisible();
    const payment = await request.get(`/api/payments/${fixture.paymentId}`);
    expect(payment.ok()).toBeTruthy();
    expect((await payment.json()).status).toBe('paid');
  } finally {
    await cleanupPaymentFixture(request, fixture);
  }
});

test('AI assistant shows SMS preview in test mode', async ({ page, request }) => {
  const fixture = await createPaymentFixture(request, '__ai_sms', { phone: '+48 600 000 000', smsConsent: true });
  try {
    const settings = await request.put('/api/notifications/settings', {
      data: {
        enabled: false,
        sender: 'TEST',
        send_time: '09:30',
        overdue_days: 1,
        reminder_enabled: true,
        reminder_days_before_due: 3,
        test_mode: true,
        test_phone: '+48600000000',
        clear_polish: true,
        transactional: false,
      },
    });
    expect(settings.ok()).toBeTruthy();
    await page.goto('/#dashboard');
    await page.getByRole('button', { name: 'AI' }).click();
    await page.locator('#assistant-message').fill(`${fixture.name} wyślij SMS z przypomnieniem`);
    await page.getByRole('button', { name: 'Sprawdź' }).click();
    await expect(page.getByText('Wysłać SMS z przypomnieniem?')).toBeVisible();
    await expect(page.getByText('Tryb testowy')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Wyślij SMS' })).toBeVisible();
  } finally {
    await cleanupPaymentFixture(request, fixture);
  }
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
    await expect(page.locator('#mobile-nav')).toBeVisible();
    await expect(page.locator('#mobile-nav .mobile-nav-item.act')).toContainText('Płatności');

    await page.locator('#mobile-nav .mobile-nav-item[data-view="raporty"]').click();
    await expect(page).toHaveURL(/#raporty$/);
    await expect(page.locator('#mobile-nav .mobile-nav-item.act')).toContainText('Raporty');

    await page.locator('#mobile-nav .mobile-nav-item[data-view="platnosci"]').click();
    await expect(page.getByText(fixture.name).first()).toBeVisible();

    const table = page.locator('table.t-responsive').first();
    await expect(table).toBeVisible();
    await expect(page.locator('td[data-label="Najemca"]').first()).toBeVisible();
    await expect(page.locator('td[data-label="Razem bez kar"]').first()).toBeVisible();
    const metrics = await page.evaluate(() => {
      const content = document.querySelector('.content');
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        contentWidth: content ? content.scrollWidth : 0,
        contentClient: content ? content.clientWidth : 0,
        bodyFont: Number.parseFloat(getComputedStyle(document.body).fontSize),
      };
    });
    expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(metrics.contentWidth).toBeLessThanOrEqual(metrics.contentClient + 1);
    expect(metrics.bodyFont).toBeGreaterThanOrEqual(15);
  } finally {
    await cleanupPaymentFixture(request, fixture);
  }
});

test('payment checkbox keeps the current scroll position', async ({ page, request }) => {
  const fixtures = [];
  try {
    for (let i = 0; i < 14; i += 1) {
      fixtures.push(await createPaymentFixture(request, `__scroll_payment_${i}`));
    }

    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto('/#platnosci');

    const checkbox = page.locator(`input.pay-chk[data-pay-id="${fixtures[fixtures.length - 1].paymentId}"]`);
    await checkbox.scrollIntoViewIfNeeded();

    const before = await page.evaluate(() => document.querySelector('.content')?.scrollTop || 0);
    expect(before).toBeGreaterThan(0);

    await checkbox.click();
    await expect(page.getByText('Zatwierdzono wpłatę')).toBeVisible();

    const after = await page.evaluate(() => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        resolve(document.querySelector('.content')?.scrollTop || 0);
      }));
    }));
    expect(after).toBeGreaterThan(before - 40);
  } finally {
    for (const fixture of fixtures.reverse()) {
      await cleanupPaymentFixture(request, fixture);
    }
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
