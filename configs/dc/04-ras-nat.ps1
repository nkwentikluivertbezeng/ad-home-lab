# RAS / NAT so the clients reach the internet through the DC
# I did this through Server Manager (Remote Access > Routing) and the Routing and Remote Access console.
# This is the same configuration written in PowerShell / netsh.

Install-WindowsFeature Routing -IncludeManagementTools
Install-RemoteAccess -VpnType RoutingOnly

# INTERNET = public side, INTERNAL = private side (the clients)
netsh routing ip nat install
netsh routing ip nat add interface "INTERNET" full
netsh routing ip nat add interface "INTERNAL" private
