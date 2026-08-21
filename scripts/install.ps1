# keywork installer for Windows (PowerShell 5.1+ or 7).
#   irm https://raw.githubusercontent.com/JMoak/keywork/main/scripts/install.ps1 | iex
# Honors KEYWORK_VERSION (a release tag such as v0.1.0; default: latest) and
# KEYWORK_INSTALL_DIR (default: %LOCALAPPDATA%\keywork\bin). Verifies the SHA-256 before installing.
$ErrorActionPreference = "Stop"

$repo = "JMoak/keywork"
$version = if ($env:KEYWORK_VERSION) { $env:KEYWORK_VERSION } else { "latest" }
$installDir = if ($env:KEYWORK_INSTALL_DIR) { $env:KEYWORK_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "keywork\bin" }

$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -ne "AMD64") {
  throw "keywork: no release binary for Windows $arch yet; build from source (see README)"
}

$asset = "keywork-windows-x64.exe"
$base = if ($version -eq "latest") {
  "https://github.com/$repo/releases/latest/download"
} else {
  "https://github.com/$repo/releases/download/$version"
}

$workdir = Join-Path ([System.IO.Path]::GetTempPath()) ("keywork-install-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $workdir | Out-Null
try {
  Write-Host "downloading $asset ($version)"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri "$base/$asset" -OutFile (Join-Path $workdir $asset) -UseBasicParsing
  Invoke-WebRequest -Uri "$base/$asset.sha256" -OutFile (Join-Path $workdir "$asset.sha256") -UseBasicParsing

  $expected = ((Get-Content (Join-Path $workdir "$asset.sha256") -Raw).Trim() -split "\s+")[0].ToLowerInvariant()
  $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $workdir $asset)).Hash.ToLowerInvariant()
  if ($expected -ne $actual) {
    throw "keywork: checksum mismatch for $asset (expected $expected, got $actual)"
  }
  Write-Host "checksum verified"

  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Move-Item -Force (Join-Path $workdir $asset) (Join-Path $installDir "keywork.exe")
} finally {
  Remove-Item -Recurse -Force $workdir -ErrorAction SilentlyContinue
}

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($userPath -split ";") -notcontains $installDir) {
  [Environment]::SetEnvironmentVariable("Path", "$installDir;$userPath", "User")
  $env:Path = "$installDir;$env:Path"
  Write-Host "added $installDir to your user PATH (open a new terminal to pick it up)"
}

Write-Host ""
& (Join-Path $installDir "keywork.exe") --version
Write-Host "installed to $installDir\keywork.exe · run: keywork"
