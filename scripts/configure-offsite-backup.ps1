<#
  Interactive NAS + Backblaze B2 configuration for PropertyApp.
  Secrets are prompted privately and sent through SSH stdin only.
#>
[CmdletBinding()]
param(
  [string]$SshHost = 'proxmox',
  [ValidatePattern('^[a-z0-9.-]+$')]
  [string]$B2Endpoint = 's3.eu-central-003.backblazeb2.com',
  [ValidatePattern('^[a-z0-9-]+$')]
  [string]$B2Region = 'eu-central-003',
  [ValidatePattern('^[a-z0-9-]+$')]
  [string]$B2Bucket = 'propertyapp-backups-michal-2026',
  [ValidatePattern('^[A-Za-z0-9]+$')]
  [string]$B2KeyId = '003c40fd4d02ba30000000001'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-PlainText([Security.SecureString]$Value) {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

function To-Base64([string]$Value) {
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Value))
}

Write-Host 'Enter the Backblaze Application Key. It will not be displayed or saved locally.'
$b2Key = ConvertTo-PlainText (Read-Host 'Backblaze Application Key' -AsSecureString)
if ([string]::IsNullOrWhiteSpace($b2Key)) { throw 'Application Key cannot be empty.' }

Write-Host ''
Write-Host 'Create a strong restic repository password and save it in Bitwarden first.'
Write-Host 'Without this password, a backup cannot be restored.'
$resticPassword = ConvertTo-PlainText (Read-Host 'Restic repository password' -AsSecureString)
$resticPasswordConfirmation = ConvertTo-PlainText (Read-Host 'Repeat restic repository password' -AsSecureString)
if ([string]::IsNullOrWhiteSpace($resticPassword) -or $resticPassword -ne $resticPasswordConfirmation) {
  throw 'Restic passwords are empty or do not match.'
}

$template = @'
set -euo pipefail
CONFIG_DIR=/etc/propertyapp-offsite
MOUNT_POINT=/mnt/propertyapp-nas
B2_ENDPOINT_B64='__B2_ENDPOINT__'
B2_REGION_B64='__B2_REGION__'
B2_BUCKET_B64='__B2_BUCKET__'
B2_KEY_ID_B64='__B2_KEY_ID__'
B2_KEY_B64='__B2_KEY__'
RESTIC_PASSWORD_B64='__RESTIC_PASSWORD__'

decode() { printf '%s' "$1" | base64 -d; }
B2_ENDPOINT=$(decode "$B2_ENDPOINT_B64")
B2_REGION=$(decode "$B2_REGION_B64")
B2_BUCKET=$(decode "$B2_BUCKET_B64")
B2_KEY_ID=$(decode "$B2_KEY_ID_B64")
B2_KEY=$(decode "$B2_KEY_B64")
RESTIC_PASSWORD=$(decode "$RESTIC_PASSWORD_B64")

mountpoint -q "$MOUNT_POINT" || { echo 'NAS is not mounted at /mnt/propertyapp-nas' >&2; exit 1; }
test -f "$CONFIG_DIR/nas.credentials" || { echo 'NAS credentials are missing' >&2; exit 1; }

if ! command -v restic >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y restic
fi

install -d -m 0700 "$CONFIG_DIR"
printf '%s' "$RESTIC_PASSWORD" > "$CONFIG_DIR/restic.password"
chmod 0600 "$CONFIG_DIR/restic.password"

cat > "$CONFIG_DIR/nas.env" <<EOF
RESTIC_REPOSITORY=/mnt/propertyapp-nas/propertyapp-restic
RESTIC_PASSWORD_FILE=$CONFIG_DIR/restic.password
EOF
cat > "$CONFIG_DIR/b2.env" <<EOF
RESTIC_REPOSITORY=s3:$B2_ENDPOINT/$B2_BUCKET/propertyapp-restic
RESTIC_PASSWORD_FILE=$CONFIG_DIR/restic.password
AWS_ACCESS_KEY_ID=$B2_KEY_ID
AWS_SECRET_ACCESS_KEY=$B2_KEY
AWS_DEFAULT_REGION=$B2_REGION
EOF
chmod 0600 "$CONFIG_DIR/nas.env" "$CONFIG_DIR/b2.env"

unset B2_KEY RESTIC_PASSWORD
systemctl daemon-reload
systemctl start propertyapp-offsite-backup.service
systemctl start propertyapp-offsite-verify.service
systemctl enable --now propertyapp-offsite-backup.timer propertyapp-offsite-verify.timer
systemctl is-active --quiet propertyapp-offsite-backup.timer
systemctl is-active --quiet propertyapp-offsite-verify.timer
echo 'PropertyApp NAS+B2 backup configured and verified.'
'@

$remoteScript = $template.Replace('__B2_ENDPOINT__', (To-Base64 $B2Endpoint)).Replace('__B2_REGION__', (To-Base64 $B2Region)).Replace('__B2_BUCKET__', (To-Base64 $B2Bucket)).Replace('__B2_KEY_ID__', (To-Base64 $B2KeyId)).Replace('__B2_KEY__', (To-Base64 $b2Key)).Replace('__RESTIC_PASSWORD__', (To-Base64 $resticPassword))

$psi = [Diagnostics.ProcessStartInfo]::new()
$psi.FileName = 'ssh'
$psi.Arguments = "$SshHost bash -s"
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardInputEncoding = [Text.UTF8Encoding]::new($false)
$process = [Diagnostics.Process]::new()
$process.StartInfo = $psi
[void]$process.Start()
$process.StandardInput.Write($remoteScript)
$process.StandardInput.Close()
$stdout = $process.StandardOutput.ReadToEnd()
$stderr = $process.StandardError.ReadToEnd()
$process.WaitForExit()
if ($process.ExitCode -ne 0) { throw "Proxmox configuration failed.`n$stdout`n$stderr" }
Write-Host $stdout
Write-Host 'Done. Secrets are stored only on Proxmox in /etc/propertyapp-offsite (mode 0600).'
