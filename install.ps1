# IQ Code marketplace installer for Windows PowerShell 5.1 and PowerShell 7.
& {
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
# Public marketplace repository.
$IQ_PUBLIC_REPO = 'IQ-Routing/IQ-Code'
$Uninstall = $env:IQ_CODE_UNINSTALL -eq '1'
$Purge = $env:IQ_CODE_PURGE -eq '1'
$Help = $env:IQ_CODE_HELP -eq '1'
foreach ($option in $args) {
    switch -Regex ($option) {
        '^(?:-Uninstall|--uninstall)$' { $Uninstall = $true; break }
        '^(?:-Purge|--purge)$' { $Purge = $true; break }
        '^(?:-Help|--help)$' { $Help = $true; break }
        default { throw 'install.ps1: unknown option; use -Help' }
    }
}

function Assert-PlainPath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing a data directory reparse point: $cursor" }
            if (-not $item.PSIsContainer) { throw "Not a directory: $cursor" }
        }
        $parent = [IO.Path]::GetDirectoryName($cursor)
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
}

function Set-PrivateDirectory([string]$Path) {
    Assert-PlainPath $Path
    [void][IO.Directory]::CreateDirectory($Path)
    Assert-PlainPath $Path
    # Replace inherited and explicit grants with the current user's SID only.
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($sid)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
    $actual = Get-Acl -LiteralPath $Path
    if (-not $actual.AreAccessRulesProtected) { throw 'IQ data ACL inheritance is still enabled' }
    $rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'IQ data ACL is not user-only' }
}

function Assert-PlainTree([string]$Path) {
    # Enumerate each level explicitly; PS5.1 recursion can follow junctions.
    foreach ($item in Get-ChildItem -LiteralPath $Path -Force) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing to purge an IQ data tree with a reparse point' }
        if ($item.PSIsContainer) { Assert-PlainTree $item.FullName }
    }
}

function Invoke-Claude([string[]]$CliArgs) {
    & $claudeCommand @CliArgs
    if ($LASTEXITCODE -ne 0) { throw "Claude Code command failed (exit $LASTEXITCODE): $($CliArgs -join ' ')" }
}

function Read-IqKey {
    if (-not [Console]::IsInputRedirected) {
        return Read-Host 'IQ key (optional; Enter skips)' -AsSecureString
    }
    return $null
}

function Set-IqKey {
    $secure = $null
    $pointer = [IntPtr]::Zero
    $plain = $null
    $json = $null
    try {
        # A redirected invocation skips the optional prompt. CMD delegates here.
        $secure = Read-IqKey
        if ($null -eq $secure -or $secure.Length -eq 0) {
            Write-Host 'Add your IQ key with /plugin configure iq-code@iq-routing, then /reload-plugins.'
            return
        }
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        $json = @{ iq_api_key = $plain } | ConvertTo-Json -Compress
        # Pipeline input is redirected, not a TTY. The value is never an argument.
        $previousPreference = $ErrorActionPreference
        try {
            # PS5.1 treats redirected native stderr as ErrorRecord; judge only the exit code.
            $ErrorActionPreference = 'Continue'
            $json | & $claudeCommand plugin configure iq-code@iq-routing --values-stdin 2>&1 | Out-Null
            $code = $LASTEXITCODE
        } finally { $ErrorActionPreference = $previousPreference }
        if ($code -ne 0) { throw 'Could not save IQ key; use /plugin configure iq-code@iq-routing' }
        Write-Host 'IQ key saved. Apply key changes with /reload-plugins or a restart.'
    } catch {
        # A downstream error could contain input; expose only a fixed message.
        throw 'Could not save IQ key; use /plugin configure iq-code@iq-routing'
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        if ($null -ne $secure) { $secure.Dispose() }
        $plain = $null
        $json = $null
    }
}

function Show-ShadowWarning([string]$HomeDir) {
    $remaining = @()
    $shadow = $false
    foreach ($entry in ($env:CLAUDE_CODE_PLUGIN_DIRS -split ';')) {
        if ([string]::IsNullOrEmpty($entry)) { continue }
        $candidate = $entry
        if ($candidate -eq '~') { $candidate = $HomeDir }
        elseif ($candidate -match '^~[\\/]') { $candidate = Join-Path $HomeDir $candidate.Substring(2) }
        $isIq = $false
        if ($candidate -match '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)') {
            $manifest = Join-Path $candidate '.claude-plugin\plugin.json'
            if (Test-Path -LiteralPath $manifest -PathType Leaf) {
                try {
                    $item = Get-Item -LiteralPath $manifest -Force
                    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
                        $plugin = [IO.File]::ReadAllText($manifest) | ConvertFrom-Json
                        $isIq = $plugin.name -ceq 'iq'
                    }
                }
                catch { $isIq = $false }
            }
        }
        if ($isIq) {
            $shadow = $true
            Write-Warning "Legacy local plugin iq at $entry would load alongside iq-code and double the hooks."
            Write-Host "Remove this entry from CLAUDE_CODE_PLUGIN_DIRS in your shell profile, Windows environment variables, or the env block of Claude settings: $entry"
        } else { $remaining += $entry }
    }
    if ($shadow) {
        $value = $remaining -join ';'
        if ($value) { Write-Host ("In PowerShell, run: `$env:CLAUDE_CODE_PLUGIN_DIRS = '" + $value.Replace("'", "''") + "'") }
        else { Write-Host 'In PowerShell, run: Remove-Item Env:CLAUDE_CODE_PLUGIN_DIRS -ErrorAction SilentlyContinue' }
        Write-Host ('In CMD, run: set "CLAUDE_CODE_PLUGIN_DIRS=' + $value + '"')
        Write-Host 'Then restart Claude Code. The installer does not edit that variable or your settings.'
    }
}

try {
    if ($Help) {
        Write-Host 'Usage: install.ps1 [-Uninstall [-Purge]]'
        Write-Host 'Installs iq-code@iq-routing through Claude Code. Uninstall keeps ~/.claude/iq unless -Purge is given.'
        return
    }
    if ($Purge -and -not $Uninstall) { throw '-Purge requires -Uninstall' }
    $homeDir = $env:HOME
    if ([string]::IsNullOrEmpty($homeDir)) { $homeDir = $env:USERPROFILE }
    if ([string]::IsNullOrEmpty($homeDir)) { throw 'HOME and USERPROFILE are unset; no files were changed' }
    if ($env:OS -ne 'Windows_NT') { throw 'Use install.sh on macOS or Linux' }
    if ($homeDir -notmatch '^[A-Za-z]:[\\/]') { throw 'HOME (or USERPROFILE) must be a local absolute Windows path' }
    $homeDir = [IO.Path]::GetFullPath($homeDir)
    if (-not (Test-Path -LiteralPath $homeDir -PathType Container)) { throw 'Home directory does not exist' }
    $iqDir = Join-Path $homeDir '.claude\iq'
    Assert-PlainPath $iqDir
    if (-not $Uninstall -and $IQ_PUBLIC_REPO -match '[{}]|^$') { throw 'This installer is misconfigured; download it again from iq-routing.com' }
    $command = Get-Command claude -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $command) { throw 'Claude Code 2.1.287+ is required. Install it: https://code.claude.com/docs/en/setup' }
    $claudeCommand = $command.Source
    $versionText = (& $claudeCommand --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not read the Claude Code version' }
    if ($versionText -notmatch '^v?(\d+\.\d+\.\d+)(?:\s|\+|$)' -or [version]$Matches[1] -lt [version]'2.1.287') { throw 'Claude Code 2.1.287+ is required. Update it: https://code.claude.com/docs/en/setup' }
    Show-ShadowWarning $homeDir
    if ($Uninstall) {
        Invoke-Claude @('plugin', 'uninstall', 'iq-code@iq-routing', '--scope', 'user')
        if ($Purge) {
            Assert-PlainPath $iqDir
            if (Test-Path -LiteralPath $iqDir) {
                Assert-PlainTree $iqDir
                Remove-Item -LiteralPath $iqDir -Force -Recurse
            }
            Write-Host "IQ Code uninstalled. Removed $iqDir. The iq-routing marketplace remains registered."
        } else {
            Write-Host "IQ Code uninstalled. Left $iqDir (IQ settings, logs and any saved key). The iq-routing marketplace remains registered."
            Write-Host 'To remove IQ data too, run install.ps1 -Uninstall -Purge.'
        }
        return
    }
    if ($null -eq (Get-Command git -CommandType Application -ErrorAction SilentlyContinue)) { throw 'Git for Windows is required. Install it: https://code.claude.com/docs/en/setup#set-up-on-windows' }
    Set-PrivateDirectory $iqDir
    $previousHttps = $env:CLAUDE_CODE_PLUGIN_PREFER_HTTPS
    try {
        $env:CLAUDE_CODE_PLUGIN_PREFER_HTTPS = '1'
        Invoke-Claude @('plugin', 'marketplace', 'add', $IQ_PUBLIC_REPO)
    } finally { $env:CLAUDE_CODE_PLUGIN_PREFER_HTTPS = $previousHttps }
    Invoke-Claude @('plugin', 'install', 'iq-code@iq-routing', '--scope', 'user')
    Write-Host 'IQ Code installed. Start Claude Code and run /iq.'
    Set-IqKey
    Write-Host 'If a session is already open, run /reload-plugins.'
} catch {
    throw "install.ps1: $($_.Exception.Message)"
}
} @args
