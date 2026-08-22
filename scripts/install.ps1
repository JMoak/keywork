# keywork installer for Windows (PowerShell 5.1+ or 7).
#   irm https://raw.githubusercontent.com/JMoak/keywork/main/scripts/install.ps1 | iex
# Honors KEYWORK_VERSION (a release tag such as v0.1.0; default: latest) and
# KEYWORK_INSTALL_DIR (default: %LOCALAPPDATA%\keywork\bin). Checks the download's SHA-256
# against the published .sha256 from the same release (unsigned, same origin: this catches a
# corrupt download, not a compromised release).
$ErrorActionPreference = "Stop"

$repo = "JMoak/keywork"
$version = if ($env:KEYWORK_VERSION) { $env:KEYWORK_VERSION } else { "latest" }
$installDir = if ($env:KEYWORK_INSTALL_DIR) { $env:KEYWORK_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "keywork\bin" }

function Get-MachineArchitecture {
  if ($env:PROCESSOR_ARCHITEW6432) { return $env:PROCESSOR_ARCHITEW6432 }
  return $env:PROCESSOR_ARCHITECTURE
}

function Add-UserPathEntry([string] $Directory, [string] $KeyPath = "HKCU:\Environment") {
  $key = Get-Item -Path $KeyPath
  $hasPath = $key.GetValueNames() -contains "Path"
  $unexpanded = if ($hasPath) {
    [string] $key.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  } else { "" }
  $kind = if ($hasPath) { $key.GetValueKind("Path") } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
  $entries = @($unexpanded -split ";" | Where-Object { $_ -ne "" })
  $present = @($entries | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd("\") })
  if ($present -contains $Directory.TrimEnd("\")) { return $false }
  $updated = (@($Directory) + $entries) -join ";"
  New-ItemProperty -Path $KeyPath -Name "Path" -Value $updated -PropertyType $kind -Force | Out-Null
  return $true
}

function Send-EnvironmentChangedBroadcast {
  $signature = @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
  try {
    $user32 = Add-Type -MemberDefinition $signature -Name "User32" -Namespace "KeyworkInstall" -PassThru
    $broadcast = [IntPtr] 0xffff
    $settingChange = 0x001A
    $abortIfHung = 0x0002
    $result = [UIntPtr]::Zero
    [void] $user32::SendMessageTimeout($broadcast, $settingChange, [UIntPtr]::Zero, "Environment", $abortIfHung, 5000, [ref] $result)
  } catch {
    Write-Host "could not notify running programs of the PATH change; open a new terminal to pick it up"
  }
}

$arch = Get-MachineArchitecture
if ($arch -ne "AMD64") {
  if ($arch -eq "ARM64") {
    throw "keywork: no Windows ARM64 release yet (the x64 build under emulation is untested); build from source (see README)"
  }
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
  Write-Host "checksum matches the published .sha256"

  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  Move-Item -Force (Join-Path $workdir $asset) (Join-Path $installDir "keywork.exe")
} finally {
  Remove-Item -Recurse -Force $workdir -ErrorAction SilentlyContinue
}

if (Add-UserPathEntry -Directory $installDir) {
  Send-EnvironmentChangedBroadcast
  $env:Path = "$installDir;$env:Path"
  Write-Host "added $installDir to your user PATH (open a new terminal to pick it up)"
}

Write-Host ""
& (Join-Path $installDir "keywork.exe") --version
Write-Host "installed to $installDir\keywork.exe · run: keywork"
