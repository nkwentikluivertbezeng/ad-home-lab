# DHCP scope for the internal network
# I did this in the DHCP console (New Scope wizard, then Authorize).
# This is the same configuration written in PowerShell.

Install-WindowsFeature DHCP -IncludeManagementTools

# Authorize the DHCP server in AD (same as right click > Authorize)
Add-DhcpServerInDC -DnsName "DC01.mydomain.com" -IPAddress 172.16.0.1

# Scope 172.16.0.100 - 172.16.0.200
Add-DhcpServerv4Scope -Name "172.16.0.100-200" `
    -StartRange 172.16.0.100 -EndRange 172.16.0.200 `
    -SubnetMask 255.255.255.0 -State Active

# Options given to the clients: gateway and DNS = the DC
Set-DhcpServerv4OptionValue -ScopeId 172.16.0.0 `
    -Router 172.16.0.1 -DnsServer 172.16.0.1 -DnsDomain "mydomain.com"

# Check: leases given to the clients
Get-DhcpServerv4Lease -ScopeId 172.16.0.0
