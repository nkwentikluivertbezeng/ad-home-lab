// Generates the two n8n workflows as importable JSON:
//   ad-tools-runner.json  - sub-workflow: validate -> SSH to DC -> parse result
//   ad-tools-mcp.json     - MCP Server Trigger + one tool per AD action
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const OUT = __dirname;
const RUNNER_ID = 'adToolsRunner001';
const MCP_ID = 'adToolsMcpSrv001';
const SSH_CRED = { id: 'ZbUqemFa7aF5Qc0D', name: 'SSH Private Key account' };
const MCP_AUTH = process.argv[2] || 'none'; // 'none' for first local test, then 'bearerAuth'

// ---- inputs shared by every tool ------------------------------------------------
const FIELDS = ['action', 'query', 'sam', 'first_name', 'last_name', 'ou', 'ou_name', 'group', 'groups', 'description', 'enabled'];

const D = {
  query: ['Text to find in usernames or display names, e.g. smith. Letters, digits, space, dot, dash, underscore.', 'string'],
  sam: ['Username (sAMAccountName), e.g. j.doe. Letters, digits, dot, dash, underscore; max 20 characters.', 'string'],
  first_name: ['First name, e.g. Jane.', 'string'],
  last_name: ['Last name, e.g. Doe.', 'string'],
  ou: ['Optional sub-OU path under Lab_users, e.g. Engineering or Engineering/Interns. Leave empty for Lab_users itself.', 'string', ''],
  ou_name: ['Name of the new OU, e.g. Engineering. Letters, digits, space, dot, dash, underscore.', 'string'],
  group: ['Group name, e.g. Helpdesk.', 'string'],
  groups: ['Optional comma-separated group names to add the new user to. The groups must already exist in Lab_users.', 'string', ''],
  description: ['Optional short description, max 200 characters.', 'string', ''],
  enabled: ['true to enable the account, false to disable it.', 'boolean'],
};
const sam = (extra = '') => ({ sam: [D.sam[0] + extra, 'string'] });

const TOOLS = [
  ['list_lab', 'Overview of _USERS > Lab_users, the only part of Active Directory these tools can change: its sub-OUs, groups, and users with their enabled state. Call this first to see what exists.', {}],
  ['search_users', 'Search the whole domain (read-only) for users whose username or display name contains the given text. Returns at most 25 matches.', { query: D.query }],
  ['get_user', 'Get details for one user: name, enabled, locked out, OU, description, created, last logon, password last set, and group memberships. Works for any user in the domain (read-only).', sam()],
  ['create_user', 'Create a new enabled user in Lab_users or one of its sub-OUs. Returns a random temporary password, shown only once, that must be changed at first logon. If no username is given it defaults to first initial + dot + last name, e.g. j.doe.',
    { first_name: D.first_name, last_name: D.last_name, sam: [D.sam[0] + ' Optional.', 'string', ''], ou: D.ou, groups: D.groups, description: D.description }],
  ['reset_password', 'Reset the password of a user in Lab_users to a new random temporary password (must be changed at next logon) and unlock the account. Returns the temporary password once.', sam()],
  ['set_user_enabled', 'Enable or disable a user account in Lab_users.', { ...sam(), enabled: D.enabled }],
  ['delete_user', 'Permanently delete a user in Lab_users. The account must be disabled first (use set_user_enabled). Always ask the human to confirm before calling this.', sam()],
  ['create_group', 'Create a global security group in Lab_users or one of its sub-OUs.', { group: D.group, ou: D.ou, description: D.description }],
  ['add_group_member', 'Add a user to a group. The group must be in Lab_users.', { group: D.group, ...sam() }],
  ['remove_group_member', 'Remove a user from a group. The group must be in Lab_users.', { group: D.group, ...sam() }],
  ['list_group_members', 'List the members of any group in the domain (read-only).', { group: D.group }],
  ['create_ou', 'Create an organizational unit inside Lab_users, optionally nested under an existing sub-OU.', { ou_name: D.ou_name, ou: [ 'Optional parent sub-OU path under Lab_users, e.g. Engineering. Leave empty to create it directly in Lab_users.', 'string', ''] }],
];

const q = s => s.replace(/'/g, '');
const fromAI = (key, [desc, type, def]) =>
  `={{ $fromAI('${key}', '${q(desc)}', '${type}'${def !== undefined ? `, ${JSON.stringify(def).replace(/"/g, "'")}` : ''}) }}`;

// ---- runner sub-workflow -------------------------------------------------------------
const buildCode = fs.readFileSync(path.join(OUT, 'runner-build-command.js'), 'utf8');
const formatCode = `// Turn the DC's JSON output into the tool result
const r = $input.first().json;
let out;
try { out = JSON.parse(r.stdout); }
catch { out = { ok: false, error: 'Unexpected output from the domain controller', stdout: String(r.stdout || '').slice(0, 500), stderr: String(r.stderr || '').slice(0, 500), exitCode: r.code }; }
return [{ json: out }];`;

const runner = {
  id: RUNNER_ID,
  name: 'AD Tools - Runner',
  active: false,
  nodes: [
    { id: randomUUID(), name: 'Start', type: 'n8n-nodes-base.executeWorkflowTrigger', typeVersion: 1.3, position: [0, 0],
      parameters: { inputSource: 'workflowInputs', workflowInputs: { values: FIELDS.map(n => ({ name: n, type: n === 'enabled' ? 'any' : 'string' })) } } },
    { id: randomUUID(), name: 'Build command', type: 'n8n-nodes-base.code', typeVersion: 2, position: [240, 0],
      parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: buildCode } },
    { id: randomUUID(), name: 'Run on DC', type: 'n8n-nodes-base.ssh', typeVersion: 1, position: [480, 0],
      parameters: { authentication: 'privateKey', resource: 'command', operation: 'execute', // cwd must be non-empty for n8n's validation, but any real folder makes node-ssh
      // prepend "cd '<dir>' ;" which Windows cmd can't parse. The expression evaluates to "".
      command: '={{ $json.command }}', cwd: "={{ '' }}" },
      credentials: { sshPrivateKey: SSH_CRED } },
    { id: randomUUID(), name: 'Format result', type: 'n8n-nodes-base.code', typeVersion: 2, position: [720, 0],
      parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: formatCode } },
  ],
  connections: {
    'Start': { main: [[{ node: 'Build command', type: 'main', index: 0 }]] },
    'Build command': { main: [[{ node: 'Run on DC', type: 'main', index: 0 }]] },
    'Run on DC': { main: [[{ node: 'Format result', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1', callerPolicy: 'workflowsFromSameOwner' },
  pinData: {},
};

// ---- MCP server workflow --------------------------------------------------------------
const schema = used => FIELDS.map(f => ({
  id: f, displayName: f, required: false, defaultMatch: false, display: true,
  canBeUsedToMatch: true, type: f === 'enabled' ? 'any' : 'string', removed: f !== 'action' && !used.includes(f),
}));

const toolNodes = TOOLS.map(([name, description, params], idx) => {
  const value = { action: name };
  for (const [k, spec] of Object.entries(params)) value[k] = fromAI(k, spec);
  return {
    id: randomUUID(), name, type: '@n8n/n8n-nodes-langchain.toolWorkflow', typeVersion: 2.2,
    position: [-560 + (idx % 6) * 220, 260 + Math.floor(idx / 6) * 180],
    parameters: {
      description,
      source: 'database',
      workflowId: { __rl: true, value: RUNNER_ID, mode: 'list', cachedResultName: 'AD Tools - Runner' },
      workflowInputs: { mappingMode: 'defineBelow', value, matchingColumns: [], schema: schema(Object.keys(params)), attemptToConvertTypes: false, convertFieldsToString: false },
    },
  };
});

const trigger = {
  id: randomUUID(), name: 'MCP Server Trigger', type: '@n8n/n8n-nodes-langchain.mcpTrigger', typeVersion: 2.1,
  position: [0, 0], webhookId: randomUUID(),
  parameters: {
    authentication: MCP_AUTH,
    path: 'ad-tools',
    instructions: 'Tools for the mydomain.com lab Active Directory. Every change is limited to _USERS > Lab_users; anything outside it is read-only or refused. Temporary passwords are returned only once: show them to the user and never store them. Ask the user to confirm before delete_user.',
  },
};

const mcp = {
  id: MCP_ID,
  name: 'AD Tools - MCP Server',
  active: false,
  nodes: [trigger, ...toolNodes],
  connections: Object.fromEntries(toolNodes.map(t => [t.name, { ai_tool: [[{ node: trigger.name, type: 'ai_tool', index: 0 }]] }])),
  settings: { executionOrder: 'v1' },
  pinData: {},
};

fs.writeFileSync(path.join(OUT, 'ad-tools-runner.json'), JSON.stringify(runner, null, 2));
fs.writeFileSync(path.join(OUT, 'ad-tools-mcp.json'), JSON.stringify(mcp, null, 2));
console.log(`wrote ad-tools-runner.json and ad-tools-mcp.json (MCP auth: ${MCP_AUTH}, ${toolNodes.length} tools)`);
