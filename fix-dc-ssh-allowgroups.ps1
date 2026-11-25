#Requires -RunAsAdministrator
# Run ON THE DC as Domain Admin. Lets svc-n8n through sshd's AllowGroups
# by putting it in its own group, without opening SSH to anyone else.
$ErrorActionPreference = 'Stop'
Import-Module ActiveDirectory

$Group   = 'SSH-Automation'
$SvcName = 'svc-n8n'
# On the DC, "mydomain\\ssh-automation" never matched in AllowGroups.
# The wildcard form matches the group however sshd names it.
$entry   = "*$($Group.ToLower())"                 # -> *ssh-automation

# 1. Group + membership (group lives in the default Users container, outside 'Lab_users')
if (-not (Get-ADGroup -Filter "Name -eq '$Group'")) {
    New-ADGroup -Name $Group -GroupScope Global -GroupCategory Security `
        -Description 'Accounts allowed to SSH into the DC for automation (sshd AllowGroups)'
    Write-Host "created group $Group"
}
Add-ADGroupMember -Identity $Group -Members $SvcName
Write-Host "$SvcName is in $Group"

# 2. Add the group to the existing AllowGroups line
$cfg   = "$env:ProgramData\ssh\sshd_config"
$lines = Get-Content $cfg
$idx   = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match '^\s*AllowGroups\s' })
if ($idx.Count -ne 1) { throw "expected exactly one active AllowGroups line, found $($idx.Count) - send this to Claude" }
Write-Host "before: $($lines[$idx[0]])"
if ($lines[$idx[0]] -match [regex]::Escape($Group.ToLower())) {
    Write-Host "already listed"
} else {
    Copy-Item $cfg "$cfg.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    $lines[$idx[0]] = $lines[$idx[0]].TrimEnd() + " $entry"
    Set-Content -Path $cfg -Value $lines -Encoding ascii
    Write-Host "after:  $($lines[$idx[0]])"
}

# 3. Validate and restart
& "$env:SystemRoot\System32\OpenSSH\sshd.exe" -t
if ($LASTEXITCODE -ne 0) { throw "sshd_config has an error - restore the newest .bak file" }
Restart-Service sshd
Write-Host "`nsshd restarted. Tell Claude it's done." -ForegroundColor Green
