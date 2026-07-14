# Retencja danych — PropertyApp

Status: polityka operacyjna do zatwierdzenia przez właściciela danych. Nie jest poradą prawną.

| Dane | Domyślna retencja techniczna | Konfiguracja |
|---|---:|---|
| Zapytania i odpowiedzi AI | 90 dni | `AI_QUERY_RETENTION_DAYS` |
| Tokeny jednorazowych akcji AI | 2 dni | stała aplikacji |
| Nieudane próby logowania | do końca okna blokady | automatyczne czyszczenie |
| Rejestr audytowy zmian | 365 dni | `AUDIT_LOG_RETENTION_DAYS` |
| Backupy restic | 14 dziennych, 8 tygodniowych, 12 miesięcznych | usługa offsite |

Dokumenty najmu, dane najemców i rozliczenia nie są automatycznie usuwane. Przed ustaleniem ich okresu przechowywania właściciel powinien zatwierdzić wymogi księgowe i RODO. Po zatwierdzeniu należy uzupełnić ten dokument oraz zmienne środowiskowe na produkcji.
