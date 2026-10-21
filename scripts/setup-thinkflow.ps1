[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$serviceRoot = Join-Path $projectRoot '.runtime\thinkflow'
$sourceRoot = Join-Path $serviceRoot 'source'
$venvRoot = Join-Path $serviceRoot 'venv'
$pythonExe = Join-Path $venvRoot 'Scripts\python.exe'
$commit = '1eecae5d6e0423ee047702a5b9193ffb2f0ea6c3'
[void](Get-Command git.exe -ErrorAction Stop)
[void](Get-Command uv.exe -ErrorAction Stop)
[void](Get-Command npm.cmd -ErrorAction Stop)
[void](New-Item -ItemType Directory -Path $serviceRoot -Force)
function Assert-Exit([string]$Step) { if ($LASTEXITCODE -ne 0) { throw "$Step failed (exit $LASTEXITCODE)." } }
if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot '.git'))) {
    git clone https://github.com/OpenDCAI/ThinkFlow.git $sourceRoot
    Assert-Exit 'Clone ThinkFlow'
    git -C $sourceRoot checkout --detach $commit
    Assert-Exit 'Pin ThinkFlow'
}
$actualCommit = (git -C $sourceRoot rev-parse HEAD).Trim()
Assert-Exit 'Read ThinkFlow version'
if ($actualCommit -ne $commit) { throw 'Existing ThinkFlow checkout has a different version; it was left unchanged.' }
git -C $sourceRoot diff --quiet
Assert-Exit 'Verify upstream source is unchanged'
if (-not (Test-Path -LiteralPath $pythonExe)) {
    uv venv --python 3.11 $venvRoot
    Assert-Exit 'Create Python 3.11 environment'
}
uv pip sync --python $pythonExe (Join-Path $PSScriptRoot 'thinkflow-requirements.lock')
Assert-Exit 'Install pinned Python dependencies'
$dataRoot = Join-Path $projectRoot 'data\thinkflow\outputs'
[void](New-Item -ItemType Directory -Path $dataRoot -Force)
$outputPath = Join-Path $sourceRoot 'outputs'
if (Test-Path -LiteralPath $outputPath) {
    $item = Get-Item -LiteralPath $outputPath
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        if ([IO.Path]::GetFullPath([string]$item.Target) -ine [IO.Path]::GetFullPath($dataRoot)) { throw 'Existing outputs junction points elsewhere; it was left unchanged.' }
    } else {
        if (@(Get-ChildItem -LiteralPath $outputPath -Force).Count -gt 0) { throw 'Existing outputs directory contains data. Back it up and migrate it before setup; nothing was removed.' }
        # Only remove the verified empty directory inside this checkout.
        if ([IO.Path]::GetFullPath($outputPath) -ine (Join-Path $sourceRoot 'outputs')) { throw 'Unexpected outputs path.' }
        Remove-Item -LiteralPath $outputPath
        [void](New-Item -ItemType Junction -Path $outputPath -Target $dataRoot)
    }
} else { [void](New-Item -ItemType Junction -Path $outputPath -Target $dataRoot) }
Push-Location (Join-Path $sourceRoot 'frontend')
$previousLlmUrl = [Environment]::GetEnvironmentVariable('VITE_DEFAULT_LLM_API_URL','Process')
$previousLlmOptions = [Environment]::GetEnvironmentVariable('VITE_LLM_API_URLS','Process')
try {
    $env:VITE_DEFAULT_LLM_API_URL = 'http://127.0.0.1:8317/v1'
    $env:VITE_LLM_API_URLS = 'http://127.0.0.1:8317/v1'
    npm.cmd ci --no-audit --no-fund
    Assert-Exit 'Install upstream UI dependencies'
    npm.cmd run build
    Assert-Exit 'Build upstream UI'
} finally {
    [Environment]::SetEnvironmentVariable('VITE_DEFAULT_LLM_API_URL',$previousLlmUrl,'Process')
    [Environment]::SetEnvironmentVariable('VITE_LLM_API_URLS',$previousLlmOptions,'Process')
    Pop-Location
}
Write-Host 'ThinkFlow installed. Run start.cmd; native UI: http://127.0.0.1:8437'
