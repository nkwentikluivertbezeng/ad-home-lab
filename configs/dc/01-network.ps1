# DC network configuration
# I did this through the GUI (Network Connections > Properties > IPv4).
# This is the same configuration written in PowerShell.
# Run on the DC as administrator.

# 1. See the adapters: NAT one has a 10.x address, internal one has 169.254.x (no DHCP yet)
Get-NetIPAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, IPAddress

# 2. Rename them to match the diagram
#    TODO: replace "Ethernet" / "Ethernet 2" with the names shown on your DC
Rename-NetAdapter -Name "Ethernet"   -NewName "INTERNET"
Rename-NetAdapter -Name "Ethernet 2" -NewName "INTERNAL"

# 3. Static IP on the internal adapter, no gateway
New-NetIPAddress -InterfaceAlias "INTERNAL" -IPAddress 172.16.0.1 -PrefixLength 24

# 4. The DC is its own DNS server
Set-DnsClientServerAddress -InterfaceAlias "INTERNAL" -ServerAddresses 127.0.0.1
