# HRM Raw RR dashboard - installer for Windows 10 (1709+) / 11.
#
#   .\install.ps1            create .venv and install the requirements
#   .\install.ps1 -Force     recreate .venv from scratch
#
# Or just double-click install.bat. Afterwards start the app with run.bat
# (any app.py options pass through, e.g. run.bat --demo).
param([switch]$Force)

$ErrorActionPreference = "Stop"
$MinVersion = [version]"3.10"

Set-Location -LiteralPath $PSScriptRoot
$Venv = Join-Path $PSScriptRoot ".venv"
$VenvPy = Join-Path $Venv "Scripts\python.exe"

function Info($msg) { Write-Host "==> $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "warning: $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

# Returns the version of a Python command, or $null if it doesn't run.
# (Also filters out the Microsoft Store "python.exe" stub, which prints nothing useful.)
function Get-PyVersion([string[]]$cmd) {
    try {
        $exe = $cmd[0]
        $rest = @($cmd | Select-Object -Skip 1)
        $out = & $exe @rest -c "import sys; print('%d.%d.%d' % sys.version_info[:3])" 2>$null
        if ($LASTEXITCODE -eq 0 -and $out -match '^\d+\.\d+\.\d+$') { return [version]$out }
    } catch { }
    return $null
}

# ---- 1. Windows build (bleak needs WinRT Bluetooth: build 16299+) ----------------
$build = [System.Environment]::OSVersion.Version.Build
if ($build -lt 16299) { Die "Windows 10 version 1709 (build 16299) or newer is required for Bluetooth LE (this is build $build)." }

# ---- 2. find a Python >= 3.10 --------------------------------------------------------
$Py = $null
foreach ($cand in @(@("py", "-3"), @("python"), @("python3"))) {
    if (-not (Get-Command $cand[0] -ErrorAction SilentlyContinue)) { continue }
    $v = Get-PyVersion $cand
    if ($v -and $v -ge $MinVersion) { $Py = $cand; break }
}
if (-not $Py) {
    Die ("Python $MinVersion or newer not found. Install it from https://www.python.org/downloads/windows/ " +
         "(tick 'Add python.exe to PATH') or run: winget install Python.Python.3.12")
}
Info ("using Python " + (Get-PyVersion $Py) + " (" + ($Py -join " ") + ")")

# ---- 3. virtual environment ------------------------------------------------------------
if ($Force -and (Test-Path $Venv)) {
    Info "removing existing .venv"
    Remove-Item -Recurse -Force $Venv
}
$venvVer = if (Test-Path $VenvPy) { Get-PyVersion @($VenvPy) } else { $null }
if ($venvVer -and $venvVer -ge $MinVersion) {
    Info "reusing existing .venv"
} else {
    if (Test-Path $Venv) { Info "existing .venv is broken or too old, recreating"; Remove-Item -Recurse -Force $Venv }
    Info "creating .venv"
    $exe = $Py[0]; $rest = @($Py | Select-Object -Skip 1)
    & $exe @rest -m venv $Venv
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $VenvPy)) { Die "could not create the virtual environment" }
}

# ---- 4. dependencies ------------------------------------------------------------------------
Info "installing requirements"
& $VenvPy -m pip install --upgrade pip --quiet
if ($LASTEXITCODE -ne 0) { Die "pip upgrade failed" }
& $VenvPy -m pip install -r requirements.txt --quiet
if ($LASTEXITCODE -ne 0) { Die "installing requirements failed" }
& $VenvPy -c "import bleak, aiohttp"
if ($LASTEXITCODE -ne 0) { Die "requirements did not install correctly" }

New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot "recordings") | Out-Null

# ---- 5. Bluetooth sanity check (warning only) -------------------------------------------------
try {
    $bt = Get-PnpDevice -Class Bluetooth -PresentOnly -ErrorAction Stop |
          Where-Object { $_.Status -eq "OK" }
    if (-not $bt) { Warn "no working Bluetooth adapter found - check that Bluetooth is turned on." }
} catch { }

Write-Host ""
Info "done. Start the dashboard with:"
Write-Host "    run.bat            # connect to the strap"
Write-Host "    run.bat --demo     # synthetic data, no hardware needed"
