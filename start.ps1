$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskPython = Get-Command python -ErrorAction SilentlyContinue
if (-not $taskPython) {
    Write-Host 'Python 3.12 or later is required. Install Python, then run this script again.'
    Read-Host 'Press Enter to close'
    exit 1
}
Write-Host 'Process Log - http://127.0.0.1:8765'
Write-Host 'Keep this window open. Press Ctrl+C to stop.'
& $taskPython.Source server.py @args
