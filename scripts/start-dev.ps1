param(
  [string]$GitHubToken = ""
)

# Root of the repo
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path | Split-Path -Parent

# 1) Backend with hot-reload (uvicorn --reload)
$BackendCwd = $RepoRoot
$BackendCmd = ".\.venv\Scripts\python -m uvicorn app.main:app --reload --host 0.0.0.0 --port 8000 --app-dir backend --reload-dir backend"

# 2) Frontend with Vite HMR
$FrontendCwd = Join-Path $RepoRoot "frontend"
$FrontendCmd = "npm run dev"

Write-Host "Starting dev environment..." -ForegroundColor Cyan

# Propagate GitHub token to backend process if provided
if ($GitHubToken -ne "") {
  $env:GITHUB_TOKEN = $GitHubToken
  Write-Host "GITHUB_TOKEN set for backend process." -ForegroundColor Yellow
}

# Ensure frontend .env exists and points to local backend
$FrontendEnv = Join-Path $FrontendCwd ".env"
if (!(Test-Path $FrontendEnv)) {
  "VITE_API_BASE=http://localhost:8000" | Out-File -FilePath $FrontendEnv -Encoding utf8
  Write-Host "Created frontend/.env with VITE_API_BASE=http://localhost:8000" -ForegroundColor Yellow
}

# Start Backend
Write-Host "Launching backend (hot reload)..." -ForegroundColor Green
Start-Process powershell -WorkingDirectory $BackendCwd -ArgumentList "-NoExit","-Command","$BackendCmd"

Start-Sleep -Seconds 1

# Start Frontend
Write-Host "Launching frontend (Vite HMR)..." -ForegroundColor Green
Start-Process powershell -WorkingDirectory $FrontendCwd -ArgumentList "-NoExit","-Command","$FrontendCmd"

Write-Host "Both dev servers started. Backend: http://localhost:8000 | Frontend: http://localhost:5173" -ForegroundColor Cyan
