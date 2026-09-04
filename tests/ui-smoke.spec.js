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

  return {
    name: suffix,
    propertyId: propertyData.id,
    unitId: unitData.id,
    tenantId: tenantData.id,
    paymentId: paymentData.id,
  };
}

async function cleanupPaymentFixture(request, fixture) {
  if (!fixture) return;
  await request.delete(`/api/payments/${fixture.paymentId}`).catch(() => {});
  await request.delete(`/api/tenants/${fixture.tenantId}`).catch(() => {});
  if (fixture.unitId) await request.delete(`/api/units/${fixture.unitId}`).catch(() => {});
  await request.delete(`/api/properties/${fixture.propertyId}`).catch(() => {});
}

test('dashboard and expenses render without clipping the app shell', async ({ page, request }) => {
  let fixture = null;
  await page.goto('/#dashboard');
  await expect(page.getByText('Przychód miesiąca')).toBeVisible();
  await expect(page.locator('[onclick]')).toHaveCount(0);
  await expect(page.getByText('Netto właściciel').first()).toBeVisible();
  await expect(page.getByText('AI audyt danych')).toBeVisible();

  const shell = page.locator('.shell');
  const box = await shell.boundingBox();
  expect(box).not.toBeNull();
  expect(box.width).toBeLessThanOrEqual(1440);

  try {
    const property = await request.post('/api/properties', {
      data: { name: `__ui_cost_label_${Date.now()}`, district: 'Test', type: 'mieszkanie' },
    });
    expect(property.ok()).toBeTruthy();
    const propertyData = await property.json();
    const expense = await request.post('/api/expenses', {
      data: {
        property_id: propertyData.id,
        category: 'prad',
        amount: 12,
        date: `${currentPeriodISO()}-01`,
        description: 'Staly koszt Test: prad',
      },
    });
    expect(expense.ok()).toBeTruthy();
    fixture = { propertyId: propertyData.id, expenseId: (await expense.json()).id };

    await page.goto('/#koszty');
    await expect(page.getByText('Obciążenia miesiąca')).toBeVisible();
    await expect(page.getByText('Razem obciążenia')).toBeVisible();
    await expect(page.getByText('Prąd').first()).toBeVisible();
    await expect(page.getByText('Koszt właściciela:')).toHaveCount(0);
    await expect(page.getByText('Staly koszt')).toHaveCount(0);
  } finally {
    if (fixture) {
      await request.delete(`/api/expenses/${fixture.expenseId}`).catch(() => {});
      await request.delete(`/api/properties/${fixture.propertyId}`).catch(() => {});
    }
  }
});

test('reports page exposes consistent finance cards', async ({ page }) => {
  await page.goto('/#raporty');
  await expect(page.getByText('Przychód brutto')).toBeVisible();
  await expect(page.getByText('Łączne koszty')).toBeVisible();
  await expect(page.getByText('Podatek (ryczałt)')).toBeVisible();
  await expect(page.getByText('Raport podatkowy')).toBeVisible();
  await expect(page.getByText(/Raport właścicielski/)).toBeVisible();
  await expect(page.locator('.sc-lbl').filter({ hasText: /^Ściągalność$/ })).toBeVisible();
});

test('bank statement import proposes and confirms a safe payment match', async ({ page, request }) => {
  const fixture = await createPaymentFixture(request, '__bank_match');
  try {
    const period = currentPeriodISO();
    const csv = [
      'Data operacji;Kwota;Waluta;Tytuł;Kontrahent;Rachunek',
      `${period}-12;1555,00;PLN;Czynsz ${period} M1;${fixture.name};PL001234`,
    ].join('\n');
    const imported = await request.post('/api/banking/import', {
      multipart: {
        bank_name: 'Bank Playwright',
        file: { name: 'statement.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) },
      },
    });
    expect(imported.ok()).toBeTruthy();
    expect((await imported.json()).imported).toBe(1);

    await page.goto('/#banking');
    const row = page.locator('.bank-row').filter({ hasText: fixture.name }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('100%');
    await row.getByRole('button', { name: 'Zatwierdź' }).click();
    await page.getByRole('button', { name: 'Tak, kontynuuj' }).click();
    await expect(page.getByText('Wpłata uzgodniona')).toBeVisible();
    const payment = await request.get(`/api/payments/${fixture.paymentId}`);
    expect((await payment.json()).status).toBe('paid');
    const banking = await request.get('/api/banking?status=matched');
    const transaction = (await banking.json()).transactions.find((item) => item.title.includes('Czynsz'));
    await request.post(`/api/banking/${transaction.id}/undo`, { data: {} });
  } finally {
    await cleanupPaymentFixture(request, fixture);
  }
});

test('contract workflow moves a draft through controlled stages', async ({ page, request }) => {
  const fixture = await createPaymentFixture(request, '__contract_flow');
  let contractId = null;
  let documentId = null;
  try {
    const created = await request.post('/api/contracts', {
      data: {
        tenant_id: fixture.tenantId,
        unit_id: fixture.unitId,
        start_date: `${currentPeriodISO()}-01`,
        end_date: null,
        rent: 1234,
        media_advance: 321,
        deposit: 1500,
        pay_by_day: 10,
        status: 'planned',
      },
    });
    expect(created.ok()).toBeTruthy();
    contractId = (await created.json()).id;
    await page.goto('/#umowy');
    const row = page.locator('tbody tr').filter({ hasText: fixture.name }).first();
    await expect(row).toContainText('Szkic');
    await row.getByRole('button', { name: 'Obieg' }).click();
    await expect(page.getByText('Obieg umowy · Szkic')).toBeVisible();
    await page.getByRole('button', { name: 'Kompletowanie dokumentów' }).click();
    await expect(page.getByText('Etap umowy: Kompletowanie dokumentów')).toBeVisible();
    const workflow = await request.get(`/api/contracts/${contractId}/workflow`);
    expect((await workflow.json()).stage).toBe('awaiting_documents');

    const uploaded = await request.post(`/api/contracts/${contractId}/documents`, {
      multipart: {
        name: 'Podpisana umowa workflow',
        file: { name: 'signed.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') },
      },
    });
    expect(uploaded.ok()).toBeTruthy();
    documentId = (await uploaded.json()).id;
    const toSignature = await request.post(`/api/contracts/${contractId}/workflow`, {
      data: { stage: 'awaiting_signature' },
    });
    expect(toSignature.ok()).toBeTruthy();
    const activated = await request.post(`/api/contracts/${contractId}/workflow`, {
      data: { stage: 'active' },
    });
    expect(activated.ok()).toBeTruthy();
    expect((await activated.json()).stage).toBe('active');
  } finally {
    if (documentId) await request.delete(`/api/documents/${documentId}`).catch(() => {});
    if (contractId) await request.delete(`/api/contracts/${contractId}`).catch(() => {});
    await cleanupPaymentFixture(request, fixture);
  }
});

test('tenant documents group a base contract and amendments on desktop and mobile', async ({
  page,
  request,
}) => {
  const fixture = await createPaymentFixture(request, '__contract_amendments_ui');
  const year = new Date().getFullYear();
  const today = new Date().toISOString().slice(0, 10);
  let contractId = null;
  const documentIds = [];
  try {
    const created = await request.post('/api/contracts', {
      data: {
        tenant_id: fixture.tenantId,
        unit_id: fixture.unitId,
        start_date: `${currentPeriodISO()}-01`,
        end_date: `${year + 1}-12-31`,
        rent: 1234,
        media_advance: 321,
        deposit: 1500,
        pay_by_day: 10,
        status: 'active',
      },
    });
    expect(created.ok()).toBeTruthy();
    contractId = (await created.json()).id;

    const base = await request.post(`/api/contracts/${contractId}/documents`, {
      multipart: {
        name: 'Umowa bazowa Playwright',
        file: { name: 'base.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') },
      },
    });
    expect(base.ok()).toBeTruthy();
    documentIds.push((await base.json()).id);

    const signed = await request.post(`/api/contracts/${contractId}/amendments`, {
      multipart: {
        amendment_number: `1/A/${year}`,
        signed_date: today,
        effective_date: today,
        rent: '1300',
        status: 'signed',
        file: {
          name: 'signed-annex.pdf',
          mimeType: 'application/pdf',
          buffer: Buffer.from('%PDF-1.4\n%%EOF'),
        },
      },
    });
    expect(signed.ok()).toBeTruthy();
    documentIds.push((await signed.json()).document_id);

    await page.goto('/#najemcy');
    await page.locator('#ten-q').fill(fixture.name);
    const row = page.locator('.tenant-row:not(.tenant-row-head)').filter({ hasText: fixture.name }).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByRole('button', { name: 'Dokumenty najmu' })).toBeVisible();
    await expect(page.getByText('Umowa i aneksy')).toBeVisible();
    await expect(page.getByText('Umowa najmu').first()).toBeVisible();
    await expect(page.getByText(`Aneks nr 1/A/${year}`, { exact: true })).toBeVisible();
    await expect(page.getByText('Obowiązuje').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dodawanie aneksu' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Dodaj aneks' })).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Pobierz' }).first()).toHaveClass(/rental-document-action/);
    await expect(page.getByRole('button', { name: 'Obieg' }).first()).toHaveClass(/rental-document-action/);
    await page.getByRole('button', { name: 'Dodaj aneks' }).click();
    await expect(page.getByText('Nowy aneks do umowy')).toBeVisible();
    await expect(page.locator('#amendment-contract')).toBeVisible();
    await expect(page.locator('#amendment-contract')).not.toHaveJSProperty('tagName', 'SELECT');
    await expect(page.getByRole('button', { name: 'Zapisz szkic' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Dodaj podpisany aneks' })).toBeVisible();

    await page.locator('#amendment-number').fill(`2/A/${year}`);
    await page.locator('#amendment-notes').fill('Szkic aneksu dodany przez Playwright');
    await page.getByRole('button', { name: 'Dodaj podpisany aneks' }).click();
    await expect(page.getByText('Podpisany aneks wymaga pliku PDF, JPG albo PNG.')).toBeVisible();
    await page.getByRole('button', { name: 'Zapisz szkic' }).click();
    await expect(page.getByText('Zapisano szkic aneksu')).toBeVisible();
    await expect(page.getByText(`Aneks nr 2/A/${year}`, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Dołącz i podpisz' }).click();
    await expect(page.getByText('Podpisz szkic aneksu')).toBeVisible();
    await page.locator('#amendment-sign-file').setInputFiles({
      name: 'draft-to-signed.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n%%EOF'),
    });
    await page.getByRole('button', { name: 'Podpisz aneks' }).click();
    await expect(page.getByText('Aneks został podpisany')).toBeVisible();
    await expect(page.getByText(`Aneks nr 2/A/${year}`, { exact: true })).toBeVisible();
    await expect(page.getByText('Obowiązuje').first()).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    const metrics = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      contentWidth: document.querySelector('.content')?.scrollWidth || 0,
      contentClient: document.querySelector('.content')?.clientWidth || 0,
    }));
    expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
    expect(metrics.contentWidth).toBeLessThanOrEqual(metrics.contentClient + 1);
  } finally {
    if (contractId) {
      const documents = await request.get(`/api/contracts/${contractId}/documents`).catch(() => null);
      if (documents?.ok()) {
        for (const document of await documents.json()) documentIds.push(document.id);
      }
    }
    for (const documentId of [...new Set(documentIds)].filter(Boolean)) {
      await request.delete(`/api/documents/${documentId}`).catch(() => {});
    }
    if (contractId) await request.delete(`/api/contracts/${contractId}`).catch(() => {});
    await cleanupPaymentFixture(request, fixture);
  }
});

test('mortgage owner cost can be edited from expenses', async ({ page, request }) => {
  const period = currentPeriodISO();
  const propertyName = `__ui_mortgage_${Date.now()}`;
  let propertyId = null;
  try {
    const property = await request.post('/api/properties', {
      data: { name: propertyName, district: 'Test', type: 'mieszkanie' },
    });
    expect(property.ok()).toBeTruthy();
    propertyId = (await property.json()).id;

    const seed = await request.put('/api/settings/owner-costs/mortgage', {
      data: { property_id: propertyId, valid_from_period: period, amount: 111.11 },
    });
    expect(seed.ok()).toBeTruthy();

    await page.goto('/#koszty');
    const row = page
      .locator('tbody tr')
      .filter({ hasText: propertyName })
      .filter({ hasText: 'Rata kredytu hipotecznego' })
      .first();
    await expect(row).toBeVisible();
    await row.getByTitle('Edytuj ratę kredytu').click();
    await expect(page.getByText('Edytuj ratę kredytu')).toBeVisible();
    await page.locator('#modal-root input[name="amount"]').fill('222.22');
    await page.locator('#m-submit').click();
    await expect(row).toContainText('222,22 zł');

    const ownerCosts = await request.get(`/api/settings/owner-costs?period=${period}`);
    expect(ownerCosts.ok()).toBeTruthy();
    const mortgage = (await ownerCosts.json()).mortgages.find((item) => item.property_id === propertyId);
    expect(Number(mortgage.amount)).toBe(222.22);
  } finally {
    if (propertyId) await request.delete(`/api/properties/${propertyId}`).catch(() => {});
  }
});

test('AI assistant explains tax from the topbar', async ({ page }) => {
  await page.goto('/#dashboard');
  await expect(page.getByRole('button', { name: 'AI', exact: true })).toHaveCount(0);
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
  const fixture = await createPaymentFixture(request, '__ai_sms', {
    phone: '+48 600 000 000',
    smsConsent: true,
  });
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

test('tenant detail exposes manual SMS reminder button', async ({ page, request }) => {
  const fixture = await createPaymentFixture(request, '__tenant_sms', {
    phone: '+48 600 000 000',
    smsConsent: true,
  });
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

    await page.goto('/#najemcy');
    await page.locator('#ten-q').fill(fixture.name);
    const row = page.locator('.tenant-row:not(.tenant-row-head)').filter({ hasText: fixture.name }).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByRole('button', { name: 'Wyślij SMS z przypomnieniem' })).toBeVisible();
    await page.getByRole('button', { name: 'Wyślij SMS z przypomnieniem' }).click();
    await expect(page.getByText('Wysłać SMS z przypomnieniem?')).toBeVisible();
    await expect(page.getByText('Tryb testowy jest włączony')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Wyślij SMS' })).toBeVisible();
  } finally {
    await cleanupPaymentFixture(request, fixture);
  }
});

test('topbar command bar shows tenant late fee report', async ({ page, request }) => {
  const fixture = await createPaymentFixture(request, '__ai_late_fees', {
    lateFeeAmount: 50,
    lateFeePaid: 10,
  });
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
  const fixture = await createPaymentFixture(request, '__ai_overdue_question', {
    period: '2025-09',
    status: 'overdue',
  });
  try {
    await page.goto('/#dashboard');
    await page.locator('#global-search').fill('kto zalega z płatnościami?');
    await page.locator('#global-search').press('Enter');
    const result = page.locator('.assistant-result.answer');
    await expect(result).toBeVisible();
    await expect(result).toContainText('Zaległości');
    await expect(result).toContainText(fixture.name);
    await page.locator('.assistant-item').filter({ hasText: fixture.name }).click();
    await expect(page).toHaveURL(/#platnosci$/);
    await expect(page.locator('#pay-q')).toHaveValue(fixture.name);
    await expect(page.locator('[data-pf="overdue"]')).toHaveClass(/on/);
    await expect(page.locator('#period-btn')).toContainText(/wrzesień 2025/i);
    await expect(page.getByText(fixture.name).first()).toBeVisible();
  } finally {
    await cleanupPaymentFixture(request, fixture);
  }
});

test('topbar command bar answers paid status question without action', async ({ page, request }) => {
  const fixture = await createPaymentFixture(request, '__ai_paid_question', {
    period: '2026-04',
    status: 'paid',
    totalPaid: 1555,
  });
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
  const fixture = await createPaymentFixture(request, '__ai_year_summary', {
    period: '2026-04',
    status: 'paid',
    totalPaid: 1555,
  });
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
  const fixture = await createPaymentFixture(request, '__ai_Chrobrego', {
    period: '2025-06',
    status: 'paid',
    totalPaid: 1555,
  });
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

test('topbar command bar explains finance result drivers', async ({ page }) => {
  await page.goto('/#dashboard');
  await page.locator('#global-search').fill('dlaczego wynik w maju 2026?');
  await page.locator('#global-search').press('Enter');
  const result = page.locator('.assistant-result.answer');
  await expect(result).toBeVisible();
  await expect(result).toContainText('Wyjaśnienie wyniku');
  await expect(result).toContainText('Główne czynniki');
  await expect(result).toContainText('Marża');
});

test('topbar command bar explains margin in plain language', async ({ page, request }) => {
  const fixture = await createPaymentFixture(request, '__ai_margin_plain', {
    period: '2026-05',
    status: 'paid',
    totalPaid: 1555,
  });
  try {
    await page.goto('/#dashboard');
    await page.locator('#global-search').fill(`jak liczysz marżę dla ${fixture.name} za maj 2026?`);
    await page.locator('#global-search').press('Enter');
    const result = page.locator('.assistant-result.answer');
    await expect(result).toBeVisible();
    await expect(result).toContainText('Marża netto');
    await expect(result).toContainText('z każdej 1 zł');
    await expect(result).toContainText('Rachunek:');
  } finally {
    await cleanupPaymentFixture(request, fixture);
  }
});

test('topbar command bar shows range data quality audit', async ({ page }) => {
  await page.goto('/#dashboard');
  await page.locator('#global-search').fill('sprawdź czy dane są kompletne za 2026 r.');
  await page.locator('#global-search').press('Enter');
  const result = page.locator('.assistant-result');
  await expect(result).toBeVisible();
  await expect(result).toContainText('Kontrola jakości danych');
  await expect(result).toContainText('Nieruchomości z brakującymi miesiącami wpływów');
});

test('topbar command bar renders annual AI summary', async ({ page }) => {
  await page.goto('/#dashboard');
  await page.locator('#global-search').fill('zrób podsumowanie 2026');
  await page.locator('#global-search').press('Enter');
  const result = page.locator('.assistant-result.answer');
  await expect(result).toBeVisible();
  await expect(result).toContainText('Podsumowanie');
  await expect(result).toContainText('marża');
});

test('topbar command bar previews audit task creation', async ({ page }) => {
  await page.goto('/#dashboard');
  await page.locator('#global-search').fill('utwórz zadania z audytu 2026');
  await page.locator('#global-search').press('Enter');
  const result = page.locator('.assistant-result.ready');
  await expect(result).toBeVisible();
  await expect(result).toContainText('Utworzyć zadania z audytu?');
  await expect(page.getByRole('button', { name: 'Dodaj zadania' })).toBeVisible();
});

test('mobile topbar keeps AI command bar visible and usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#dashboard');
  const topbar = page.locator('#topbar');
  await expect(topbar).toBeVisible();
  const box = await topbar.boundingBox();
  expect(box).not.toBeNull();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.height).toBeGreaterThan(50);
  expect(box.height).toBeLessThanOrEqual(78);
  const searchWrap = page.locator('.topbar-search');
  const searchBox = await searchWrap.boundingBox();
  expect(searchBox).not.toBeNull();
  expect(searchBox.width).toBeGreaterThan(300);
  expect(searchBox.height).toBeGreaterThan(30);
  const titleBox = await page.locator('.topbar-left').boundingBox();
  const rightBox = await page.locator('#topbar-actions').boundingBox();
  expect(titleBox).toBeNull();
  expect(rightBox).not.toBeNull();
  expect(Math.abs(rightBox.y - searchBox.y)).toBeLessThanOrEqual(8);
  const actionBoxes = await page.locator('#topbar-actions .tb-btn:visible').evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    }),
  );
  for (const actionBox of actionBoxes) {
    expect(actionBox.left).toBeGreaterThanOrEqual(0);
    expect(actionBox.right).toBeLessThanOrEqual(390);
  }
  const search = page.locator('#global-search');
  await expect(search).toBeVisible();
  await expect(search).toHaveCSS('display', /block|inline-block/);
  await expect(page.locator('#voice-command')).toBeVisible();
  await search.fill('ile wynosi podatek za ten miesiąc?');
  await search.press('Enter');
  await expect(page.locator('.assistant-result.answer')).toContainText(/Podatek za/);
});

test('AI voice dictation fills command bar on desktop and mobile', async ({ page }) => {
  await page.addInitScript(() => {
    class FakeSpeechRecognition {
      constructor() {
        this.lang = '';
        this.continuous = false;
        this.interimResults = false;
        this.maxAlternatives = 1;
      }
      start() {
        this.onstart && this.onstart();
        setTimeout(() => {
          const result = [{ transcript: 'kto zalega z płatnościami' }];
          result.isFinal = true;
          this.onresult && this.onresult({ resultIndex: 0, results: [result] });
          this.onend && this.onend();
        }, 10);
      }
      stop() {
        this.onend && this.onend();
      }
    }
    window.SpeechRecognition = FakeSpeechRecognition;
    window.webkitSpeechRecognition = FakeSpeechRecognition;
  });

  await page.goto('/#dashboard');
  await page.locator('#voice-command').click();
  await expect(page.locator('#global-search')).toHaveValue('kto zalega z płatnościami');
  await expect(page.locator('#voice-command')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.assistant-result')).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#dashboard');
  await expect(page.locator('#voice-command')).toBeVisible();
  await page.locator('#voice-command').click();
  await expect(page.locator('#global-search')).toHaveValue('kto zalega z płatnościami');
  await expect(page.locator('.assistant-result')).toHaveCount(0);
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

test('AI result popup view and close buttons work', async ({ page }) => {
  await page.goto('/#dashboard');
  await page.locator('#global-search').fill('ile zarobiłem netto w tym miesiącu?');
  await page.locator('#global-search').press('Enter');
  await expect(page.locator('.assistant-result.answer')).toBeVisible();
  await expect(page.locator('#assistant-navigate')).toBeVisible();
  await page.locator('#assistant-navigate').click();
  await expect(page).toHaveURL(/#raporty$/);
  await expect(page.locator('#modal-root .modal')).toHaveCount(0);

  await page.locator('#global-search').fill('zrób podsumowanie 2026');
  await page.locator('#global-search').press('Enter');
  await expect(page.locator('.assistant-result.answer')).toBeVisible();
  await page.locator('#m-close').click();
  await expect(page.locator('#modal-root .modal')).toHaveCount(0);
});

test('topbar command bar answers unit ranking', async ({ page }) => {
  await page.goto('/#dashboard');
  await page.locator('#global-search').fill('który pokój przynosi najwięcej w tym roku?');
  await page.locator('#global-search').press('Enter');
  const result = page.locator('.assistant-result.answer');
  await expect(result).toBeVisible();
  await expect(result).toContainText(/Ranking lokali|Najwyżej/);
});

test('topbar command bar answers overdue payments question', async ({ page, request }) => {
  const fixture = await createPaymentFixture(request, '__ui_ai_zalega', { status: 'overdue' });
  try {
    await page.goto('/#dashboard');
    await page.locator('#global-search').fill('kto zalega z płatnościami?');
    await page.locator('#global-search').press('Enter');
    const result = page.locator('.assistant-result.answer');
    await expect(result).toBeVisible();
    await expect(result).toContainText(/Zaległości|zaległ/);
    await expect(page.getByText(fixture.name).first()).toBeVisible();
  } finally {
    await request.delete(`/api/payments/${fixture.paymentId}`).catch(() => {});
    await request.delete(`/api/tenants/${fixture.tenantId}`).catch(() => {});
    await request.delete(`/api/units/${fixture.unitId}`).catch(() => {});
    await request.delete(`/api/properties/${fixture.propertyId}`).catch(() => {});
  }
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
  const task = (await tasks.json()).find((t) => String(t.title || '').includes('sprawdzić test command bar'));
  expect(task).toBeTruthy();
  await request.delete(`/api/tasks/${task.id}`).catch(() => {});
});

test('settings exposes guarded excel import controls', async ({ page }) => {
  await page.goto('/#ustawienia');
  await expect(page.getByText('Import danych z Excela')).toBeVisible();
  await expect(page.getByText('AI aliasy')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dodaj alias' })).toBeVisible();
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

    await expect(page.locator('#mobile-nav .mobile-nav-item')).toHaveCount(5);
    await page.locator('#mobile-nav [data-more]').click();
    await page.getByRole('button', { name: /Raport właścicielski/ }).click();
    await expect(page).toHaveURL(/#raporty$/);
    await expect(page.locator('#mobile-nav [data-more]')).toHaveClass(/act/);

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

test('mobile navigation and automation center prioritize frequent actions', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#dashboard');
  const items = page.locator('#mobile-nav .mobile-nav-item');
  await expect(items).toHaveCount(5);
  await expect(items.nth(0)).toContainText('Dashboard');
  await expect(items.nth(1)).toContainText('Płatności');
  await expect(items.nth(2)).toContainText('Bank');
  await expect(items.nth(4)).toContainText('Więcej');

  await items.nth(4).click();
  await expect(page.locator('.mobile-more-modal')).toBeVisible();
  await page.getByRole('button', { name: /Ustawienia i AI/ }).click();
  await expect(page).toHaveURL(/#ustawienia$/);
  await expect(page.getByText('Bezpieczne automatyzacje AI')).toBeVisible();
  await expect(page.getByText('biała lista akcji')).toBeVisible();

  const metrics = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    topbarHeight: document.querySelector('#topbar')?.getBoundingClientRect().height || 0,
  }));
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.topbarHeight).toBeLessThanOrEqual(78);
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

    const after = await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              resolve(document.querySelector('.content')?.scrollTop || 0);
            }),
          );
        }),
    );
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

test('property deletion is safe for a name containing quotes and HTML', async ({ page, request }) => {
  const name = `__xss_property_${Date.now()} \" onmouseover=\"window.__xssTriggered=true\" <img>`;
  const created = await request.post('/api/properties', {
    data: { name, district: 'Security', type: 'mieszkanie' },
  });
  expect(created.ok()).toBeTruthy();
  const property = await created.json();
  try {
    await page.addInitScript(() => {
      window.__xssTriggered = false;
    });
    await page.goto('/#nieruchomosci');
    const card = page.locator('.gc').filter({ hasText: name }).first();
    await expect(card).toBeVisible();
    expect(
      await card.locator('button.icon-btn.danger').evaluate((button) => button.hasAttribute('onclick')),
    ).toBe(false);
    const injectedHandlers = await page.locator('[onmouseover]').count();
    expect(injectedHandlers).toBe(0);
    expect(await page.evaluate(() => window.__xssTriggered)).toBe(false);

    await card.locator('button.icon-btn.danger').click();
    await expect(page.getByText('Usuń nieruchomość')).toBeVisible();
    await page.getByRole('button', { name: 'Tak, kontynuuj' }).click();
    await expect.poll(async () => (await request.get(`/api/properties/${property.id}`)).status()).toBe(404);
  } finally {
    await request.delete(`/api/properties/${property.id}`).catch(() => {});
  }
});
