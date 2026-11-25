#Requires -RunAsAdministrator
<#
  Run this ON THE DOMAIN CONTROLLER (server2025), in PowerShell as a Domain Admin.

  What it does (safe to run more than once):
    1. Creates the OU _USERS > Lab_users (if missing) - the only place n8n may make changes
    2. Creates the service account svc-n8n (NOT an admin)
    3. Delegates svc-n8n rights on that OU only:
         create/delete users, groups and sub-OUs, reset passwords,
         edit user and group properties (incl. group membership)
    4. Lets svc-n8n log in over SSH with n8n's key only
    5. Limits SSH (port 22) to the host-only network 192.168.56.0/24
#>
$ErrorActionPreference = 'Stop'
Import-Module ActiveDirectory

# ---- settings ---------------------------------------------------------------
$PubKey   = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEWAVNvzlgDp0AEDgW5HY9FFl27YowbqfDKUisJVPJqk n8n-ad-automation'
$OuName   = 'Lab_users'
$OuParent = 'OU=_USERS'   # Lab_users lives inside _USERS
$SvcName  = 'svc-n8n'
$HostOnly = '192.168.56.0/24'
# -----------------------------------------------------------------------------

$domain   = Get-ADDomain
$domainDN = $domain.DistinguishedName
$parentDN = "$OuParent,$domainDN"
$ouDN     = "OU=$OuName,$parentDN"
$id       = "$($domain.NetBIOSName)\$SvcName"

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }

# 1. OU -----------------------------------------------------------------------
Step "OU '$OuName'"
if (Get-ADOrganizationalUnit -Filter "DistinguishedName -eq '$ouDN'") {
    Write-Host "already exists"
} else {
    New-ADOrganizationalUnit -Name $OuName -Path $parentDN -ProtectedFromAccidentalDeletion $true
    Write-Host "created $ouDN"
}

# 2. Service account (kept in the default Users container, NEVER inside Lab_users,
#    so it can never reset its own password or edit itself) ---------------------
Step "Service account $SvcName"
if (Get-ADUser -Filter "SamAccountName -eq '$SvcName'") {
    Write-Host "already exists"
} else {
    Write-Host "n8n logs in with an SSH key, so you won't need this password day to day."
    $pw = Read-Host "Choose a strong password for $SvcName" -AsSecureString
    New-ADUser -Name $SvcName -SamAccountName $SvcName `
        -UserPrincipalName "$SvcName@$($domain.DNSRoot)" `
        -AccountPassword $pw -Enabled $true -PasswordNeverExpires $true `
        -Description 'n8n automation account - SSH key login only, rights on _USERS > Lab_users only'
    Write-Host "created $id"
}

# 3. Delegation on 'Lab_users' only ----------------------------------------------
Step "Delegating rights on $ouDN"
function Grant($inherit, $perm) {
    $out = dsacls $ouDN $inherit /G "${id}:$perm" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "dsacls failed for '$perm':`n$out" }
    Write-Host "  granted $perm"
}
Grant '/I:T' 'CCDC;user'                 # create/delete users
Grant '/I:T' 'CCDC;group'                # create/delete groups
Grant '/I:T' 'CCDC;organizationalUnit'   # create/delete sub-OUs
Grant '/I:S' 'CA;Reset Password;user'    # reset passwords
Grant '/I:S' 'WP;;user'                  # edit user properties (enable/disable, name, etc.)
Grant '/I:S' 'WP;;group'                 # edit groups, incl. membership

# 4. SSH key login for svc-n8n -----------------------------------------------------
#    The key lives in ProgramData (like the admin key file), so it works even
#    before svc-n8n has ever logged on and has a profile folder.
Step "SSH key for $SvcName"
$keyFile = "$env:ProgramData\ssh\n8n_authorized_keys"
Set-Content -Path $keyFile -Value $PubKey -Encoding ascii
icacls $keyFile /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
Write-Host "wrote $keyFile"

$cfg = "$env:ProgramData\ssh\sshd_config"
if (Select-String -Path $cfg -Pattern 'n8n_authorized_keys' -Quiet) {
    Write-Host "sshd_config already set"
} else {
    Copy-Item $cfg "$cfg.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Add-Content -Path $cfg -Encoding ascii -Value @"

# n8n automation account: key login only
Match User *svc-n8n
       AuthorizedKeysFile __PROGRAMDATA__/ssh/n8n_authorized_keys
       PasswordAuthentication no
"@
    Write-Host "added Match block to sshd_config (backup saved next to it)"
}
& "$env:SystemRoot\System32\OpenSSH\sshd.exe" -t
if ($LASTEXITCODE -ne 0) { throw "sshd_config has an error - restore the .bak file" }
Restart-Service sshd
Write-Host "sshd restarted"

# 5. Firewall: SSH only from the host-only network --------------------------------
Step "Firewall"
$rules = Get-NetFirewallRule -Direction Inbound -Enabled True |
    Where-Object { ($_ | Get-NetFirewallPortFilter).LocalPort -contains '22' }
if (-not $rules) {
    Write-Warning "no enabled inbound rule for port 22 found - check Windows Firewall manually"
}
foreach ($r in $rules) {
    $r | Set-NetFirewallRule -RemoteAddress $HostOnly
    Write-Host "  '$($r.DisplayName)' now only allows $HostOnly"
}

Write-Host "`nDone. Tell Claude it finished so it can test the login from your PC." -ForegroundColor Green
