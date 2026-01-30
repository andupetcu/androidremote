# Android Remote Agent - Windows Installer
# Usage: .\install-windows.ps1 -Server "https://server:7899" -Token "ABC123"
#
# Parameters:
#   -Server       Server URL (required)
#   -Token        Enrollment token (required)
#   -InstallDir   Installation directory (default: C:\Program Files\AndroidRemoteAgent)
#   -ServiceName  Windows service name (default: AndroidRemoteAgent)
#   -NoService    Don't register as Windows service

param(
    [Parameter(Mandatory=$true)]
    [string]$Server,

    [Parameter(Mandatory=$true)]
    [string]$Token,

    [string]$InstallDir = "C:\Program Files\AndroidRemoteAgent",

    [string]$ServiceName = "AndroidRemoteAgent",

    [switch]$NoService
)

$ErrorActionPreference = "Stop"

Write-Host "=== Android Remote Agent Installer ===" -ForegroundColor Cyan
Write-Host "Server:  $Server"
Write-Host "Install: $InstallDir"
Write-Host ""

# Detect architecture
$arch = if ([System.Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
$os = "windows"

# Convert ws(s) URL to http(s) for API calls
$apiBase = $Server -replace '^wss://', 'https://' -replace '^ws://', 'http://'

# Check for latest binary
Write-Host "Checking for agent binary..."
try {
    $latest = Invoke-RestMethod -Uri "${apiBase}/api/agent/latest?os=${os}&arch=${arch}" -Method Get
} catch {
    Write-Host "Error: No agent binary available for ${os}/${arch}" -ForegroundColor Red
    Write-Host "Upload one first via POST /api/agent/upload"
    exit 1
}

$downloadUrl = $latest.url
$version = $latest.version
$expectedSha256 = $latest.sha256

Write-Host "Downloading agent v${version}..."

# Create install directory
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

# Download binary
$tempFile = Join-Path $env:TEMP "android-remote-agent-download.exe"
Invoke-WebRequest -Uri $downloadUrl -OutFile $tempFile

# Verify checksum
$hash = (Get-FileHash -Path $tempFile -Algorithm SHA256).Hash.ToLower()
if ($hash -ne $expectedSha256) {
    Write-Host "Error: Checksum mismatch!" -ForegroundColor Red
    Write-Host "  Expected: $expectedSha256"
    Write-Host "  Got:      $hash"
    Remove-Item $tempFile -Force
    exit 1
}

Write-Host "Checksum verified." -ForegroundColor Green

# Stop existing service if running
if (-not $NoService) {
    $existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existingService -and $existingService.Status -eq 'Running') {
        Write-Host "Stopping existing service..."
        Stop-Service -Name $ServiceName -Force
        Start-Sleep -Seconds 2
    }
}

# Install binary
$binaryPath = Join-Path $InstallDir "android-remote-agent.exe"
Move-Item -Path $tempFile -Destination $binaryPath -Force

Write-Host "Installed to $binaryPath"

# Enroll the agent
Write-Host "Enrolling agent..."
$enrollProcess = Start-Process -FilePath $binaryPath -ArgumentList "--server-url", $Server, "--enroll-token", $Token, "--foreground" -NoNewWindow -PassThru

# Wait for enrollment
Start-Sleep -Seconds 5
if (-not $enrollProcess.HasExited) {
    Stop-Process -Id $enrollProcess.Id -Force -ErrorAction SilentlyContinue
}

Write-Host "Enrollment complete."

# Register as Windows Service
if (-not $NoService) {
    Write-Host "Configuring Windows service..."

    $existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existingService) {
        Write-Host "Updating existing service..."
        sc.exe config $ServiceName binPath= "`"$binaryPath`" --server-url `"$Server`""
    } else {
        Write-Host "Creating new service..."
        New-Service -Name $ServiceName `
            -DisplayName "Android Remote Agent" `
            -Description "Cross-platform remote management agent" `
            -BinaryPathName "`"$binaryPath`" --server-url `"$Server`"" `
            -StartupType Automatic
    }

    # Configure service recovery (restart on failure)
    sc.exe failure $ServiceName reset= 86400 actions= restart/10000/restart/30000/restart/60000

    # Start the service
    Start-Service -Name $ServiceName
    Write-Host "Service started: $ServiceName" -ForegroundColor Green

    Get-Service -Name $ServiceName | Format-Table -AutoSize
}

Write-Host ""
Write-Host "=== Installation Complete ===" -ForegroundColor Cyan
Write-Host "Binary:  $binaryPath"
Write-Host "Version: $version"
if (-not $NoService) {
    Write-Host "Service: $ServiceName"
    Write-Host ""
    Write-Host "Manage with:"
    Write-Host "  Get-Service $ServiceName"
    Write-Host "  Restart-Service $ServiceName"
    Write-Host "  Get-EventLog -LogName Application -Source $ServiceName -Newest 20"
}
