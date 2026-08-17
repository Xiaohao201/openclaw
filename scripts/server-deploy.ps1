[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("deploy", "dry-run", "status", "rollback")]
    [string]$Action = "deploy"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Set-StrictMode -Version 2.0

$utf8Encoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8Encoding
[Console]::OutputEncoding = $utf8Encoding
$OutputEncoding = $utf8Encoding
$env:PYTHONUTF8 = "1"
$env:PYTHONIOENCODING = "utf-8"

function Write-DeployLog {
    param([string]$Message)
    Write-Host "[openclaw-deploy] $Message"
}

function Get-EnvOrDefault {
    param([string]$Name, [string]$Default)
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $Default
    }
    return $value
}

function Invoke-Native {
    param(
        [string]$Command,
        [string[]]$Arguments,
        [string]$WorkingDirectory
    )
    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $Command @Arguments | Out-Host
        if ($LASTEXITCODE -ne 0) {
            throw "Command failed with exit code $LASTEXITCODE`: $Command $($Arguments -join ' ')"
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-NativeCapture {
    param(
        [string]$Command,
        [string[]]$Arguments,
        [string]$WorkingDirectory
    )
    Push-Location -LiteralPath $WorkingDirectory
    try {
        $output = & $Command @Arguments 2>&1
        if ($LASTEXITCODE -ne 0) {
            $detail = ($output | Out-String).Trim()
            throw "Command failed with exit code $LASTEXITCODE`: $Command $($Arguments -join ' ')`n$detail"
        }
        return ($output | Out-String).Trim()
    }
    finally {
        Pop-Location
    }
}

function Assert-Sha {
    param([string]$Sha, [string]$Label)
    if ($Sha -notmatch '^[0-9a-f]{40,64}$') {
        throw "$Label is not a valid Git commit id."
    }
}

function Invoke-OpenClaw {
    param([string]$ReleaseDirectory, [string[]]$Arguments)
    Invoke-Native -Command "pnpm" -Arguments (@("openclaw") + $Arguments) -WorkingDirectory $ReleaseDirectory
}

function Test-GatewayHealth {
    param([string]$ReleaseDirectory)
    Invoke-OpenClaw -ReleaseDirectory $ReleaseDirectory -Arguments @(
        "gateway", "status", "--require-rpc", "--deep", "--json"
    )
}

function Enable-Release {
    param([string]$ReleaseDirectory)
    Invoke-OpenClaw -ReleaseDirectory $ReleaseDirectory -Arguments @(
        "gateway", "install", "--force", "--runtime", "node"
    )
    Invoke-OpenClaw -ReleaseDirectory $ReleaseDirectory -Arguments @("gateway", "restart")
    Test-GatewayHealth -ReleaseDirectory $ReleaseDirectory
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$remote = Get-EnvOrDefault -Name "OPENCLAW_DEPLOY_REMOTE" -Default "origin"
$branch = Get-EnvOrDefault -Name "OPENCLAW_DEPLOY_BRANCH" -Default "v1"
$localAppData = [Environment]::GetFolderPath("LocalApplicationData")
if ([string]::IsNullOrWhiteSpace($localAppData)) {
    $localAppData = [Environment]::GetEnvironmentVariable("LOCALAPPDATA")
}
if ([string]::IsNullOrWhiteSpace($localAppData)) {
    $localAppData = Join-Path $HOME "AppData\Local"
}
$defaultDataDir = Join-Path $localAppData "OpenClawDeploy"
$dataDir = [IO.Path]::GetFullPath((Get-EnvOrDefault -Name "OPENCLAW_DEPLOY_DATA_DIR" -Default $defaultDataDir))
$stateDir = [IO.Path]::GetFullPath((Get-EnvOrDefault -Name "OPENCLAW_DEPLOY_STATE_DIR" -Default (Join-Path $dataDir "state")))
$releaseRoot = Join-Path $dataDir "releases"
$backupDir = Join-Path $dataDir "backups"
$stateFile = Join-Path $stateDir "state.json"
$lockFile = Join-Path $stateDir "deploy.lock"
$script:lockStream = $null

function Get-ReleasePath {
    param([string]$Sha)
    return Join-Path $releaseRoot $Sha
}

function Read-DeployState {
    if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) {
        return $null
    }
    $state = Get-Content -Raw -Encoding UTF8 -LiteralPath $stateFile | ConvertFrom-Json
    if ($null -eq $state.PSObject.Properties["previousSha"]) {
        $state | Add-Member -MemberType NoteProperty -Name "previousSha" -Value ""
    }
    if (-not [string]::IsNullOrWhiteSpace($state.currentSha)) {
        Assert-Sha -Sha $state.currentSha -Label "Current deployment state"
    }
    if (-not [string]::IsNullOrWhiteSpace($state.previousSha)) {
        Assert-Sha -Sha $state.previousSha -Label "Previous deployment state"
    }
    return $state
}

function Write-DeployState {
    param([string]$CurrentSha, [string]$PreviousSha)
    Assert-Sha -Sha $CurrentSha -Label "Current release"
    if (-not [string]::IsNullOrWhiteSpace($PreviousSha)) {
        Assert-Sha -Sha $PreviousSha -Label "Previous release"
    }
    $state = [ordered]@{ currentSha = $CurrentSha }
    if (-not [string]::IsNullOrWhiteSpace($PreviousSha)) {
        $state.previousSha = $PreviousSha
    }
    $temporary = "$stateFile.tmp.$PID"
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($temporary, ($state | ConvertTo-Json), $utf8NoBom)
    Move-Item -Force -LiteralPath $temporary -Destination $stateFile
}

function Initialize-Deployment {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw "This deployment helper is for native Windows servers."
    }
    foreach ($command in @("git", "node", "pnpm")) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw "Required command not found: $command"
        }
    }
    $nodeVersion = Invoke-NativeCapture -Command "node" -Arguments @("--version") -WorkingDirectory $repoRoot
    if ($nodeVersion -notmatch '^v([0-9]+)\.') {
        throw "Unable to determine the Node.js version from '$nodeVersion'."
    }
    if ([int]$Matches[1] -lt 22) {
        throw "Node.js 22 or newer is required (found $nodeVersion)."
    }
    Invoke-Native -Command "pnpm" -Arguments @("--version") -WorkingDirectory $repoRoot

    foreach ($directory in @($dataDir, $releaseRoot, $backupDir, $stateDir)) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }
    try {
        $script:lockStream = [IO.File]::Open(
            $lockFile,
            [IO.FileMode]::OpenOrCreate,
            [IO.FileAccess]::ReadWrite,
            [IO.FileShare]::None
        )
    }
    catch [IO.IOException] {
        throw "Another OpenClaw deployment is already running."
    }
}

function Get-OrCreateRelease {
    param([string]$Sha)
    $releaseDir = Get-ReleasePath -Sha $Sha
    if (Test-Path -LiteralPath $releaseDir -PathType Container) {
        $existingSha = Invoke-NativeCapture -Command "git" -Arguments @(
            "-C", $releaseDir, "rev-parse", "--verify", "HEAD^{commit}"
        ) -WorkingDirectory $repoRoot
        if ($existingSha -ne $Sha) {
            throw "Release path exists but is not the expected Git worktree: $releaseDir"
        }
    }
    else {
        Write-DeployLog "Creating isolated release $Sha."
        Invoke-Native -Command "git" -Arguments @(
            "-C", $repoRoot, "worktree", "add", "--detach", $releaseDir, $Sha
        ) -WorkingDirectory $repoRoot
    }
    return $releaseDir
}

function Restore-PreviousRelease {
    param([string]$PreviousSha)
    if (-not [string]::IsNullOrWhiteSpace($PreviousSha)) {
        Assert-Sha -Sha $PreviousSha -Label "Rollback release"
        $previousDir = Get-ReleasePath -Sha $PreviousSha
        if (Test-Path -LiteralPath (Join-Path $previousDir "dist\index.js") -PathType Leaf) {
            Enable-Release -ReleaseDirectory $previousDir
            Write-Warning "Deployment failed; restored the previous release $PreviousSha."
            return $true
        }
    }

    # Before the first managed deployment, the current built checkout is the rollback target.
    if (Test-Path -LiteralPath (Join-Path $repoRoot "dist\index.js") -PathType Leaf) {
        Enable-Release -ReleaseDirectory $repoRoot
        Write-Warning "Deployment failed; restored the pre-deployment checkout as a managed task."
        return $true
    }
    return $false
}

function Show-DeploymentStatus {
    $state = Read-DeployState
    if ($null -eq $state -or [string]::IsNullOrWhiteSpace($state.currentSha)) {
        throw "No managed release has been recorded yet."
    }
    Write-DeployLog "Current release: $($state.currentSha)"
    if (-not [string]::IsNullOrWhiteSpace($state.previousSha)) {
        Write-DeployLog "Rollback release: $($state.previousSha)"
    }
    $currentDir = Get-ReleasePath -Sha $state.currentSha
    Test-GatewayHealth -ReleaseDirectory $currentDir
}

function Invoke-Rollback {
    $state = Read-DeployState
    if (
        $null -eq $state -or
        [string]::IsNullOrWhiteSpace($state.currentSha) -or
        [string]::IsNullOrWhiteSpace($state.previousSha)
    ) {
        throw "No previous managed release is available for rollback."
    }
    $previousDir = Get-ReleasePath -Sha $state.previousSha
    if (-not (Test-Path -LiteralPath (Join-Path $previousDir "dist\index.js") -PathType Leaf)) {
        throw "Previous release is not built: $previousDir"
    }
    Write-DeployLog "Rolling back from $($state.currentSha) to $($state.previousSha)."
    Enable-Release -ReleaseDirectory $previousDir
    Write-DeployState -CurrentSha $state.previousSha -PreviousSha $state.currentSha
    Write-DeployLog "Rollback complete."
}

function Invoke-Deployment {
    $state = Read-DeployState
    $currentSha = ""
    if ($null -ne $state) {
        $currentSha = $state.currentSha
    }

    Write-DeployLog "Fetching $remote/$branch."
    Invoke-Native -Command "git" -Arguments @(
        "-C", $repoRoot, "fetch", "--prune", $remote, $branch
    ) -WorkingDirectory $repoRoot
    $targetSha = Invoke-NativeCapture -Command "git" -Arguments @(
        "-C", $repoRoot, "rev-parse", "--verify", "FETCH_HEAD^{commit}"
    ) -WorkingDirectory $repoRoot
    Assert-Sha -Sha $targetSha -Label "Fetched release"

    if ($currentSha -eq $targetSha) {
        $currentDir = Get-ReleasePath -Sha $currentSha
        try {
            Test-GatewayHealth -ReleaseDirectory $currentDir
            Write-DeployLog "Release $currentSha is already deployed and healthy."
            return
        }
        catch {
            Write-DeployLog "Current release is unhealthy; reinstalling its managed task."
            Enable-Release -ReleaseDirectory $currentDir
            Write-DeployLog "Release $currentSha is healthy."
            return
        }
    }

    $targetDir = Get-OrCreateRelease -Sha $targetSha
    Write-DeployLog "Installing locked dependencies."
    Invoke-Native -Command "pnpm" -Arguments @("install", "--frozen-lockfile") -WorkingDirectory $targetDir
    Write-DeployLog "Building and validating production output."
    Invoke-Native -Command "pnpm" -Arguments @("build") -WorkingDirectory $targetDir
    if (-not (Test-Path -LiteralPath (Join-Path $targetDir "dist\index.js") -PathType Leaf)) {
        throw "Build completed without dist/index.js."
    }

    Write-DeployLog "Creating and verifying a pre-migration backup."
    Invoke-OpenClaw -ReleaseDirectory $targetDir -Arguments @(
        "backup", "create", "--verify", "--no-include-workspace", "--output", $backupDir
    )
    Write-DeployLog "Running non-interactive configuration checks and migrations."
    Invoke-OpenClaw -ReleaseDirectory $targetDir -Arguments @("doctor", "--non-interactive")

    Write-DeployLog "Activating the Windows Scheduled Task."
    try {
        Enable-Release -ReleaseDirectory $targetDir
    }
    catch {
        $activationError = $_
        $restored = $false
        try {
            $restored = Restore-PreviousRelease -PreviousSha $currentSha
        }
        catch {
            Write-Warning "Automatic rollback also failed: $($_.Exception.Message)"
        }
        if ($restored) {
            throw "New release activation failed and the previous release was restored. Original error: $($activationError.Exception.Message)"
        }
        throw "New release activation failed and no automatic rollback target was available. Original error: $($activationError.Exception.Message)"
    }

    Write-DeployState -CurrentSha $targetSha -PreviousSha $currentSha
    Write-DeployLog "Deployment complete: $targetSha"
    Write-DeployLog "The gateway is now managed by Windows and can outlive this terminal."
}

try {
    if ($remote -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or $remote.Contains("..")) {
        throw "Invalid Git remote: $remote"
    }
    if ($branch -notmatch '^[A-Za-z0-9][A-Za-z0-9._/-]*$' -or $branch.Contains("..")) {
        throw "Invalid Git branch: $branch"
    }
    Invoke-NativeCapture -Command "git" -Arguments @(
        "-C", $repoRoot, "rev-parse", "--is-inside-work-tree"
    ) -WorkingDirectory $repoRoot | Out-Null
    Invoke-NativeCapture -Command "git" -Arguments @(
        "-C", $repoRoot, "remote", "get-url", $remote
    ) -WorkingDirectory $repoRoot | Out-Null
    Invoke-NativeCapture -Command "git" -Arguments @(
        "check-ref-format", "--branch", $branch
    ) -WorkingDirectory $repoRoot | Out-Null

    if ($Action -eq "dry-run") {
        Write-DeployLog "Dry run: deploy $remote/$branch into $releaseRoot."
        Write-DeployLog "Planned gates: locked install, build, backup, doctor, task restart, RPC health check."
        exit 0
    }

    Initialize-Deployment
    switch ($Action) {
        "deploy" { Invoke-Deployment }
        "status" { Show-DeploymentStatus }
        "rollback" { Invoke-Rollback }
    }
}
catch {
    [Console]::Error.WriteLine("[openclaw-deploy] ERROR: $($_.Exception.Message)")
    exit 1
}
finally {
    if ($null -ne $script:lockStream) {
        $script:lockStream.Dispose()
    }
}
