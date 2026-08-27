<#
  HRMS - one-time local database bootstrap.

  Creates the application role and database on your existing PostgreSQL server.
  Your PostgreSQL superuser password is read by THIS script only, held in memory
  for the duration of the run, and never written to disk or logged.

  Usage:  npm run db:setup
#>

$ErrorActionPreference = 'Stop'

$AppUser = 'hrms_app'
$AppPass = 'hrms_dev_password'   # local development only - matches .env.example
$AppDb   = 'hrms_dev'

Write-Host ''
Write-Host '=== HRMS local database setup ===' -ForegroundColor Cyan
Write-Host ''

# --- locate psql -----------------------------------------------------------
$psql = (Get-Command psql -ErrorAction SilentlyContinue)
if ($psql) {
  $psqlPath = $psql.Source
} else {
  $candidates = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
                Sort-Object Name -Descending
  $psqlPath = $null
  foreach ($c in $candidates) {
    $try = Join-Path $c.FullName 'bin\psql.exe'
    if (Test-Path $try) { $psqlPath = $try; break }
  }
}

if (-not $psqlPath) {
  Write-Host 'ERROR: psql.exe not found.' -ForegroundColor Red
  Write-Host 'Install PostgreSQL or add its bin folder to PATH, then re-run.'
  exit 1
}
Write-Host "Using: $psqlPath" -ForegroundColor DarkGray

# --- superuser credentials -------------------------------------------------
$superUser = Read-Host 'PostgreSQL superuser name [postgres]'
if ([string]::IsNullOrWhiteSpace($superUser)) { $superUser = 'postgres' }

$secure = Read-Host "Password for '$superUser'" -AsSecureString
$bstr   = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

# --- idempotent provisioning ----------------------------------------------
$sql = @"
DO
\$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$AppUser') THEN
    CREATE ROLE $AppUser LOGIN PASSWORD '$AppPass' CREATEDB;
    RAISE NOTICE 'role $AppUser created';
  ELSE
    ALTER ROLE $AppUser LOGIN PASSWORD '$AppPass' CREATEDB;
    RAISE NOTICE 'role $AppUser already existed - password reset';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE $AppDb OWNER $AppUser'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$AppDb')\gexec
"@

Write-Host ''
Write-Host 'Provisioning role and database...' -ForegroundColor Cyan

$tmp = Join-Path $env:TEMP ("hrms-setup-{0}.sql" -f [guid]::NewGuid())
Set-Content -Path $tmp -Value $sql -Encoding utf8
try {
  & $psqlPath -v ON_ERROR_STOP=1 -w -U $superUser -h 127.0.0.1 -p 5432 -d postgres -f $tmp
  $code = $LASTEXITCODE
} finally {
  Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  $env:PGPASSWORD = $null
}

if ($code -ne 0) {
  Write-Host ''
  Write-Host 'ERROR: provisioning failed. Check the superuser password and that the' -ForegroundColor Red
  Write-Host 'PostgreSQL service (postgresql-x64-18) is running.' -ForegroundColor Red
  exit $code
}

Write-Host ''
Write-Host 'Database ready.' -ForegroundColor Green
Write-Host "  database : $AppDb"
Write-Host "  role     : $AppUser"
Write-Host ''
Write-Host 'Next:  npm run db:migrate  &&  npm run db:seed' -ForegroundColor Cyan
Write-Host ''
