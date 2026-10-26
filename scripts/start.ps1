[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [switch]$SkipProxy,
    [switch]$SkipThinkFlow,
    [switch]$StartOllama
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($env:PERSONAL_AGENT_MODE -eq 'server') { throw 'Server mode requires explicit HTTPS proxy configuration. Start node server.mjs directly; this launcher manages only the local desktop workspace.' }
$runtimeRoot = Join-Path $projectRoot '.runtime'
$serverPath = Join-Path $projectRoot 'server.mjs'
$ollamaExe = Join-Path $runtimeRoot 'ollama\ollama.exe'
$modelsRoot = Join-Path $runtimeRoot 'models'
$proxyRoot = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Desktop\EasyCLIProxyAPI-v0.3.9-Windows-amd64\EasyCLIProxyAPI-v0.3.9-Windows-amd64\cpa-core'
$proxyExe = Join-Path $proxyRoot 'cli-proxy-api.exe'
$proxyConfig = Join-Path $proxyRoot 'config.yaml'
$appUrl = 'http://127.0.0.1:4317'
$thinkflowPython = Join-Path $runtimeRoot 'thinkflow\venv\Scripts\python.exe'
$thinkflowRunner = Join-Path $PSScriptRoot 'run-thinkflow.py'

[void](New-Item -ItemType Directory -Path $runtimeRoot -Force)
$nodeCommand = Get-Command node.exe -ErrorAction Stop

function Test-LocalPort([int]$Port) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $connection = $client.ConnectAsync('127.0.0.1', $Port)
        return $connection.Wait(500) -and $client.Connected
    } catch { return $false } finally { $client.Dispose() }
}

function Test-AppReady {
    try {
        $state = Invoke-RestMethod -Uri "$appUrl/api/state" -TimeoutSec 2
        return $state.runtime.localOnly -eq $true -and $state.runtime.storage -in @('data/workspace.json','sqlite') -and $state.runtime.version -eq '0.1.0'
    } catch { return $false }
}

function Test-OllamaReady {
    try {
        $result = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 2
        return $result.version -is [string]
    } catch { return $false }
}
function Test-ThinkFlowReady {
    try {
        $result = Invoke-RestMethod -Uri 'http://127.0.0.1:8437/personal-agent-health' -TimeoutSec 2
        return $result.service -eq 'personal-agent-thinkflow' -and $result.upstream_commit -eq '1eecae5d6e0423ee047702a5b9193ffb2f0ea6c3'
    } catch { return $false }
}

function Get-ProcessDetails([int]$ProcessId) {
    return Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Save-OwnedProcess([string]$Name, [int]$ProcessId) {
    $details = Get-ProcessDetails $ProcessId
    if (-not $details) { throw "$Name exited before it could be registered. Check .runtime logs." }
    $record = [ordered]@{
        pid = $ProcessId
        executable = $details.ExecutablePath
        startedAtUtc = $details.CreationDate.ToUniversalTime().ToString('o')
    }
    $record | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeRoot "$Name.process.json") -Encoding utf8
    Set-Content -LiteralPath (Join-Path $runtimeRoot "$Name.pid") -Value $ProcessId -Encoding ascii
}

function Register-SetupOllama {
    $pidPath = Join-Path $runtimeRoot 'ollama.pid'
    $recordPath = Join-Path $runtimeRoot 'ollama.process.json'
    if (-not (Test-Path -LiteralPath $pidPath)) { return }
    [int]$candidateId = 0
    if (-not [int]::TryParse((Get-Content -LiteralPath $pidPath -Raw).Trim(), [ref]$candidateId)) { return }
    $details = Get-ProcessDetails $candidateId
    if (-not $details -or $details.ExecutablePath -ine $ollamaExe -or $details.CommandLine -notmatch '(?i)(?:^|\s)serve(?:\s|$)') { return }
    if (Test-Path -LiteralPath $recordPath) {
        try {
            $existingRecord = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
            $recordedStart = if ($existingRecord.startedAtUtc -is [DateTime]) {
                $existingRecord.startedAtUtc.ToUniversalTime()
            } else {
                [DateTime]::Parse([string]$existingRecord.startedAtUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
            }
            if ($existingRecord.pid -eq $candidateId -and $existingRecord.executable -ieq $details.ExecutablePath -and $recordedStart.Ticks -eq $details.CreationDate.ToUniversalTime().Ticks) { return }
        } catch { }
        # A later setup run may have replaced its PID file. Verify the new process below.
    }
    $fileTime = (Get-Item -LiteralPath $pidPath).LastWriteTimeUtc
    $started = $details.CreationDate.ToUniversalTime()
    # setup-local-model.ps1 writes its PID immediately after spawning the project executable.
    if ($started -gt $fileTime -or ($fileTime - $started).TotalSeconds -gt 30) { return }
    $listeners = @(Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $candidateId })
    if ($listeners.Count -eq 0) { return }
    Save-OwnedProcess 'ollama' $candidateId
    Write-Host 'Registered the project Ollama service previously started by setup-local-model.ps1.'
}

function Wait-Service([string]$Name, [scriptblock]$Ready, $StartedProcess) {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (& $Ready) { return }
        $StartedProcess.Refresh()
        if ($StartedProcess.HasExited) { throw "$Name exited. Check .runtime/$Name.stderr.log." }
        Start-Sleep -Milliseconds 300
    }
    throw "$Name did not become ready. Check .runtime/$Name.stderr.log. Its PID remains registered for stop.ps1."
}

$serviceLock = $null
try {
    try {
        $serviceLock = [IO.File]::Open((Join-Path $runtimeRoot 'services.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch { throw 'Another start/stop operation is in progress. Try again when it finishes.' }

    $appReady = Test-AppReady
    if (-not $appReady -and (Test-LocalPort 4317)) {
        throw 'Port 4317 is occupied by an unrecognized service. No existing process was stopped.'
    }

    if (-not $StartOllama) {
        Write-Host 'Local model startup is disabled by default. Use -StartOllama only for the legacy local selection mode.'
    } elseif (Test-OllamaReady) {
        Write-Host 'Reusing Ollama at http://127.0.0.1:11434.'
        Register-SetupOllama
    } elseif (Test-LocalPort 11434) {
        Write-Warning 'Port 11434 is occupied but does not respond as Ollama. It was left untouched; use rules or the cloud provider.'
    } elseif (Test-Path -LiteralPath $ollamaExe) {
        [void](New-Item -ItemType Directory -Path $modelsRoot -Force)
        $previousHost = [Environment]::GetEnvironmentVariable('OLLAMA_HOST', 'Process')
        $previousModels = [Environment]::GetEnvironmentVariable('OLLAMA_MODELS', 'Process')
        try {
            $env:OLLAMA_HOST = '127.0.0.1:11434'
            $env:OLLAMA_MODELS = $modelsRoot
            $ollamaProcess = Start-Process -FilePath $ollamaExe -ArgumentList @('serve') -WorkingDirectory (Split-Path -Parent $ollamaExe) -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'ollama.stdout.log') -RedirectStandardError (Join-Path $runtimeRoot 'ollama.stderr.log')
        } finally {
            [Environment]::SetEnvironmentVariable('OLLAMA_HOST', $previousHost, 'Process')
            [Environment]::SetEnvironmentVariable('OLLAMA_MODELS', $previousModels, 'Process')
        }
        Save-OwnedProcess 'ollama' $ollamaProcess.Id
        Wait-Service 'ollama' { Test-OllamaReady } $ollamaProcess
        Write-Host 'Started project-local Ollama. Model downloads are managed by setup-local-model.ps1.'
    } else {
        Write-Host 'Portable Ollama is not installed. Rules and a configured cloud provider remain available.'
    }

    if (-not $SkipProxy) {
        if (Test-LocalPort 8317) {
            Write-Host 'Port 8317 is already in use. Reusing the existing proxy without taking ownership.'
        } elseif ((Test-Path -LiteralPath $proxyExe) -and (Test-Path -LiteralPath $proxyConfig)) {
            $proxyProcess = Start-Process -FilePath $proxyExe -ArgumentList @('-config', ('"' + $proxyConfig + '"')) -WorkingDirectory $proxyRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'proxy.stdout.log') -RedirectStandardError (Join-Path $runtimeRoot 'proxy.stderr.log')
            Save-OwnedProcess 'proxy' $proxyProcess.Id
            Wait-Service 'proxy' { Test-LocalPort 8317 } $proxyProcess
            Write-Host 'Started the configured proxy core on port 8317.'
        } else {
            Write-Host 'Optional proxy core/config.yaml was not found. Configure another provider in Settings if needed.'
        }
    }

    if (-not $SkipThinkFlow) {
        if (Test-ThinkFlowReady) {
            Write-Host 'Reusing project ThinkFlow at http://127.0.0.1:8437.'
        } elseif (Test-LocalPort 8437) {
            Write-Warning 'Port 8437 is occupied by an unrecognized service. It was left untouched; ThinkFlow integration may be unavailable.'
        } elseif (Test-Path -LiteralPath $thinkflowPython) {
            $thinkflowProcess = Start-Process -FilePath $thinkflowPython -ArgumentList @(('"' + $thinkflowRunner + '"')) -WorkingDirectory $projectRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'thinkflow.stdout.log') -RedirectStandardError (Join-Path $runtimeRoot 'thinkflow.stderr.log')
            Save-OwnedProcess 'thinkflow' $thinkflowProcess.Id
            Wait-Service 'thinkflow' { Test-ThinkFlowReady } $thinkflowProcess
            Write-Host 'Started pinned ThinkFlow backend and native UI on port 8437.'
        } else {
            Write-Host 'Optional ThinkFlow is not installed. Run scripts/setup-thinkflow.ps1 to enable it.'
        }
    }
    if ($appReady) {
        Write-Host "Reusing Personal Agent at $appUrl."
    } else {
        # The child receives a fixed port; the caller's process environment is restored immediately.
        $previousPort = [Environment]::GetEnvironmentVariable('PERSONAL_AGENT_PORT', 'Process')
        try {
            $env:PERSONAL_AGENT_PORT = '4317'
            $serverProcess = Start-Process -FilePath $nodeCommand.Source -ArgumentList @(('"' + $serverPath + '"')) -WorkingDirectory $projectRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'server.stdout.log') -RedirectStandardError (Join-Path $runtimeRoot 'server.stderr.log')
        } finally {
            [Environment]::SetEnvironmentVariable('PERSONAL_AGENT_PORT', $previousPort, 'Process')
        }
        Save-OwnedProcess 'server' $serverProcess.Id
        Wait-Service 'server' { Test-AppReady } $serverProcess
        Write-Host "Personal Agent is ready: $appUrl"
    }
    if (-not $NoBrowser) { Start-Process $appUrl }
} finally {
    if ($serviceLock) { $serviceLock.Dispose() }
}
