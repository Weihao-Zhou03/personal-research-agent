[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $projectRoot '.runtime'
$serverPath = Join-Path $projectRoot 'server.mjs'
$ollamaExe = Join-Path $runtimeRoot 'ollama\ollama.exe'
$proxyRoot = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Desktop\EasyCLIProxyAPI-v0.3.9-Windows-amd64\EasyCLIProxyAPI-v0.3.9-Windows-amd64\cpa-core'
$proxyExe = Join-Path $proxyRoot 'cli-proxy-api.exe'
$proxyConfig = Join-Path $proxyRoot 'config.yaml'
$thinkflowRunner = Join-Path $PSScriptRoot 'run-thinkflow.py'

if (-not (Test-Path -LiteralPath $runtimeRoot)) {
    Write-Host 'No registered project services were found.'
    return
}

function Remove-OwnedRecord([string]$Name) {
    foreach ($suffix in @('pid', 'process.json')) {
        $filename = Join-Path $runtimeRoot "$Name.$suffix"
        if (Test-Path -LiteralPath $filename) { Remove-Item -LiteralPath $filename }
    }
}

function Stop-OwnedProcess([string]$Name) {
    $pidPath = Join-Path $runtimeRoot "$Name.pid"
    $recordPath = Join-Path $runtimeRoot "$Name.process.json"
    if (-not (Test-Path -LiteralPath $pidPath)) { return }
    if (-not (Test-Path -LiteralPath $recordPath)) {
        Write-Warning "Skipped $Name because it has no ownership record. start.ps1 can register a verified project Ollama service."
        return
    }
    try {
        [int]$ownedId = 0
        if (-not [int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$ownedId)) { throw 'Invalid PID file.' }
        $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
        if ($record.pid -ne $ownedId) { throw 'PID and ownership record do not match.' }
        $details = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ownedId" -ErrorAction SilentlyContinue
        if (-not $details) {
            Remove-OwnedRecord $Name
            Write-Host "$Name is already stopped."
            return
        }
        $recordedStart = if ($record.startedAtUtc -is [DateTime]) {
            $record.startedAtUtc.ToUniversalTime()
        } else {
            [DateTime]::Parse([string]$record.startedAtUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        }
        if ($details.CreationDate.ToUniversalTime().Ticks -ne $recordedStart.Ticks) { throw 'PID has been reused by another process.' }
        if ($details.ExecutablePath -ine $record.executable) { throw 'Executable no longer matches the ownership record.' }
        $commandLine = [string]$details.CommandLine
        $signatureMatches = switch ($Name) {
            'server' { (Split-Path -Leaf $details.ExecutablePath) -ieq 'node.exe' -and $commandLine.IndexOf($serverPath, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
            'ollama' { $details.ExecutablePath -ieq $ollamaExe -and $commandLine -match '(?i)(?:^|\s)serve(?:\s|$)' }
            'proxy' { $details.ExecutablePath -ieq $proxyExe -and $commandLine.IndexOf($proxyConfig, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
            'thinkflow' { (Split-Path -Leaf $details.ExecutablePath) -ieq 'python.exe' -and $commandLine.IndexOf($thinkflowRunner, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
            default { $false }
        }
        if (-not $signatureMatches) { throw 'Command line does not match this project or the known proxy configuration.' }
        Stop-Process -Id $ownedId -ErrorAction Stop
        Wait-Process -Id $ownedId -Timeout 10 -ErrorAction SilentlyContinue
        Remove-OwnedRecord $Name
        Write-Host "Stopped registered $Name service (PID $ownedId)."
    } catch {
        Write-Warning "Skipped $Name. $($_.Exception.Message) No unverified process was stopped."
    }
}

$serviceLock = $null
try {
    try {
        $serviceLock = [IO.File]::Open((Join-Path $runtimeRoot 'services.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch { throw 'Another start/stop operation is in progress. Try again when it finishes.' }
    foreach ($name in @('server', 'thinkflow', 'ollama', 'proxy')) { Stop-OwnedProcess $name }
    Write-Host 'Existing services that were not started and registered by this project were left running.'
} finally {
    if ($serviceLock) { $serviceLock.Dispose() }
}
