# Configurations

I built the lab through the GUI (Server Manager, ADUC, DHCP console). The files here write the **same configuration as code**, with the same values, so it is easy to read, review and rebuild.

> No secrets in this folder: passwords are asked at runtime with `Read-Host`, and agent keys are never committed.

## `dc/` - Domain controller

| File | What it configures |
|---|---|
| [`01-network.ps1`](dc/01-network.ps1) | Rename adapters INTERNET / INTERNAL, static IP 172.16.0.1/24, DNS 127.0.0.1 |
| [`02-ad-ds-forest.ps1`](dc/02-ad-ds-forest.ps1) | Install AD DS, create forest `mydomain.com` with DNS |
| [`03-admin-account.ps1`](dc/03-admin-account.ps1) | Admin OU, dedicated admin user, Domain Admins membership |
| [`04-ras-nat.ps1`](dc/04-ras-nat.ps1) | Routing + NAT (INTERNET = public, INTERNAL = private) |

## `dhcp/`

| File | What it configures |
|---|---|
| [`dhcp-scope.ps1`](dhcp/dhcp-scope.ps1) | Authorize DHCP in AD, scope 172.16.0.100-200, router and DNS = 172.16.0.1 |

To export the real DHCP config from the DC:

```powershell
Export-DhcpServer -ComputerName localhost -File C:\dhcp-export.xml -Leases
```

## `wazuh/`

| File | What it configures |
|---|---|
| [`ossec-agent.conf`](wazuh/ossec-agent.conf) | Windows agent: manager 172.16.0.10, event logs collected (Security, System, Application, PowerShell, Sysmon) |

Real file on the agent: `C:\Program Files (x86)\ossec-agent\ossec.conf`. Remove any `<key>` or password before committing.
