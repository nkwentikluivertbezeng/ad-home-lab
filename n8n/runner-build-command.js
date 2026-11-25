// n8n Code node: "Build command" (AD Tools - Runner)
// Validates the tool inputs, then builds ONE fixed PowerShell script for the
// requested action. Claude's values never become code: they travel to the DC
// as base64-encoded JSON data and are read there with ConvertFrom-Json.

const i = $input.first().json;

// ---- shared PowerShell preamble -------------------------------------------
const PRE = [
  "$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'",
  "Import-Module ActiveDirectory",
  "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__B64__'))|ConvertFrom-Json",
  "$dom=Get-ADDomain;$lab='OU=Lab_users,OU=_USERS,'+$dom.DistinguishedName",
  "function Ok($o){[Console]::Out.Write((@{ok=$true;result=$o}|ConvertTo-Json -Compress -Depth 5))}",
  "function InLab($dn){if(-not $dn.EndsWith(','+$lab)){throw ('Not allowed: '+$dn+' is outside _USERS > Lab_users')}}",
  "function OuDN($rel){if(-not $rel){return $lab};$a=$rel -split '/';[array]::Reverse($a);(($a|%{'OU='+$_}) -join ',')+','+$lab}",
  "function NewPw{$c='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%*-_';(-join(1..14|%{$c[(Get-Random -Max $c.Length)]}))+'Aa1!'}",
  "function Sec($s){ConvertTo-SecureString $s -AsPlainText -Force}",
  "",
].join("\n");

// ---- one fixed script per action --------------------------------------------
const A = {
  list_lab: [
    "$ous=@(Get-ADOrganizationalUnit -SearchBase $lab -Filter *|?{$_.DistinguishedName -ne $lab}|%{$_.DistinguishedName.Replace(','+$lab,'')})",
    "$grp=@(Get-ADGroup -SearchBase $lab -Filter *|%{$_.Name})",
    "$usr=@(Get-ADUser -SearchBase $lab -Filter *|%{@{sam=$_.SamAccountName;name=$_.Name;enabled=$_.Enabled;ou=(($_.DistinguishedName -split ',',2)[1]).Replace($lab,'').TrimEnd(',')}})",
    "Ok @{lab=$lab;ous=$ous;groups=$grp;users=$usr}",
  ],
  search_users: [
    "$q=$p.query",
    "$r=@(Get-ADUser -Filter \"SamAccountName -like '*$q*' -or Name -like '*$q*'\" -ResultSetSize 25|%{@{sam=$_.SamAccountName;name=$_.Name;enabled=$_.Enabled;dn=$_.DistinguishedName}})",
    "Ok $r",
  ],
  get_user: [
    "$u=Get-ADUser -Identity $p.sam -Properties Description,MemberOf,LastLogonDate,WhenCreated,PasswordLastSet,LockedOut",
    "Ok @{sam=$u.SamAccountName;name=$u.Name;enabled=$u.Enabled;locked=$u.LockedOut;dn=$u.DistinguishedName;description=$u.Description;created=[string]$u.WhenCreated;lastLogon=[string]$u.LastLogonDate;passwordLastSet=[string]$u.PasswordLastSet;groups=@($u.MemberOf|%{($_ -split ',')[0] -replace '^CN=',''})}",
  ],
  create_user: [
    "$ou=OuDN $p.ou",
    "$sam=$p.sam;if(-not $sam){$sam=($p.first_name.Substring(0,1)+'.'+$p.last_name).ToLower() -replace '[^a-z0-9._-]',''}",
    "if($sam.Length -gt 20){$sam=$sam.Substring(0,20)}",
    "$full=$p.first_name+' '+$p.last_name;$pw=NewPw",
    "$h=@{Name=$full;GivenName=$p.first_name;Surname=$p.last_name;DisplayName=$full;SamAccountName=$sam;UserPrincipalName=$sam+'@'+$dom.DNSRoot;Path=$ou;AccountPassword=(Sec $pw);Enabled=$true;ChangePasswordAtLogon=$true}",
    "if($p.description){$h.Description=$p.description}",
    "New-ADUser @h",
    "$added=@();foreach($g in ($p.groups -split ',')){$g=$g.Trim();if($g){$gr=Get-ADGroup -Identity $g;InLab $gr.DistinguishedName;Add-ADGroupMember -Identity $gr -Members $sam;$added+=$gr.Name}}",
    "Ok @{sam=$sam;name=$full;dn=('CN='+$full+','+$ou);temporaryPassword=$pw;mustChangeAtLogon=$true;groups=$added}",
  ],
  reset_password: [
    "$u=Get-ADUser -Identity $p.sam;InLab $u.DistinguishedName;$pw=NewPw",
    "Set-ADAccountPassword -Identity $u -Reset -NewPassword (Sec $pw);Set-ADUser -Identity $u -ChangePasswordAtLogon $true;Unlock-ADAccount -Identity $u",
    "Ok @{sam=$u.SamAccountName;temporaryPassword=$pw;mustChangeAtLogon=$true;unlocked=$true}",
  ],
  set_user_enabled: [
    "$u=Get-ADUser -Identity $p.sam;InLab $u.DistinguishedName",
    "if($p.enabled){Enable-ADAccount -Identity $u}else{Disable-ADAccount -Identity $u}",
    "Ok @{sam=$u.SamAccountName;enabled=[bool]$p.enabled}",
  ],
  delete_user: [
    "$u=Get-ADUser -Identity $p.sam;InLab $u.DistinguishedName",
    "if($u.Enabled){throw ('User '+$u.SamAccountName+' is still enabled. Disable it first, then delete.')}",
    "Remove-ADUser -Identity $u -Confirm:$false",
    "Ok @{deleted=$u.SamAccountName}",
  ],
  create_group: [
    "$ou=OuDN $p.ou",
    "$h=@{Name=$p.group;SamAccountName=$p.group;GroupScope='Global';GroupCategory='Security';Path=$ou}",
    "if($p.description){$h.Description=$p.description}",
    "New-ADGroup @h",
    "Ok @{group=$p.group;dn=('CN='+$p.group+','+$ou)}",
  ],
  add_group_member: [
    "$g=Get-ADGroup -Identity $p.group;InLab $g.DistinguishedName;$u=Get-ADUser -Identity $p.sam",
    "Add-ADGroupMember -Identity $g -Members $u",
    "Ok @{group=$g.Name;added=$u.SamAccountName}",
  ],
  remove_group_member: [
    "$g=Get-ADGroup -Identity $p.group;InLab $g.DistinguishedName;$u=Get-ADUser -Identity $p.sam",
    "Remove-ADGroupMember -Identity $g -Members $u -Confirm:$false",
    "Ok @{group=$g.Name;removed=$u.SamAccountName}",
  ],
  list_group_members: [
    "$g=Get-ADGroup -Identity $p.group",
    "Ok @{group=$g.Name;dn=$g.DistinguishedName;members=@(Get-ADGroupMember -Identity $g|%{@{sam=$_.SamAccountName;name=$_.Name;type=$_.objectClass}})}",
  ],
  create_ou: [
    "$parent=OuDN $p.ou",
    "New-ADOrganizationalUnit -Name $p.ou_name -Path $parent -ProtectedFromAccidentalDeletion $false",
    "Ok @{dn=('OU='+$p.ou_name+','+$parent)}",
  ],
};

const REQUIRED = {
  list_lab: [], search_users: ['query'], get_user: ['sam'],
  create_user: ['first_name', 'last_name'], reset_password: ['sam'],
  set_user_enabled: ['sam', 'enabled'], delete_user: ['sam'],
  create_group: ['group'], add_group_member: ['group', 'sam'],
  remove_group_member: ['group', 'sam'], list_group_members: ['group'],
  create_ou: ['ou_name'],
};

// ---- validation -------------------------------------------------------------
const RX = {
  sam: /^[A-Za-z0-9._-]{1,20}$/,
  name: /^[\p{L}\p{M}0-9 .'-]{1,64}$/u,
  group: /^[A-Za-z0-9 ._-]{1,64}$/,
  ou: /^[A-Za-z0-9 _-]{1,64}(\/[A-Za-z0-9 _-]{1,64}){0,4}$/,
  query: /^[A-Za-z0-9 ._-]{1,64}$/,
};
const str = v => (v === null || v === undefined) ? '' : String(v).trim();
const check = (k, v, rx) => { if (v && !rx.test(v)) throw new Error(`Invalid ${k}: "${v}"`); return v; };

const action = str(i.action);
if (!A[action]) throw new Error(`Unknown action "${action}"`);

const p = {
  query: check('query', str(i.query), RX.query),
  sam: check('sam', str(i.sam), RX.sam),
  first_name: check('first_name', str(i.first_name), RX.name),
  last_name: check('last_name', str(i.last_name), RX.name),
  ou: check('ou', str(i.ou).replace(/^\/+|\/+$/g, ''), RX.ou),
  ou_name: check('ou_name', str(i.ou_name), RX.group),
  group: check('group', str(i.group), RX.group),
  groups: str(i.groups),
  description: str(i.description).replace(/[\u0000-\u001f]/g, ' ').slice(0, 200),
  enabled: i.enabled === true || str(i.enabled).toLowerCase() === 'true',
};
for (const g of p.groups.split(',').map(x => x.trim()).filter(Boolean)) check('group (in groups)', g, RX.group);

for (const k of REQUIRED[action]) {
  const missing = k === 'enabled' ? str(i.enabled) === '' : !p[k];
  if (missing) throw new Error(`"${k}" is required for ${action}`);
}

// ---- build the command -------------------------------------------------------
const data = Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
const script = PRE.replace('__B64__', data) +
  'try{\n' + A[action].join('\n') + '\n}catch{[Console]::Out.Write((@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress))}';
const encoded = Buffer.from(script, 'utf16le').toString('base64');

return [{ json: { action, command: 'powershell -NoProfile -NonInteractive -EncodedCommand ' + encoded } }];
