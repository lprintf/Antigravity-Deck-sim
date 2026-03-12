# === Antigravity Deck -- One-Command Setup (Windows PowerShell) ===
# Usage: irm https://raw.githubusercontent.com/tysonnbt/Antigravity-Deck/main/scripts/setup.ps1 | iex

$ErrorActionPreference = "Stop"
$REPO = "https://github.com/tysonnbt/Antigravity-Deck.git"
$DIR  = "Antigravity-Deck"

Write-Host ""
Write-Host "  Antigravity Deck -- One-Command Setup" -ForegroundColor Cyan
Write-Host "  ======================================" -ForegroundColor DarkGray
Write-Host ""

# --- Check prerequisites ---
$missing = @()

# Node.js
try {
    $nodeVer = (node --version 2>$null)
    $major = [int]($nodeVer -replace '^v(\d+).*', '$1')
    if ($major -lt 18) {
        Write-Host "  [!] Node.js $nodeVer found, but v18+ required" -ForegroundColor Yellow
        $missing += "Node.js 18+"
    }
    else {
        Write-Host "  [OK] Node.js $nodeVer" -ForegroundColor Green
    }
}
catch {
    Write-Host "  [X] Node.js not found" -ForegroundColor Red
    $missing += "Node.js 18+"
}

# Git
try {
    $gitVer = (git --version 2>$null)
    Write-Host "  [OK] $gitVer" -ForegroundColor Green
}
catch {
    Write-Host "  [X] Git not found" -ForegroundColor Red
    $missing += "Git"
}

# cloudflared (optional -- only needed for npm run online)
$cfFound = $false
try {
    cloudflared --version 2>$null | Out-Null
    $cfFound = $true
}
catch { }

if (-not $cfFound) {
    $cfPaths = @(
        "C:\Program Files (x86)\cloudflared\cloudflared.exe",
        "C:\Program Files\cloudflared\cloudflared.exe"
    )
    foreach ($p in $cfPaths) {
        if (Test-Path $p) {
            $cfFound = $true
            break
        }
    }
}

if ($cfFound) {
    Write-Host "  [OK] cloudflared" -ForegroundColor Green
}
else {
    Write-Host "  [!] cloudflared not found (optional, needed for remote access)" -ForegroundColor Yellow
}

if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "  Missing prerequisites:" -ForegroundColor Red
    foreach ($m in $missing) {
        switch ($m) {
            "Node.js 18+" {
                Write-Host "    -> Install Node.js: https://nodejs.org/" -ForegroundColor Yellow
            }
            "Git" {
                Write-Host "    -> Install Git: https://git-scm.com/" -ForegroundColor Yellow
            }
        }
    }
    Write-Host ""
    Write-Host "  Install the missing tools and run this script again." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}

Write-Host ""

# === Detect scenario ===
$scenario = "fresh"       # fresh | up-to-date | updated
$updatedFiles = @()

if (Test-Path "$DIR\.git") {
    Push-Location $DIR

    # Save current commit hash before pull
    $hashBefore = (git rev-parse HEAD 2>$null)

    Write-Host "  [i] Found existing install -- checking for updates..." -ForegroundColor Cyan
    try {
        git fetch origin main --quiet 2>$null

        $localHash  = (git rev-parse HEAD 2>$null)
        $remoteHash = (git rev-parse "origin/main" 2>$null)

        if ($localHash -eq $remoteHash) {
            $scenario = "up-to-date"
            $shortHash = $localHash.Substring(0, 7)
            Write-Host "  [OK] Already up to date ($shortHash)" -ForegroundColor Green
        }
        else {
            # Count commits behind
            $behind = (git rev-list --count "HEAD..origin/main" 2>$null)
            Write-Host "  [i] $behind new commit(s) available -- pulling..." -ForegroundColor Yellow

            git pull --ff-only 2>$null

            $hashAfter = (git rev-parse HEAD 2>$null)

            # List changed files between old and new
            $updatedFiles = @(git diff --name-only $hashBefore $hashAfter 2>$null)
            $scenario = "updated"

            $shortNewHash = $hashAfter.Substring(0, 7)
            Write-Host "  [OK] Updated to $shortNewHash" -ForegroundColor Green
        }
    }
    catch {
        Write-Host "  [!] Could not fetch updates (offline?) -- continuing with current version" -ForegroundColor Yellow
        $scenario = "up-to-date"
    }

    Pop-Location
}
else {
    Write-Host "  [i] First time setup -- cloning repository..." -ForegroundColor Cyan
    git clone $REPO $DIR
    Write-Host "  [OK] Cloned successfully" -ForegroundColor Green
}

Push-Location $DIR

# === Smart dependency install ===
$needBackendDeps  = $false
$needFrontendDeps = $false

switch ($scenario) {
    "fresh" {
        # Fresh install -- always install everything
        $needBackendDeps  = $true
        $needFrontendDeps = $true
    }
    "updated" {
        # Only reinstall if package files changed
        if ($updatedFiles -contains "package.json" -or $updatedFiles -contains "package-lock.json") {
            $needBackendDeps = $true
        }
        $frontendPkgChanged = $updatedFiles | Where-Object {
            $_ -like "frontend/package.json" -or $_ -like "frontend/package-lock.json"
        }
        if ($frontendPkgChanged) {
            $needFrontendDeps = $true
        }

        # Show what changed
        Write-Host ""
        Write-Host "  Changes in this update:" -ForegroundColor Cyan

        $beFiles  = @($updatedFiles | Where-Object { $_ -notlike "frontend/*" -and $_ -notlike "scripts/*" -and $_ -notlike "docs/*" -and $_ -notlike "electron/*" })
        $feFiles  = @($updatedFiles | Where-Object { $_ -like "frontend/*" })
        $elFiles  = @($updatedFiles | Where-Object { $_ -like "electron/*" })
        $scFiles  = @($updatedFiles | Where-Object { $_ -like "scripts/*" })
        $docFiles = @($updatedFiles | Where-Object { $_ -like "docs/*" })

        if ($beFiles.Count -gt 0)  { Write-Host "    Backend:  $($beFiles.Count) file(s)" -ForegroundColor DarkGray }
        if ($feFiles.Count -gt 0)  { Write-Host "    Frontend: $($feFiles.Count) file(s)" -ForegroundColor DarkGray }
        if ($elFiles.Count -gt 0)  { Write-Host "    Electron: $($elFiles.Count) file(s)" -ForegroundColor DarkGray }
        if ($scFiles.Count -gt 0)  { Write-Host "    Scripts:  $($scFiles.Count) file(s)" -ForegroundColor DarkGray }
        if ($docFiles.Count -gt 0) { Write-Host "    Docs:     $($docFiles.Count) file(s)" -ForegroundColor DarkGray }
    }
    "up-to-date" {
        # Check if node_modules exist (maybe user deleted them)
        if (-not (Test-Path "node_modules")) {
            $needBackendDeps = $true
        }
        if (-not (Test-Path "frontend\node_modules")) {
            $needFrontendDeps = $true
        }
    }
}

Write-Host ""

if ($needBackendDeps) {
    Write-Host "  [i] Installing backend dependencies..." -ForegroundColor Cyan
    npm install
}
else {
    Write-Host "  [OK] Backend dependencies -- no changes" -ForegroundColor Green
}

if ($needFrontendDeps) {
    Write-Host ""
    Write-Host "  [i] Installing frontend dependencies..." -ForegroundColor Cyan
    npm install --prefix frontend
}
else {
    Write-Host "  [OK] Frontend dependencies -- no changes" -ForegroundColor Green
}

# --- Create settings.json if missing ---
if (-not (Test-Path "settings.json")) {
    Copy-Item "settings.sample.json" "settings.json"
    Write-Host "  [OK] Created settings.json from sample" -ForegroundColor Green
}

# === Build frontend (production) ===
$needBuild = $false

switch ($scenario) {
    "fresh" {
        $needBuild = $true
    }
    "updated" {
        # Rebuild if any frontend source files changed
        $feSourceChanged = $updatedFiles | Where-Object {
            $_ -like "frontend/*" -and $_ -notlike "frontend/node_modules/*"
        }
        if ($feSourceChanged) {
            $needBuild = $true
        }
    }
    "up-to-date" {
        # Build if .next folder is missing (user may have deleted it)
        if (-not (Test-Path "frontend\.next")) {
            $needBuild = $true
        }
    }
}

if ($needBuild) {
    Write-Host ""
    Write-Host "  [i] Building frontend (production)..." -ForegroundColor Cyan
    $env:BACKEND_PORT = "9807"
    npm run build --prefix frontend
    Write-Host "  [OK] Frontend build complete" -ForegroundColor Green
}
else {
    Write-Host "  [OK] Frontend build -- no changes" -ForegroundColor Green
}

# === Summary ===
Write-Host ""
Write-Host "  ======================================" -ForegroundColor DarkGray
switch ($scenario) {
    "fresh"      { Write-Host "  Fresh install complete!" -ForegroundColor Green }
    "updated"    { Write-Host "  Updated and ready!" -ForegroundColor Green }
    "up-to-date" { Write-Host "  Already up to date!" -ForegroundColor Green }
}
Write-Host "  ======================================" -ForegroundColor DarkGray
Write-Host ""

# === Launch (BE=9807, FE=9808) ===

# Kill any existing processes on our ports
$ports = @(9807, 9808)
foreach ($port in $ports) {
    $existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($existing) {
        foreach ($conn in $existing) {
            $procId = $conn.OwningProcess
            $procName = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName
            Write-Host "  [!] Killing stale process on port $port (PID $procId, $procName)" -ForegroundColor Yellow
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
    }
}

# Start backend on port 9807
$env:NODE_ENV = "production"
$env:PORT = "9807"
$env:BACKEND_PORT = "9807"
$beProc = Start-Process -FilePath "node" -ArgumentList "server.js" -NoNewWindow -PassThru

Write-Host "  Starting Antigravity Deck (production)..." -ForegroundColor Green
Write-Host "  Backend:  http://localhost:9807" -ForegroundColor DarkGray
Write-Host "  Frontend: http://localhost:9808" -ForegroundColor DarkGray

if (-not $cfFound) {
    Write-Host "  (Install cloudflared for remote access: winget install cloudflare.cloudflared)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  Press Ctrl+C to stop" -ForegroundColor DarkGray
Write-Host ""

# Cleanup function — kills backend + any remaining port listeners
function Cleanup-All {
    Write-Host ""
    Write-Host "  Shutting down..." -ForegroundColor Yellow
    try {
        if ($beProc -and -not $beProc.HasExited) {
            taskkill /PID $beProc.Id /T /F 2>$null | Out-Null
        }
    } catch {}
    foreach ($port in @(9807, 9808)) {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        foreach ($conn in $conns) {
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
        }
    }
    Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Host "  All processes stopped." -ForegroundColor Green
    Write-Host ""
}

Register-EngineEvent PowerShell.Exiting -Action { Cleanup-All } -ErrorAction SilentlyContinue | Out-Null

# Start frontend production server on port 9808
try {
    Push-Location frontend
    $env:BACKEND_PORT = "9807"
    npx next start --port 9808
}
catch {
    Cleanup-All
}
