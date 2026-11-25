#Requires -RunAsAdministrator
<#
  Run ON THE DC as Domain Admin. Merges the two "lab users" OUs into one:
    keep:   _USERS > Lab_users   (OU=Lab_users,OU=_USERS,...)
    remove: Lab Users            (OU=Lab Users,... - created by setup-dc-n8n.ps1)

  1. Moves svc-n8n OUT of Lab_users (n8n must never manage its own account)
  2. Gives svc-n8n the same delegated rights on Lab_users
  3. Moves everything from the old "Lab Users" (Joel Brice) into Lab_users
  4. Deletes the old, now-empty "Lab Users" OU (its permissions go with it)
#>
$ErrorActionPreference = 'Stop'
Import-Module ActiveDirectory

$domain = Get-ADDomain
$dn     = $domain.DistinguishedName
$old    = "OU=Lab Users,$dn"
$new    = "OU=Lab_users,OU=_USERS,$dn"
$id     = "$($domain.NetBIOSName)\svc-n8n"
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

Get-ADOrganizationalUnit $new | Out-Null   # stop here if the target OU is missing

# 1. svc-n8n out of the managed OU ------------------------------------------------
Step 'svc-n8n location'
$svc = Get-ADUser svc-n8n
if ($svc.DistinguishedName.EndsWith(",$new")) {
    Move-ADObject -Identity $svc -TargetPath "CN=Users,$dn"
    Write-Host "moved svc-n8n to CN=Users"
} else {
    Write-Host "already outside Lab_users: $($svc.DistinguishedName)"
}

# 2. delegation on Lab_users --------------------------------------------------------
Step "Delegating rights on $new"
function Grant($inherit, $perm) {
    $out = dsacls $new $inherit /G "${id}:$perm" 2>&1
    if ($LASTEXITCODE -ne 0) { throw "dsacls failed for '$perm':`n$out" }
    Write-Host "  granted $perm"
}
Grant '/I:T' 'CCDC;user'
Grant '/I:T' 'CCDC;group'
Grant '/I:T' 'CCDC;organizationalUnit'
Grant '/I:S' 'CA;Reset Password;user'
Grant '/I:S' 'WP;;user'
Grant '/I:S' 'WP;;group'

# 3 + 4. move contents of the old OU, then delete it ----------------------------------
Step "Old OU $old"
if (Get-ADOrganizationalUnit -Filter "DistinguishedName -eq '$old'") {
    $kids = @(Get-ADObject -SearchBase $old -SearchScope OneLevel -Filter *)
    foreach ($k in $kids) {
        if ($k.ObjectClass -eq 'organizationalUnit') {
            Set-ADOrganizationalUnit -Identity $k -ProtectedFromAccidentalDeletion $false
        }
        Move-ADObject -Identity $k -TargetPath $new
        Write-Host "  moved $($k.ObjectClass) '$($k.Name)' to Lab_users"
    }
    if (@(Get-ADObject -SearchBase $old -SearchScope OneLevel -Filter *).Count -ne 0) { throw "old OU is not empty - stopping" }
    Set-ADOrganizationalUnit -Identity $old -ProtectedFromAccidentalDeletion $false
    Remove-ADOrganizationalUnit -Identity $old -Confirm:$false
    Write-Host "deleted $old"
} else {
    Write-Host "already gone"
}

# result -------------------------------------------------------------------------------
Step 'Result'
Get-ADObject -SearchBase $new -SearchScope OneLevel -Filter * | ForEach-Object { "  $($_.ObjectClass): $($_.Name)" }
Write-Host "`nDone. Tell Claude so it can switch n8n over and test." -ForegroundColor Green
