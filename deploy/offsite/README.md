# PropertyApp: NAS + Backblaze B2 przez restic

Skrypt `propertyapp-offsite-backup` działa na hoście Proxmox, nie w CT aplikacji.
Najpierw tworzy zweryfikowany backup SQLite online w CT109, a następnie zapisuje go w dwóch niezależnych, zaszyfrowanych repozytoriach restic: na NAS oraz w B2.

## Wymagane dane

1. Na NAS utwórz konto `propertyapp-backup` z prawem odczytu/zapisu wyłącznie do folderu `rodzina/PropertyApp-backups`.
2. W Backblaze B2 utwórz prywatny bucket oraz klucz **S3-compatible application key** ograniczony tylko do tego bucketa. Nie używaj klucza głównego konta.
3. Zapisz osobno dwa losowe hasła repozytoriów restic. Ich utrata uniemożliwia odtworzenie danych.

## Konfiguracja na hoście Proxmox

Po otrzymaniu danych dostępowych agent tworzy pliki `0600`:

- `/etc/propertyapp-offsite/nas.credentials`
- `/etc/propertyapp-offsite/nas.env`
- `/etc/propertyapp-offsite/nas.password`
- `/etc/propertyapp-offsite/b2.env`
- `/etc/propertyapp-offsite/b2.password`

Udział NAS jest montowany jako CIFS pod `/mnt/propertyapp-nas` przez wpis `/etc/fstab` wykorzystujący `nas.credentials`.

Następnie instalowany jest pakiet `restic` i aktywowane są timery:

- codzienny backup o 04:15 (z losowym opóźnieniem do 20 minut),
- cotygodniowe `restic check` i rzeczywiste odtworzenie bazy z obu repozytoriów.

Retencja dla każdego repozytorium: 14 dziennych, 8 tygodniowych i 12 miesięcznych snapshotów.
