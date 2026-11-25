# Active Directory Home Lab

> **Status: work in progress.** The lab is built and running. I'm still adding the documentation, screenshots and alert triage notes, especially for the Wazuh part.

A small Active Directory lab I built in VirtualBox to understand how a company network works from the inside: a domain controller that gives out IP addresses (DHCP), routes clients to the internet (NAT), and manages users, a Windows client that joins the domain, and Wazuh to monitor the machines and triage alerts.

The newest part: an **AI assistant (Claude) that can do supervised AD admin work** through n8n and MCP, limited to one OU and a fixed set of tested tools ([section 10](#10-managing-ad-with-an-ai-assistant-n8n--mcp)).


## Architecture

```mermaid
flowchart LR
    NET((Internet)) --- NIC1
    subgraph DC["Domain Controller - Windows Server 2025"]
        NIC1["NIC 'INTERNET'<br/>VirtualBox NAT<br/>DHCP from host"]
        NIC2["NIC 'INTERNAL'<br/>IP 172.16.0.1/24<br/>DNS 127.0.0.1"]
        ROLES["AD DS (mydomain.com)<br/>DNS<br/>RAS / NAT<br/>DHCP"]
    end
    NIC2 --- SW[VirtualBox internal network]
    SW --- CLIENT["CLIENT1 - Windows client<br/>IP from DHCP (172.16.0.100-200)"]
    SW --- WAZUH["Wazuh server<br/>(Docker / IP)"]
```

| Item | Value |
|---|---|
| Hypervisor | Oracle VirtualBox |
| Domain controller | Windows Server 2025, 2 network adapters |
| Client | Windows <!-- TODO: 10 or 11? --> |
| Domain | `mydomain.com` |
| DC internal IP | `172.16.0.1` / `255.255.255.0`, no gateway, DNS `127.0.0.1` |
| DHCP scope | `172.16.0.100` - `172.16.0.200`, mask `255.255.255.0`, gateway and DNS `172.16.0.1` |

![VirtualBox VMs](screenshots/01-virtualbox-vms-overview.png)

## 1. Network adapters on the DC

The DC has two adapters:
- **INTERNET** (VirtualBox NAT): gets an address from VirtualBox (starts with `10.`), so the DC can reach the internet.
- **INTERNAL** (VirtualBox internal network): talks to the clients.

Before configuring anything, the internal adapter had an address starting with `169.254.` (APIPA). That means it asked for an IP from a DHCP server and got no answer, which is normal because there was no DHCP server yet. I renamed both adapters so I don't mix them up later.

![Adapters renamed](screenshots/02-dc-network-adapters-renamed.png)

Then I gave the internal adapter a static IP (Properties > IPv4):

```
IP       172.16.0.1
Mask     255.255.255.0
Gateway  (empty)
DNS      127.0.0.1   (the DC will be its own DNS server)
```

![Internal NIC static IP](screenshots/03-internal-nic-static-ip.png)

## 2. Install Active Directory and promote the DC

- Server Manager > Add roles and features > **Active Directory Domain Services**.
- Clicked the yellow flag > **Promote this server to a domain controller** > **Add a new forest** > `mydomain.com`.
- The server reboots (it took a long time for me, around 30 min).


## 3. Dedicated admin account

Instead of using the built-in Administrator, I created my own admin:
- In **Active Directory Users and Computers**, created an OU for admins <!-- TODO: put the real OU name --> (an OU is like a folder to organise users and computers and apply policies to them).
- Created a user in it and added it to the **Domain Admins** group.
- Signed out and signed back in with this account.


## 4. RAS / NAT (so clients can reach the internet through the DC)

- Add roles and features > **Remote Access** > role service **Routing**.
- Tools > Routing and Remote Access > right click the DC > Configure > **NAT**, using the INTERNET adapter as the public interface.
<!--
![RAS NAT](screenshots/08-ras-nat-routing-configured.png)
-->
## 5. DHCP

DHCP gives an IP address automatically to new devices on the network.

- Add roles and features > **DHCP Server**.
- Tools > DHCP > IPv4 > New scope: range `172.16.0.100-200`, router (gateway) `172.16.0.1`, DNS `172.16.0.1`.
- Right click the server > **Authorize**, then refresh (the IPv4 icon turns green).

![DHCP scope](screenshots/09-dhcp-scope-configured.png)

## 6. Create users with PowerShell

To have realistic data, I created many users at once with a PowerShell script from Josh Madakor's [AD_PS repository](https://github.com/joshmadakor1/AD_PS) (not my script, credit to him).

```powershell
# allow scripts only for this PowerShell window
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\1_CREATE_USERS.ps1
```

`-Scope Process` means the policy only changes for this session, not for the whole machine.

![Users created](screenshots/12-aduc-users-created.png)

## 7. Join the client to the domain

- Client VM on the **internal network** only.
- Checked it received an IP from the DC with `ipconfig /all` (172.16.0.x, DNS 172.16.0.1).
- Settings > Rename this PC (advanced) > Change > member of domain `mydomain.com`, using the admin account.
- Rebooted and signed in with one of the created domain users.
<!--
![Client got DHCP address](screenshots/13-client-ipconfig-dhcp-address.png)
![Join domain](screenshots/14-client-join-domain.png)
![Login as domain user](screenshots/15-client-login-domain-user.png)
-->
On the DC, the client shows up in the DHCP leases and in AD Users and Computers > Computers:
<!--
![DHCP lease](screenshots/16-dhcp-address-leases.png)
-->

## 8. Basic attacks

I used a created a username file , for simplicity i created the user.txt file from the users i already added the AD users . and added the password at the top of the password.txt file. 
i then used crackmapexec to enumerate the users and try to find a valid user which and did and used his creds to list the shares.
![crackmapexec](screenshots/04.png)

### Kerberoasting

![kerberoasting](screenshots/kerberoasting.png)

## 9. Monitoring with Wazuh

After the domain was working, I added Wazuh (open-source SIEM / XDR) to gain visibility into events occurring across the lab environment and to practice alert analysis and triage.

| Item | Value |
|---|---|
| Wazuh server | Ubuntu Server 22.04 VM (172.16.0.10) |
| Agents installed on | DC01 (Windows Server 2022), CLIENT1 (Windows 11) |
| Wazuh version | 4.8.x |

### Alert triage

When an alert appeared, I first checked the rule level and description to understand its severity. I then identified the affected host, user account, timestamp, and associated events. Next, I correlated the alert with actions I had performed in the lab to determine whether it was expected activity, a false positive, or something requiring further investigation. Finally, I documented the finding and decided whether the rule required tuning.

| Alert (rule ID / description) | Host | What caused it | Verdict | Action |
|---|---|---|---|---|
| Windows failed login attempts | DC01 | Intentionally tested incorrect passwords while validating domain authentication | Expected activity | Documented |
| New local administrator account created | DC01 | Created a test account during privilege management exercises | Expected activity | Documented |
| PowerShell execution detected | CLIENT1 | Administrative PowerShell commands used for system configuration | Expected activity | Reviewed command history and documented |
| Multiple authentication failures | CLIENT1 | User attempted logins with an expired password | False positive / expected | No action required |
| Service installation detected | DC01 | Installed Sysmon and monitoring components | Expected activity | Verified and documented |


![example wazuh alert](screenshots/19-wazuh-alert-example.png)
![drill down into the failed login from crackmapexec](screenshots/20-wazuh-alert-details.png)

## 10. Managing AD with an AI assistant (n8n + MCP)

### The vision

Most AD admin work is repetitive: create a user, reset a password, add someone to a group, disable an account when they leave. I wanted to see if an AI assistant could do this work **safely**, the way a junior admin would: only the tasks it is allowed to do, in the part of the domain it is allowed to touch, and with every action visible and checkable.

The long-term idea is an **AI-assisted helpdesk and SOC** for the lab:
- **Admin side:** I ask in plain English ("create a user Jane Doe in Lab_users and add her to Helpdesk") and the assistant does it through fixed, tested tools, never by writing its own commands.
- **Security side:** Wazuh alerts feed into the same pipeline, the assistant triages them with context from AD, and suggests a response (for example disabling a compromised account) that a human approves first.
- **Guardrails first:** least privilege, input validation, a limited scope and an audit trail matter more than how smart the assistant is.

This first step covers the admin side.

### How it works

```mermaid
flowchart LR
    CL["Claude<br/>(MCP client)"] -- "MCP over HTTP<br/>Bearer token<br/>localhost only" --> N8N
    subgraph PC["My PC"]
        N8N["n8n in Docker<br/>MCP Server Trigger<br/>12 AD tools"]
    end
    N8N -- "SSH, key only<br/>as svc-n8n" --> DC
    subgraph VM["VirtualBox"]
        DC["Domain controller<br/>host-only NIC 192.168.56.10<br/>PowerShell AD module"]
    end
    DC --> OU["_USERS > Lab_users<br/>(the only OU it can change)"]
```

- **[n8n](https://n8n.io)** (free, self-hosted in Docker) holds the workflows. Its **MCP Server Trigger** node turns them into tools an MCP client like Claude can call, so no separate MCP server is needed.
- Each tool calls a sub-workflow that validates the input and runs **one fixed PowerShell script** on the DC over SSH.
- The DC got a third network adapter (VirtualBox **host-only**, `192.168.56.10`) so n8n on my PC can reach it. SSH is limited to that network.
- Everything is free: n8n community edition, Docker Desktop (personal), OpenSSH (built into Windows Server).

| Read-only (whole domain) | Changes (`_USERS > Lab_users` only) |
|---|---|
| `list_lab` - what is in Lab_users | `create_user` - random temp password, must change at logon |
| `search_users` | `reset_password` - random temp password + unlock |
| `get_user` | `set_user_enabled` |
| `list_group_members` | `delete_user` - only if already disabled |
| | `create_group`, `add_group_member`, `remove_group_member`, `create_ou` |

### Security design

| Layer | What it does |
|---|---|
| Service account `svc-n8n` | Not an admin. Rights delegated with `dsacls` on `_USERS > Lab_users` only. It lives in `CN=Users`, outside that OU, so it can't reset its own password. |
| SSH | Key login only for `svc-n8n`, dedicated key for n8n, allowed through `AllowGroups` via its own group, port 22 limited to the host-only network. |
| Input handling | Inputs are checked with strict patterns, then sent to the DC as base64 **data** and read with `ConvertFrom-Json`. What the assistant types never becomes code, so command injection doesn't work. |
| Scope check | Every change also checks the target is inside Lab_users before running, on top of the AD permissions. |
| n8n | Only listens on `127.0.0.1`. The MCP endpoint needs a Bearer token (403 without it). |

Tested: resetting `Administrator`'s password, adding someone to `Domain Admins`, editing `svc-n8n` itself and injection attempts in names are all refused.

Scripts and workflows: [`setup-dc-n8n.ps1`](setup-dc-n8n.ps1), [`fix-dc-ssh-allowgroups.ps1`](fix-dc-ssh-allowgroups.ps1), [`merge-lab-ous.ps1`](merge-lab-ous.ps1) and the [`n8n/`](n8n) folder (workflow generator, the runner logic, and test scripts).

## Problems I Hit

### DNS misconfiguration prevented domain join

The Windows client could not locate the Active Directory domain during the join process.

**Root cause:** The client was using an external DNS server instead of the Domain Controller.

**Fix:** Updated the client's preferred DNS server to point to the Domain Controller and verified name resolution using `nslookup`.

### Client had internet access but could not resolve domain resources

Users could reach external IP addresses but could not access domain services.

**Root cause:** Incorrect DNS configuration.

**Fix:** Configured Active Directory DNS as the primary DNS server and verified SRV record resolution.

### Wazuh agent not appearing in the dashboard

After installing an agent, it did not show as connected.

**Root cause:** Agent registration and connectivity issue between the endpoint and the manager.

**Fix:** Re-registered the agent, verified connectivity to the manager, restarted the Wazuh service, and confirmed successful enrollment.

### SSH login for the service account was rejected

The `svc-n8n` key login kept failing with "Permission denied".

**Root cause:** the DC's `sshd_config` has an `AllowGroups` line, and the OpenSSH log showed "none of user's groups are listed in AllowGroups". Adding the group as `"mydomain\\ssh-automation"` still didn't match on the DC.

**Fix:** put `svc-n8n` in its own group and add it with a wildcard: `AllowGroups administrators "openssh users" *ssh-automation`. The OpenSSH event log (`OpenSSH/Operational`) showed the real reason each time.

### Commands broke when sent over SSH

**Root cause:** the default SSH shell on Windows is `cmd`, which mangles quotes. n8n's SSH node also adds `cd '<folder>' ;` before the command, which `cmd` can't parse.

**Fix:** send everything as `powershell -NoProfile -NonInteractive -EncodedCommand <base64>`, and set the SSH node's working directory to an expression that evaluates to empty.

### Two "lab users" OUs

My setup script created a new top-level `Lab Users` OU, but I already had `_USERS > Lab_users`, and the service account had ended up inside it.

**Fix:** [`merge-lab-ous.ps1`](merge-lab-ous.ps1) moved everything into `_USERS > Lab_users`, moved `svc-n8n` back to `CN=Users`, and deleted the duplicate OU.

## What I Learned

- Active Directory heavily depends on DNS; many domain-related issues are actually DNS issues.
- Building security monitoring into an environment provides much better visibility than relying only on endpoint observations.
- Not every alert represents malicious activity. Context is essential before escalating an incident.
- Event correlation is important because a single alert rarely provides the complete picture.
- Proper logging and monitoring make troubleshooting significantly easier.
- Understanding normal system behavior helps identify genuine anomalies and suspicious activity.
- Giving an AI assistant admin powers is mostly a least-privilege problem: limit what it can touch, give it fixed tools instead of a shell, and treat its input as data, not code.
- Delegating rights on one OU is a clean way to give a service account real power without making it a Domain Admin.

## Next Steps

- [ ] Group Policy: password policy, lock screen, disable USB storage
- [ ] Add a second client and compare activity across hosts
- [ ] Configure Sysmon for enhanced endpoint visibility
- [ ] Simulate attacks (Kerberoasting, AS-REP Roasting) and analyze detections in Wazuh
- [ ] Create custom Wazuh dashboards and detection rules
- [x] Deploy an MCP server exposing Active Directory management functions (n8n, see section 10)
- [ ] Integrate an LLM (Claude / other MCP-compatible assistant) to perform supervised administrative tasks such as:
  - [x] Creating and disabling users
  - [x] Managing groups (membership, new groups, OUs)
  - [x] Querying user information
  - [ ] Querying AD health (replication, DNS, services)
  - [ ] Reviewing authentication events
  - [ ] Generating security and compliance reports
- [ ] Log every tool call (who asked, what ran, result) to a file or Wazuh for an audit trail
- [ ] Add approval workflows and role-based access controls so risky actions (delete, password reset) need a human click first
- [ ] Investigate AI-assisted SOC workflows by combining Active Directory, Wazuh alerts, and MCP tools: send Wazuh alerts to n8n, let the assistant triage them with AD context, and suggest responses for approval

