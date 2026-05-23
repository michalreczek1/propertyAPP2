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

  const period = options.period || currentPeriodISO();
  const payment = await request.post('/api/payments', {
    data: {
      period,
      tenant_id: tenantData.id,
      unit_id: unitData.id,
      due_day: 10,
      rent_amount: 1234,
      media_amount: 321,
      late_fee_amount: options.lateFeeAmount || 0,
      late_fee_paid: options.lateFeePaid || 0,
      late_fee_manual: options.lateFeeAmount ? 1 : 0,
      total_paid: options.totalPaid ?? (options.status === 'paid' ? 1555 : 0),
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
  await expect(page.getByRole('button', { name: 'AI' })).toHaveCount(0);
  await page.locator('#global-search').fill('Ile wynosi podatek za ten miesiąc?');
  await page.locator('#global-search').press('Enter');
  await expect(page.getByText(/Podatek za/)).toBeVisible();
  await expect(page.getByText('Podstawa')).toBeVisible();
  await expect(page.getByText('Razem')).toBeVisible();
});

test('AI assistant confirms and marks a payment as paid', async ({ page, request }) => {
  const fixture = await createPaymentFixture(request, '__ai_paid');
  try {
    await page.goto('/#platnosci');
    await page.locator('#global-search').fill(`${fixture.name} zapłacił`);
    await page.locator('#global-search').press('Enter');
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
    await page.locator('#global-search').fill(`${fixture.name} wyślij SMS z przypomnieniem`);
    await page.locator('#global-search').press('Enter');
    await expect(page.getByText('Wysłać SMS z przypomnieniem?')).toBeVisible();
    await expect(page.getByText('Tryb testowy')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Wyślij SMS' })).toBeVisible();
  } finally {
    await cleanupPaymentFixture(request, fixture);
  }
});

test('topbar command bar shows tenant late fee report', async ({ page, request }) => {
  const fixture = await createPaymentFixture(request, '__ai_late_fees', { lateFeeAmount: 50, lateFeePaid: 10 });
  try {
    await page.goto('/#dashboard');
    await page.locator('#global-search').fill('zrób zestawienie kar najemców');
    await page.locator('#global-search').press('Enter');
    const result = page.locator('.assistant-result.answer');
    await expect(result).toBeVisible();
    await expect(result).toContainText('Zestawienie kar najemców');
    await expect(result).toContainText(fixture.name);
    await expect(result).toContainText('pozostało');
  } finally {
    await cleanupPaymentFixture(request, fixture);
  }
});

test('topbar command bar answers flexible overdue payment question', async ({ page, request }) => {
  const fixture = await createPaymentFixture(request, '__ai_overdue_question', { status: 'overdue' });
  try {
    await page.goto('/#dashboard');
    await page.locator('#global-search').fill('kto zalega z płatnościami?');
    await page.locator('#global-search').press('Enter');
    const result = page.locator('.assistant-result.answer');
    await expect(result).toBeVisible();
    await expect(result).toContainText('Płatności');
    await expect(result).toContainText(fixture.name);
  } finally {
    await cleanupPaymentFixture(request, fixture);
  }
});

test('topbar command bar answers paid status question without action', async ({ page, request }) => {
  const fixture = await createPaymentFixture(request, '__ai_paid_question', { period: '2026-04', status: 'paid', totalPaid: 1555 });
  try {
    await page.goto('/#dashboard');
    await page.locator('#global-search').fill(`czy ${fixture.name} zapłacił za kwiecień?`);
    await page.locator('#global-search').press('Enter');
    const result = page.locator('.assistant-result.answer');
    await expect(result).toBeVisible();
    await expect(result).toContainText('Tak');
    await expect(result).toContainText('Opłacona');
    await expect(page.locator('#assistant-execute')).toHaveCount(0);
  } finally {
    await cleanupPaymentFixture(request, fixture);
  }
});

test('topbar command bar summarizes tenant payments for a year', async ({ page, request }) => {
  const fixture = await createPaymentFixture(request, '__ai_year_summary', { period: '2026-04', status: 'paid', totalPaid: 1555 });
  try {
    await page.goto('/#dashboard');
    await page.locator('#global-search').fill(`ile w tym roku zapłacił ${fixture.name}`);
    await page.locator('#global-search').press('Enter');
    const result = page.locator('.assistant-result.answer');
    await expect(result).toBeVisible();
    await expect(result).toContainText('Wpłaty:');
    await expect(result).toContainText('zapłacił');
  } finally {
    await cleanupPaymentFixture(request, fixture);
  }
});

test('topbar command bar answers previous-year tenant count by property', async ({ page, request }) => {
  const fixture = await createPaymentFixture(request, '__ai_Chrobrego', { period: '2025-06', status: 'paid', totalPaid: 1555 });
  try {
    await page.goto('/#dashboard');
    await page.locator('#global-search').fill('ilu miałem najemców na Chrobrego w zeszłym roku?');
    await page.locator('#global-search').press('Enter');
    const result = page.locator('.assistant-result.answer');
    await expect(result).toBeVisible();
    await expect(result).toContainText(/Najemcy:/);
    await expect(result).toContainText(/było [1-9]/);
  } finally {
    await cleanupPaymentFixture(request, fixture);
  }
});

test('topbar command bar matches inflected property names', async ({ page }) => {
  await page.goto('/#dashboard');
  await page.locator('#global-search').fill('ilu miałem najemców na Kościelnej w zeszłym roku?');
  await page.locator('#global-search').press('Enter');
  const result = page.locator('.assistant-result.answer');
  await expect(result).toBeVisible();
  await expect(result).toContainText(/Kościelna|Koscielna/);
  await expect(result).not.toContainText('Nie znalazłem nieruchomości');
});

test('topbar command bar summarizes property income by year', async ({ page }) => {
  await page.goto('/#dashboard');
  await page.locator('#global-search').fill('podaj sumę dochodów z chrobrego za 2025 r.');
  await page.locator('#global-search').press('Enter');
  const result = page.locator('.assistant-result.answer');
  await expect(result).toBeVisible();
  await expect(result).toContainText(/Chrobrego/i);
  await expect(result).toContainText(/2025/);
  await expect(result).toContainText(/Wpłaty|przychód|dochód/i);
  await expect(result).not.toContainText('Wynik netto maj 2026');
});

test('mobile topbar keeps AI command bar visible and usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#dashboard');
  const topbar = page.locator('#topbar');
  await expect(topbar).toBeVisible();
  const box = await topbar.boundingBox();
  expect(box).not.toBeNull();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.height).toBeGreaterThan(80);
  expect(box.height).toBeLessThanOrEqual(120);
  const searchWrap = page.locator('.topbar-search');
  const searchBox = await searchWrap.boundingBox();
  expect(searchBox).not.toBeNull();
  expect(searchBox.width).toBeGreaterThan(300);
  expect(searchBox.height).toBeGreaterThan(30);
  const titleBox = await page.locator('.topbar-left').boundingBox();
  const rightBox = await page.locator('#topbar-actions').boundingBox();
  expect(titleBox).toBeNull();
  expect(rightBox).not.toBeNull();
  expect(rightBox.y).toBeGreaterThan(searchBox.y + searchBox.height - 1);
  const actionBoxes = await page.locator('#topbar-actions .tb-btn:visible').evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    })
  );
  for (const actionBox of actionBoxes) {
    expect(actionBox.left).toBeGreaterThanOrEqual(0);
    expect(actionBox.right).toBeLessThanOrEqual(390);
  }
  const search = page.locator('#global-search');
  await expect(search).toBeVisible();
  await expect(search).toHaveCSS('display', /block|inline-block/);
  await search.fill('ile wynosi podatek za ten miesiąc?');
  await search.press('Enter');
  await expect(page.locator('.assistant-result.answer')).toContainText(/Podatek za/);
});

test('topbar command bar navigates to filtered payments', async ({ page }) => {
  await page.goto('/#dashboard');
  await page.locator('#global-search').fill('pokaż tylko zaległości');
  await page.locator('#global-search').press('Enter');
  await expect(page).toHaveURL(/#platnosci$/);
  await expect(page.locator('[data-pf="overdue"]')).toHaveClass(/on/);
});

test('topbar command bar opens report answer popup', async ({ page }) => {
  await page.goto('/#dashboard');
  await page.locator('#global-search').fill('ile zarobiłem netto w tym miesiącu?');
  await page.locator('#global-search').press('Enter');
  const result = page.locator('.assistant-result.answer');
  await expect(result).toBeVisible();
  await expect(result).toContainText(/Wynik netto|Netto właściciel|Dochód netto właściciela/);
});

test('topbar command bar creates a task after confirmation', async ({ page, request }) => {
  await page.goto('/#dashboard');
  await page.locator('#global-search').fill('dodaj zadanie sprawdzić test command bar');
  await page.locator('#global-search').press('Enter');
  await expect(page.getByText('Dodać zadanie?')).toBeVisible();
  await page.locator('#assistant-execute').click();
  await expect(page.getByText(/Dodano zadanie/)).toBeVisible();
  const tasks = await request.get('/api/tasks?status=open');
  expect(tasks.ok()).toBeTruthy();
  const task = (await tasks.json()).find(t => String(t.title || '').includes('sprawdzić test command bar'));
  expect(task).toBeTruthy();
  await request.delete(`/api/tasks/${task.id}`).catch(() => {});
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
