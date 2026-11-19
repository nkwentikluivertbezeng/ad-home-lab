# Install AD DS and create the forest mydomain.com
# I did this through Server Manager (Add roles > AD DS > Promote to DC > Add a new forest).
# This is the same configuration written in PowerShell.

Install-WindowsFeature AD-Domain-Services -IncludeManagementTools

# Creates the forest + DNS. It asks for the DSRM password (never write it in the script).
# The server reboots at the end.
Install-ADDSForest -DomainName "mydomain.com" -InstallDns
