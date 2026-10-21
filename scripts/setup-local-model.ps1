[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9._:/-]+$')]
    [string]$Model = 'qwen2.5:1.5b',
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $projectRoot '.runtime'
$ollamaRoot = Join-Path $runtimeRoot 'ollama'
$modelsRoot = Join-Path $runtimeRoot 'models'
$downloadRoot = Join-Path $runtimeRoot 'downloads'
$ollamaExe = Join-Path $ollamaRoot 'ollama.exe'
$versionFile = Join-Path $ollamaRoot '.installed-version'
$ollamaVersion = '0.40.6'
$archiveUrl = 'https://github.com/ollama/ollama/releases/download/v0.40.6/ollama-windows-amd64.zip'
$archiveHash = 'e359637575302f288d76c0007c408a4be9c7376d59c4f28684d63b232a44b427'
$archiveBytes = 1471164488
$archivePath = Join-Path $downloadRoot 'ollama-windows-amd64-v0.40.6.zip'
$partialPath = "$archivePath.part"
$baseUri = 'http://127.0.0.1:11434'

foreach ($directory in @($runtimeRoot, $modelsRoot, $downloadRoot)) {
    [void](New-Item -ItemType Directory -Path $directory -Force)
}

function Get-OllamaVersion {
    try {
        $response = Invoke-RestMethod -Uri "$baseUri/api/version" -TimeoutSec 3
        if ($response.version -is [string]) { return $response.version }
    } catch { }
    return $null
}

function Test-ServicePort {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $operation = $client.ConnectAsync('127.0.0.1', 11434)
        if ($operation.Wait(1500)) { return $client.Connected }
        return $false
    } catch { return $false } finally { $client.Dispose() }
}

function Ensure-PortableOllama {
    if ((Test-Path -LiteralPath $ollamaExe) -and (Test-Path -LiteralPath $versionFile)) {
        $installedVersion = (Get-Content -LiteralPath $versionFile -Raw).Trim()
        if ($installedVersion -eq $ollamaVersion) { return }
        throw "A different portable Ollama version is already present at $ollamaRoot. This script does not overwrite an existing installation."
    }
    if (-not (Test-Path -LiteralPath $archivePath)) {
        $curl = Get-Command curl.exe -ErrorAction Stop
        Write-Host "Downloading official Ollama v$ollamaVersion portable archive (1.47 GB); a partial download is resumed automatically."
        $alreadyDownloaded = (Test-Path -LiteralPath $partialPath) -and (Get-Item -LiteralPath $partialPath).Length -eq $archiveBytes
        if (-not $alreadyDownloaded) {
            & $curl.Source --location --fail --silent --show-error --retry 5 --retry-delay 3 --connect-timeout 30 --continue-at - --output $partialPath $archiveUrl
            if ($LASTEXITCODE -ne 0) { throw "Ollama download failed. Run this script again to resume the .part file. curl exit code: $LASTEXITCODE" }
        }
        if ((Get-Item -LiteralPath $partialPath).Length -ne $archiveBytes) { throw 'The archive size does not match the official release. The partial file has been preserved.' }
        Write-Host 'Verifying the official SHA-256 release digest...'
        if ((Get-FileHash -LiteralPath $partialPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveHash) { throw 'Archive SHA-256 verification failed. The file was preserved for inspection; it will not be executed.' }
        Move-Item -LiteralPath $partialPath -Destination $archivePath
    } else {
        if ((Get-Item -LiteralPath $archivePath).Length -ne $archiveBytes -or (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveHash) { throw 'The cached archive does not match the official release digest; it will not be executed.' }
    }
    Write-Host 'Extracting the verified portable archive...'
    [void](New-Item -ItemType Directory -Path $ollamaRoot -Force)
    Expand-Archive -LiteralPath $archivePath -DestinationPath $ollamaRoot -Force
    if (-not (Test-Path -LiteralPath $ollamaExe)) { throw 'The verified archive did not produce ollama.exe.' }
    Set-Content -LiteralPath $versionFile -Value $ollamaVersion -Encoding utf8
}

$previousHost = [Environment]::GetEnvironmentVariable('OLLAMA_HOST', 'Process')
$previousModels = [Environment]::GetEnvironmentVariable('OLLAMA_MODELS', 'Process')
try {
    # Only this script and its child processes inherit these settings. No user or machine settings are changed.
    $env:OLLAMA_HOST = '127.0.0.1:11434'
    $env:OLLAMA_MODELS = $modelsRoot

    $runningVersion = Get-OllamaVersion
    if ($runningVersion) {
        Write-Host "Reusing an existing Ollama service (v$runningVersion) at $baseUri; its existing model directory is unchanged."
    } else {
        if (Test-ServicePort) { throw 'Port 11434 is occupied by a service that does not respond as Ollama. No existing process was stopped.' }
        Ensure-PortableOllama
        Write-Host "Starting portable Ollama with project-local models: $modelsRoot"
        $service = Start-Process -FilePath $ollamaExe -ArgumentList @('serve') -WorkingDirectory $ollamaRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'ollama.stdout.log') -RedirectStandardError (Join-Path $runtimeRoot 'ollama.stderr.log')
        Set-Content -LiteralPath (Join-Path $runtimeRoot 'ollama.pid') -Value $service.Id -Encoding ascii
        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            if (Get-OllamaVersion) { $ready = $true; break }
            $service.Refresh()
            if ($service.HasExited) { throw 'Ollama exited before becoming ready. See .runtime/ollama.stderr.log.' }
            Start-Sleep -Seconds 1
        }
        if (-not $ready) { throw 'Ollama did not become ready. See .runtime/ollama.stderr.log.' }
    }

    $tags = Invoke-RestMethod -Uri "$baseUri/api/tags" -TimeoutSec 15
    $installed = @($tags.models | Where-Object { $_.name -eq $Model -or $_.name -eq "${Model}:latest" -or $_.model -eq $Model })
    if ($installed.Count -eq 0) {
        Write-Host "Pulling the local model $Model (qwen2.5:1.5b is approximately 986 MB); Ollama resumes existing model blobs."
        if (Test-Path -LiteralPath $ollamaExe) {
            $pull = Start-Process -FilePath $ollamaExe -ArgumentList @('pull', $Model) -WorkingDirectory $ollamaRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeRoot 'ollama-pull.stdout.log') -RedirectStandardError (Join-Path $runtimeRoot 'ollama-pull.stderr.log')
            $pull.WaitForExit()
            if ($pull.ExitCode -ne 0) { throw 'Model download failed. See .runtime/ollama-pull.stderr.log, then rerun this script to resume.' }
        } else {
            $pullBody = @{ model = $Model; stream = $false } | ConvertTo-Json
            $pullResult = Invoke-RestMethod -Method Post -Uri "$baseUri/api/pull" -ContentType 'application/json; charset=utf-8' -Body $pullBody -TimeoutSec 3600
            if ($pullResult.status -ne 'success') { throw 'The existing Ollama service did not confirm a successful model pull.' }
        }
    } else {
        Write-Host "Model $Model is already available."
    }

    if (-not $SkipSmokeTest) {
        Write-Host 'Running a real local Chinese generation smoke test...'
        $chatBody = @{
            model = $Model
            stream = $false
            messages = @(@{ role = 'user'; content = '请只用一句中文解释：树莓派是什么？' })
            options = @{ num_predict = 128 }
        } | ConvertTo-Json -Depth 5
        $stopwatch = [Diagnostics.Stopwatch]::StartNew()
        $chat = Invoke-RestMethod -Method Post -Uri "$baseUri/api/chat" -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($chatBody)) -TimeoutSec 180
        $stopwatch.Stop()
        if (-not ($chat.message.content -is [string]) -or [string]::IsNullOrWhiteSpace($chat.message.content)) { throw 'The model returned no text for the local generation test.' }
        $smokeResult = [ordered]@{
            model = $Model
            answer = $chat.message.content
            elapsedSeconds = [Math]::Round($stopwatch.Elapsed.TotalSeconds, 2)
            ollamaVersion = (Get-OllamaVersion)
            location = 'This Windows computer; not a Raspberry Pi benchmark'
        }
        $smokeResult | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $runtimeRoot 'local-model-smoke.json') -Encoding utf8
        Write-Host $chat.message.content
        Write-Host "Local generation completed in $($smokeResult.elapsedSeconds) seconds on this Windows computer."
    }
    Write-Host "Ready: provider=ollama, baseUrl=$baseUri, model=$Model"
    Write-Host 'No system installation, global environment changes, or automatic startup were configured.'
} finally {
    [Environment]::SetEnvironmentVariable('OLLAMA_HOST', $previousHost, 'Process')
    [Environment]::SetEnvironmentVariable('OLLAMA_MODELS', $previousModels, 'Process')
}
