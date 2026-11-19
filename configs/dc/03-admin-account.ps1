# Dedicated admin account instead of the built-in Administrator
# I did this in Active Directory Users and Computers.
# This is the same configuration written in PowerShell.

# TODO: put the real OU name and admin username you used
$OuName    = "_ADMINS"
$AdminUser = "a-admin"

New-ADOrganizationalUnit -Name $OuName -Path "DC=mydomain,DC=com"

# Asks for the password instead of writing it in the script
New-ADUser -Name $AdminUser -SamAccountName $AdminUser `
    -Path "OU=$OuName,DC=mydomain,DC=com" `
    -AccountPassword (Read-Host "Password" -AsSecureString) `
    -Enabled $true

# Domain Admins is a group (not an OU)
Add-ADGroupMember -Identity "Domain Admins" -Members $AdminUser
