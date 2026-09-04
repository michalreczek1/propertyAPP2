# Projekt: aneksy do umów najmu

## Cel

Dodać do PropertyApp pełnoprawną obsługę aneksów do umów najmu. Użytkownik ma móc przechowywać umowę bazową oraz dowolną liczbę aneksów, łatwo odnajdywać je w kartotece najemcy i stosować wynikające z nich zmiany warunków od wskazanej daty.

Nie należy tworzyć nowej umowy, jeśli ten sam najemca jedynie przedłuża najem lub zmienia warunki dotychczasowej umowy aneksem.

## Obecny stan

1. Do jednej umowy można technicznie dołączyć wiele plików.
2. Formularz „Dokumenty umowy” zapisuje każdy dodany plik jako kategorię `umowa` i status `signed`.
3. Globalny formularz dokumentów oferuje tylko kategorie: `umowa`, `faktura`, `protokol`, `inne`.
4. Nie istnieje typ dokumentu `aneks` ani encja opisująca zmiany warunków umowy.
5. Kartoteka najemcy pokazuje listę umów, ale nie pokazuje dokumentów przypisanych do tych umów.
6. Aneks można obecnie dodać tylko jako nieczytelne obejście: drugi dokument typu „umowa” albo dokument „inne”.

Istotne miejsca w kodzie:

- `public/app.js` — `openTenantDetails`, `openContractDocuments`, `uploadDocDialog`;
- `src/routes/contracts.js` — endpointy dokumentów umowy i obieg umowy;
- `src/routes/documents.js` — ogólny upload oraz obieg dokumentów;
- `scripts/migrate.js` — schemat i migracje SQLite;
- `tests/ui-smoke.spec.js` — testy Playwright obiegu umowy.

## Docelowe zachowanie

### Kartoteka najemcy

W szczegółach najemcy należy dodać sekcję „Dokumenty najmu”. Dokumenty powinny być grupowane według umowy.

Przykład:

```text
Umowa: Kościelna 30/21
01.10.2025–30.09.2027 · aktualnie 2 900 zł + media

● Umowa najmu U/2025/017
  podpisana 18.09.2025
  warunki początkowe: do 30.09.2026, czynsz 2 800 zł

● Aneks nr 1/A/2026
  podpisany 20.08.2026, obowiązuje od 01.10.2026
  zmiany: przedłużenie do 30.09.2027, czynsz 2 900 zł

○ Aneks nr 2/A/2027 — szkic
```

Przy każdej umowie powinny być dostępne akcje:

- „Dodaj aneks”;
- „Dodaj inny dokument”;
- „Pobierz” przy każdym pliku;
- „Edytuj” lub „Obieg”;
- „Archiwizuj”; usuwanie wyłącznie przez istniejący kontrolowany mechanizm z potwierdzeniem.

### Formularz „Dodaj aneks”

Pola:

- umowa bazowa — obowiązkowa, domyślnie umowa, z której otwarto formularz;
- numer aneksu — obowiązkowy, z podpowiedzią kolejnego numeru;
- nazwa dokumentu — generowana automatycznie, ale edytowalna;
- data podpisania — opcjonalna dla szkicu, obowiązkowa dla statusu „podpisany”;
- obowiązuje od — obowiązkowe;
- nowa data zakończenia umowy — opcjonalna;
- nowy czynsz — opcjonalny;
- nowa zaliczka na media — opcjonalna;
- nowy dzień płatności — opcjonalny;
- notatka — opcjonalna;
- plik PDF/JPG — opcjonalny dla szkicu, obowiązkowy przy oznaczeniu jako podpisany;
- status: `draft` albo `signed`.

Formularz powinien wymagać co najmniej jednej rzeczywistej zmiany warunków albo notatki wyjaśniającej aneks.

### Zasady biznesowe

1. Aneks zawsze należy do dokładnie jednej umowy.
2. Umowa może mieć dowolną liczbę aneksów.
3. Numer aneksu musi być unikalny w ramach umowy, ale użytkownik może go poprawić.
4. Aneksy są porządkowane według `effective_from`, a przy tej samej dacie według ID.
5. Szkic nie zmienia bieżących warunków umowy.
6. Podpisany aneks zmienia warunki od `effective_from`.
7. Przyszły aneks nie może zmienić wcześniej wygenerowanych płatności.
8. Generowanie płatności dla danego okresu powinno używać ostatnich podpisanych warunków obowiązujących w tym okresie.
9. Podpisanie aneksu z datą wsteczną nie może po cichu nadpisywać istniejących płatności. Interfejs powinien wyświetlić ostrzeżenie i pozostawić istniejące płatności bez zmian, chyba że użytkownik uruchomi osobną, jawną operację korekty.
10. Usunięcie lub archiwizacja dokumentu nie może kasować historii zastosowanych warunków umowy.
11. Aneks przedłużający najem aktualizuje widoczną datę końca aktywnej umowy i alerty o jej wygaśnięciu.
12. Wszystkie operacje zapisu muszą respektować obecne reguły właściciela danych i być rejestrowane w `audit_log`.

## Proponowany model danych

### Kategoria dokumentu

Do listy obsługiwanych kategorii w interfejsie dodać:

```text
aneks
```

Dokument aneksu nadal powinien być zapisany w tabeli `documents` i powiązany z umową:

```text
related_entity_type = 'contract'
related_entity_id = <contract_id>
category = 'aneks'
```

### Nowa tabela `contract_amendments`

Proponowany schemat:

```sql
CREATE TABLE contract_amendments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL,
  document_id INTEGER,
  amendment_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  signed_on DATE,
  effective_from DATE NOT NULL,
  end_date DATE,
  rent REAL,
  media_advance REAL,
  pay_by_day INTEGER,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL,
  UNIQUE(contract_id, amendment_number)
);

CREATE INDEX idx_contract_amendments_contract_effective
  ON contract_amendments(contract_id, effective_from, id);
```

Walidacja:

- `status`: `draft` albo `signed`;
- `pay_by_day`: 1–31;
- kwoty nieujemne;
- `signed_on` wymagane dla `signed`;
- dokument wymagany dla `signed`;
- powiązany dokument musi należeć do tej samej umowy i mieć kategorię `aneks`.

Nie zapisywać wartości `0` jako odpowiednika „bez zmiany”. Brak zmiany reprezentować przez `NULL`.

## Wyznaczanie aktualnych warunków

Należy dodać jedną wspólną funkcję serwisową, np.:

```text
getContractTermsAt(contractId, date)
```

Algorytm:

1. Pobierz warunki bazowe z `contracts`.
2. Pobierz podpisane aneksy z `effective_from <= date`.
3. Posortuj je rosnąco po `effective_from`, następnie po `id`.
4. Nakładaj wyłącznie pola, które w aneksie nie są `NULL`.
5. Zwróć wynikowe: `end_date`, `rent`, `media_advance`, `pay_by_day` oraz ID zastosowanych aneksów.

Ta funkcja powinna być jedynym źródłem warunków używanych podczas generowania nowych płatności. Nie należy rozrzucać logiki aneksów po wielu trasach.

Dla wygody list i alertów można po podpisaniu aneksu synchronizować pola `contracts.end_date`, `contracts.rent`, `contracts.media_advance` i `contracts.pay_by_day` z aktualnym stanem na dziś. Źródłem historii pozostają jednak umowa bazowa oraz aneksy.

Jeżeli synchronizacja pól kontraktu utrudni odtworzenie warunków początkowych, przed wdrożeniem należy dodać pola bazowe albo tabelę historii warunków. Preferowane rozwiązanie: podczas migracji zachować warunki bazowe w `contracts`, a bieżące warunki wyliczać przez serwis i dołączać do odpowiedzi API jako `effective_terms`.

## Proponowane API

### Lista aneksów

```http
GET /api/contracts/:contractId/amendments
```

Zwraca aneksy wraz z podstawowymi informacjami o dokumencie.

### Utworzenie szkicu

```http
POST /api/contracts/:contractId/amendments
Content-Type: multipart/form-data
```

Obsługuje dane formularza oraz opcjonalny plik.

### Edycja aneksu

```http
PUT /api/contracts/:contractId/amendments/:amendmentId
```

Pozwala edytować szkic. Edycja podpisanego aneksu powinna być ograniczona do metadanych, które nie zmieniają skutków finansowych, albo wymagać jawnej korekty z historią zdarzeń.

### Dołączenie lub wymiana pliku

```http
POST /api/contracts/:contractId/amendments/:amendmentId/document
Content-Type: multipart/form-data
```

### Podpisanie / aktywacja

```http
POST /api/contracts/:contractId/amendments/:amendmentId/sign
```

Waliduje plik, datę podpisania i konflikt warunków, a następnie ustawia status `signed`.

### Odpowiedź szczegółów najemcy

`GET /api/tenants/:id` powinien zwracać dla każdej umowy dokument bazowy oraz aneksy albo udostępnić je przez osobny endpoint wywoływany przy otwarciu sekcji. Preferowane jest osobne pobieranie, jeśli lista plików może być duża.

## Zmiany w interfejsie

### `openTenantDetails`

- Dodać sekcję „Dokumenty najmu”.
- Każdą umowę przedstawić jako grupę.
- W grupie pokazać dokument umowy i aneksy jako chronologiczną listę.
- Pokazywać zwięzłe podsumowanie zmian: „do 30.09.2027”, „czynsz 2 900 zł”, „media 350 zł”.
- Dodać „Dodaj aneks” przy każdej umowie.

### `openContractDocuments`

- Zmienić tytuł sekcji na „Umowa i aneksy”.
- Dodać widoczną kategorię każdego dokumentu.
- Rozdzielić akcje „Dodaj podpisaną umowę” i „Dodaj aneks”.
- Nie traktować aneksu jako dokumentu spełniającego wymóg podpisanej umowy bazowej w checkliście aktywacji.

### Globalne dokumenty

- Dodać kategorię „Aneks”.
- Po jej wybraniu wymagać powiązania z umową.
- Preferowany przepływ prowadzi jednak przez kartotekę najemcy lub dokumenty konkretnej umowy, aby użytkownik nie pomylił powiązania.

## Obsługa wielu aneksów

Przykład nałożenia:

```text
Umowa bazowa:
  koniec 30.09.2026, czynsz 2 800, media 300

Aneks 1 od 01.10.2026:
  koniec 30.09.2027, czynsz 2 900

Aneks 2 od 01.01.2027:
  media 350

Warunki na 01.11.2026:
  koniec 30.09.2027, czynsz 2 900, media 300

Warunki na 01.02.2027:
  koniec 30.09.2027, czynsz 2 900, media 350
```

## Kompatybilność i migracja

1. Migracja musi być idempotentna i zostać dodana przez `applyMigration` w `scripts/migrate.js`.
2. Istniejące dokumenty typu `umowa` pozostają bez zmian.
3. Nie należy automatycznie przeklasyfikowywać drugiego i kolejnego dokumentu umowy na aneks, ponieważ nazwa pliku nie jest wystarczającym dowodem.
4. Stare endpointy dokumentów muszą nadal działać.
5. Istniejąca checklista aktywacji umowy nadal wymaga dokumentu kategorii `umowa` ze statusem `signed`.
6. Należy zachować limity plików, kontrolę sygnatur PDF/JPG i zasady uprawnień właściciela.

## Minimalny zakres pierwszej wersji

Pierwsza kompletna wersja powinna obejmować:

1. tabelę `contract_amendments`;
2. kategorię dokumentu `aneks`;
3. tworzenie szkicu i podpisanego aneksu;
4. dowolną liczbę aneksów do jednej umowy;
5. pola: numer, daty, nowy koniec, czynsz, media, dzień płatności, notatka i plik;
6. listę „Umowa i aneksy” w kartotece najemcy oraz w dokumentach umowy;
7. wyznaczanie warunków na datę przy generowaniu nowych płatności;
8. aktualizację alertów wygasania zgodnie z obowiązującym aneksem;
9. testy API, smoke i Playwright;
10. wdrożenie zgodnie ze standardową procedurą projektu po przejściu testów.

## Kryteria akceptacji

### Funkcjonalne

- Użytkownik może dodać aneks do istniejącej umowy bez tworzenia nowej umowy.
- Można dodać co najmniej dwa aneksy do tej samej umowy.
- Aneks jest widoczny przy właściwym najemcy i właściwej umowie.
- Dokument bazowy oraz aneksy są jednoznacznie rozróżnione.
- Szkic aneksu nie zmienia warunków umowy.
- Podpisany aneks obowiązuje od wskazanej daty.
- Aneks przedłużający zmienia datę używaną przez alerty wygasania.
- Aneks zmieniający czynsz lub media wpływa na nowe płatności od właściwego okresu.
- Istniejące płatności historyczne nie zmieniają się automatycznie.
- Aneks nie spełnia wymogu „podpisana umowa” podczas aktywowania nowej umowy.
- Użytkownik nie może powiązać aneksu z cudzą lub niedostępną umową.

### UX

- Z kartoteki najemcy można otworzyć dokument umowy lub aneks maksymalnie dwoma kliknięciami.
- Przycisk „Dodaj aneks” jednoznacznie wskazuje umowę, której dotyczy.
- Na liście widać numer, status, datę obowiązywania i skrót zmian.
- Interfejs działa na desktopie i telefonie bez poziomego przepełnienia całej strony.
- Brak pliku przy szkicu jest czytelnie oznaczony.
- Próba podpisania aneksu bez pliku pokazuje zrozumiały komunikat po polsku.

## Wymagane testy

Testy uruchamiać sekwencyjnie, zgodnie z instrukcjami repozytorium.

### Smoke/API

- utworzenie szkicu bez pliku;
- utworzenie podpisanego aneksu z poprawnym PDF;
- odrzucenie podpisanego aneksu bez pliku;
- odrzucenie niedozwolonego MIME lub niepoprawnej sygnatury;
- dwa aneksy dla jednej umowy;
- konflikt numeru aneksu w jednej umowie;
- ten sam numer do dwóch różnych umów;
- nakładanie częściowych zmian w poprawnej kolejności;
- brak wpływu szkicu na warunki;
- ochrona dostępu między właścicielami;
- zachowanie checklisty podpisanej umowy bazowej.

### Playwright

- otwarcie kartoteki najemcy i sekcji dokumentów;
- dodanie szkicu aneksu;
- dodanie podpisanego aneksu;
- widoczność umowy oraz dwóch aneksów w odpowiedniej kolejności;
- poprawne podsumowanie zmienionych warunków;
- komunikaty walidacyjne;
- widok desktopowy oraz mobilny;
- brak poziomego przepełnienia strony.

### Regresja

Po implementacji uruchomić pełny zestaw projektu, sekwencyjnie:

```powershell
npm run lint
npm run format:check
npm run smoke
npm run test:auth
npm run test:rental-model
npm run test:seed-safety
npm run test:finance
npm run test:development
npm run test:ui
```

## Sugerowana kolejność implementacji

1. Migracja i model danych.
2. Serwis wyznaczania warunków umowy na datę.
3. Endpointy aneksów wraz z autoryzacją i uploadem.
4. Integracja z generowaniem płatności i alertami wygasania.
5. Widok „Umowa i aneksy” oraz formularz.
6. Integracja z kartoteką najemcy.
7. Testy API i regresyjne.
8. Testy Playwright na desktopie i telefonie.
9. Commit po przejściu wszystkich testów.
10. Standardowe wdrożenie na Proxmox i kontrola `/health` oraz podstawowego przepływu na produkcji.

## Poza zakresem pierwszej wersji

- podpis elektroniczny przez zewnętrznego dostawcę;
- automatyczne OCR i odczytywanie warunków z pliku;
- automatyczne modyfikowanie już wystawionych płatności;
- przeklasyfikowanie starych plików na podstawie nazwy;
- generator treści prawnej aneksu.

## Definicja ukończenia

Funkcja jest ukończona, gdy spełnia wszystkie kryteria akceptacji, pełny zestaw testów przechodzi sekwencyjnie, zmiany są zacommitowane, wdrożone na Proxmox zgodnie z procedurą projektu i zweryfikowane na działającej aplikacji.
