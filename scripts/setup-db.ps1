<#
  HRMS - one-time local database bootstrap.

  Creates the application role and database on your existing PostgreSQL server.
  Your PostgreSQL superuser password is read by THIS script only, held in memory
  for the duration of the run, and never written to disk or logged.

  Usage:  npm run db:setup

  Note: deliberately avoids PostgreSQL dollar-quoting ($$) and psql meta-commands
  such as \gexec. Both are painful to escape correctly inside a PowerShell
  here-string, so each step is a plain single-statement query instead.
#>

$ErrorActionPreference = 'Stop'

$AppUser = 'hrms_app'
$AppPass = 'hrms_dev_password'   # local development only - matches .env.example
$AppDb   = 'hrms_dev'

Write-Host ''
Write-Host '=== HRMS local database setup ===' -ForegroundColor Cyan
Write-Host ''

# --- locate psql -----------------------------------------------------------
$psqlCmd = Get-Command psql -ErrorAction SilentlyContinue
if ($psqlCmd) {
  $psqlPath = $psqlCmd.Source
} else {
  $psqlPath = $null
  $roots = Get-ChildItem 'C:\Program Files\PostgreSQL' -Directory -ErrorAction SilentlyContinue |
           Sort-Object Name -Descending
  foreach ($root in $roots) {
    $candidate = Join-Path $root.FullName 'bin\psql.exe'
    if (Test-Path $candidate) { $psqlPath = $candidate; break }
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
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}

# Runs one SQL statement as the superuser against the maintenance database.
function Invoke-Sql {
  param([string]$Sql, [switch]$Quiet)

  $psqlArgs = @('-v', 'ON_ERROR_STOP=1', '-w', '-U', $superUser,
                '-h', '127.0.0.1', '-p', '5432', '-d', 'postgres')
  if ($Quiet) { $psqlArgs += @('-tA') }
  $psqlArgs += @('-c', $Sql)

  $output = & $psqlPath @psqlArgs
  return @{ Code = $LASTEXITCODE; Output = ($output | Out-String).Trim() }
}

try {
  Write-Host ''
  Write-Host 'Checking connection...' -ForegroundColor Cyan

  $probe = Invoke-Sql -Sql 'SELECT 1' -Quiet
  if ($probe.Code -ne 0) {
    Write-Host ''
    Write-Host 'ERROR: could not connect as a superuser.' -ForegroundColor Red
    Write-Host $probe.Output
    Write-Host ''
    Write-Host 'Check that the password is correct and that the PostgreSQL service is running.'
    exit 1
  }

  # --- role ----------------------------------------------------------------
  $roleCheck = Invoke-Sql -Quiet -Sql "SELECT 1 FROM pg_roles WHERE rolname = '$AppUser'"
  if ($roleCheck.Code -ne 0) { Write-Host $roleCheck.Output -ForegroundColor Red; exit 1 }

  if ($roleCheck.Output -eq '1') {
    $result = Invoke-Sql -Sql "ALTER ROLE $AppUser WITH LOGIN CREATEDB PASSWORD '$AppPass'"
    Write-Host "  role     $AppUser (existed - password reset)" -ForegroundColor DarkGray
  } else {
    $result = Invoke-Sql -Sql "CREATE ROLE $AppUser WITH LOGIN CREATEDB PASSWORD '$AppPass'"
    Write-Host "  role     $AppUser (created)" -ForegroundColor DarkGray
  }
  if ($result.Code -ne 0) {
    Write-Host 'ERROR: could not create or alter the role.' -ForegroundColor Red
    Write-Host $result.Output
    exit 1
  }

  # --- database ------------------------------------------------------------
  $dbCheck = Invoke-Sql -Quiet -Sql "SELECT 1 FROM pg_database WHERE datname = '$AppDb'"
  if ($dbCheck.Code -ne 0) { Write-Host $dbCheck.Output -ForegroundColor Red; exit 1 }

  if ($dbCheck.Output -eq '1') {
    Write-Host "  database $AppDb (already existed)" -ForegroundColor DarkGray
  } else {
    # CREATE DATABASE cannot run inside a transaction block, hence its own call.
    $result = Invoke-Sql -Sql "CREATE DATABASE $AppDb OWNER $AppUser"
    if ($result.Code -ne 0) {
      Write-Host 'ERROR: could not create the database.' -ForegroundColor Red
      Write-Host $result.Output
      exit 1
    }
    Write-Host "  database $AppDb (created)" -ForegroundColor DarkGray
  }

  # Prisma needs to create and drop objects in the public schema.
  $null = Invoke-Sql -Sql "GRANT ALL ON DATABASE $AppDb TO $AppUser"

  # --- verify the app role can actually log in -----------------------------
  Write-Host ''
  Write-Host 'Verifying application login...' -ForegroundColor Cyan

  $env:PGPASSWORD = $AppPass
  $verify = & $psqlPath -v ON_ERROR_STOP=1 -w -tA -U $AppUser -h 127.0.0.1 -p 5432 `
                        -d $AppDb -c 'SELECT current_user'
  $verifyCode = $LASTEXITCODE

  if ($verifyCode -ne 0) {
    Write-Host ''
    Write-Host 'ERROR: the application role was created but cannot log in.' -ForegroundColor Red
    Write-Host ($verify | Out-String)
    exit 1
  }

  Write-Host ''
  Write-Host 'Database ready.' -ForegroundColor Green
  Write-Host "  connected as : $(($verify | Out-String).Trim())"
  Write-Host "  database     : $AppDb"
  Write-Host ''
  Write-Host 'Next:  npm run db:migrate' -ForegroundColor Cyan
  Write-Host ''
} finally {
  $env:PGPASSWORD = $null
}
