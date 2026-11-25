// Generates the two n8n workflows for read-only Wazuh monitoring:
//   wazuh-tools-runner.json - sub-workflow: validate -> Wazuh API or indexer -> compact result
//   wazuh-tools-mcp.json    - MCP Server Trigger (/mcp/wazuh) + one tool per action
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const OUT = __dirname;
const RUNNER_ID = 'wazuhToolsRun001';
const MCP_ID = 'wazuhToolsMcp001';
const CRED = {
  api: { id: 'wzApiReadonly01', name: 'Wazuh API (read-only)' },
  idx: { id: 'wzIdxReadonly01', name: 'Wazuh Indexer (read-only)' },
  ca: { id: 'wzIndexerCa0001', name: 'Wazuh Indexer root CA' },
  bearer: { id: 'wzMcpBearer0001', name: 'Wazuh MCP Bearer token' },
};
// n8n is attached to the Wazuh compose network, so it uses the container names
const API = 'https://wazuh.manager:55000';
const INDEXER = 'https://wazuh.indexer:9200';

const FIELDS = ['action', 'hours', 'min_level', 'agent', 'rule_id', 'group', 'text', 'limit', 'alert_id', 'severity'];
const NUMERIC = ['hours', 'min_level', 'limit'];

const D = {
  hours: ['How many hours back to look, 1 to 720. Default 24.', 'number', 24],
  min_level: ['Only alerts with rule level at or above this, 0 to 15. Wazuh levels: 0-6 low, 7-11 medium, 12+ high. Default 0.', 'number', 0],
  agent: ['Optional agent name or id, e.g. DC or 004. Empty for all agents.', 'string', ''],
  rule_id: ['Optional Wazuh rule id, e.g. 60122.', 'string', ''],
  group: ['Optional rule group, e.g. authentication_failed, authentication_success, windows, syscheck, sca, vulnerability-detector.', 'string', ''],
  text: ['Optional text to find in the raw log or rule description, e.g. administrator or 4625.', 'string', ''],
  limit: ['Max alerts to return, 1 to 50. Default 20.', 'number', 20],
  alert_id: ['The alert_id returned by search_alerts or alert_summary.', 'string'],
  severity: ['Optional: Critical, High, Medium or Low. Empty for all.', 'string', ''],
};

const TOOLS = [
  ['agents_status', 'List every Wazuh agent with its connection status (active / disconnected / never_connected), OS, IP, version and last keep-alive. Use this to check which machines are being monitored.', {}],
  ['manager_status', 'Show which Wazuh manager daemons are running or stopped (analysisd, remoted, modulesd, etc). Use this to check that Wazuh itself is healthy.', {}],
  ['alert_summary', 'Summarise Wazuh alerts for a time window: total, counts per level, the latest high-severity alerts (level 10+), top rules, top agents, rule groups, MITRE ATT&CK techniques, source IPs and an alert timeline. Start here for "what happened" questions.',
    { hours: D.hours, min_level: D.min_level, agent: D.agent }],
  ['search_alerts', 'Find individual Wazuh alerts, newest first, filtered by time window, minimum level, agent, rule id, rule group and/or text. Returns compact alerts with an alert_id for get_alert.',
    { hours: D.hours, min_level: D.min_level, agent: D.agent, rule_id: D.rule_id, group: D.group, text: D.text, limit: D.limit }],
  ['get_alert', 'Get the full details of one Wazuh alert by its alert_id, including the decoded event data and the raw log.', { alert_id: D.alert_id }],
  ['vulnerability_summary', 'Summarise vulnerabilities Wazuh has detected on the agents: counts per severity and per agent, the highest-scoring CVEs with affected packages, and the most affected packages.',
    { agent: D.agent, severity: D.severity }],
];

const q = s => s.replace(/'/g, '');
const fromAI = (key, [desc, type, def]) =>
  `={{ $fromAI('${key}', '${q(desc)}', '${type}'${def !== undefined ? `, ${JSON.stringify(def).replace(/"/g, "'")}` : ''}) }}`;

// ---- runner sub-workflow ----------------------------------------------------------
const read = f => fs.readFileSync(path.join(OUT, f), 'utf8');
const node = (name, type, typeVersion, position, parameters, extra = {}) =>
  ({ id: randomUUID(), name, type, typeVersion, position, parameters, ...extra });
const basic = cred => ({ authentication: 'genericCredentialType', genericAuthType: 'httpBasicAuth' });

const runner = {
  id: RUNNER_ID,
  name: 'Wazuh Tools - Runner',
  active: false,
  nodes: [
    node('Start', 'n8n-nodes-base.executeWorkflowTrigger', 1.3, [0, 0],
      { inputSource: 'workflowInputs', workflowInputs: { values: FIELDS.map(n => ({ name: n, type: NUMERIC.includes(n) ? 'any' : 'string' })) } }),
    node('Build request', 'n8n-nodes-base.code', 2, [220, 0],
      { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: read('wazuh-build-request.js') }),
    node('Manager API?', 'n8n-nodes-base.if', 2.2, [440, 0], {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        conditions: [{ id: randomUUID(), leftValue: '={{ $json.backend }}', rightValue: 'api', operator: { type: 'string', operation: 'equals' } }],
        combinator: 'and',
      },
      options: {},
    }),
    // The manager API uses a self-signed cert for "wazuh.com", so it can't be verified by name.
    // Traffic stays on the internal Docker network between the two containers.
    node('API login', 'n8n-nodes-base.httpRequest', 4.2, [660, -120], {
      method: 'POST', url: `${API}/security/user/authenticate?raw=true`, ...basic(),
      options: { allowUnauthorizedCerts: true, response: { response: { responseFormat: 'text', outputPropertyName: 'token' } } },
    }, { credentials: { httpBasicAuth: CRED.api } }),
    node('API request', 'n8n-nodes-base.httpRequest', 4.2, [880, -120], {
      method: 'GET', url: `={{ '${API}' + $('Build request').first().json.path }}`,
      sendHeaders: true, specifyHeaders: 'keypair',
      headerParameters: { parameters: [{ name: 'Authorization', value: "={{ 'Bearer ' + $json.token }}" }] },
      options: { allowUnauthorizedCerts: true, response: { response: { neverError: true } } },
    }),
    // The indexer cert is signed by the Wazuh root CA for "wazuh.indexer", so it IS verified.
    node('Indexer search', 'n8n-nodes-base.httpRequest', 4.2, [770, 120], {
      method: 'POST', url: `={{ '${INDEXER}/' + $json.index + '/_search' }}`, ...basic(),
      provideSslCertificates: true,
      sendBody: true, contentType: 'json', specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}',
      options: { response: { response: { neverError: true } } },
    }, { credentials: { httpBasicAuth: CRED.idx, httpSslAuth: CRED.ca } }),
    node('Format result', 'n8n-nodes-base.code', 2, [1100, 0],
      { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: read('wazuh-format-result.js') }),
  ],
  connections: {
    'Start': { main: [[{ node: 'Build request', type: 'main', index: 0 }]] },
    'Build request': { main: [[{ node: 'Manager API?', type: 'main', index: 0 }]] },
    'Manager API?': { main: [[{ node: 'API login', type: 'main', index: 0 }], [{ node: 'Indexer search', type: 'main', index: 0 }]] },
    'API login': { main: [[{ node: 'API request', type: 'main', index: 0 }]] },
    'API request': { main: [[{ node: 'Format result', type: 'main', index: 0 }]] },
    'Indexer search': { main: [[{ node: 'Format result', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1', callerPolicy: 'workflowsFromSameOwner' },
  pinData: {},
};

// ---- MCP server workflow -------------------------------------------------------------
const schema = used => FIELDS.map(f => ({
  id: f, displayName: f, required: false, defaultMatch: false, display: true,
  canBeUsedToMatch: true, type: NUMERIC.includes(f) ? 'any' : 'string', removed: f !== 'action' && !used.includes(f),
}));

const toolNodes = TOOLS.map(([name, description, params], idx) => {
  const value = { action: name };
  for (const [k, spec] of Object.entries(params)) value[k] = fromAI(k, spec);
  return node(name, '@n8n/n8n-nodes-langchain.toolWorkflow', 2.2, [-440 + idx * 220, 260], {
    description,
    source: 'database',
    workflowId: { __rl: true, value: RUNNER_ID, mode: 'list', cachedResultName: 'Wazuh Tools - Runner' },
    workflowInputs: { mappingMode: 'defineBelow', value, matchingColumns: [], schema: schema(Object.keys(params)), attemptToConvertTypes: false, convertFieldsToString: false },
  });
});

const trigger = node('MCP Server Trigger', '@n8n/n8n-nodes-langchain.mcpTrigger', 2.1, [0, 0], {
  authentication: 'bearerAuth',
  path: 'wazuh',
  instructions: 'Read-only tools for the Wazuh SIEM that monitors the home lab (domain controller, clients, Linux hosts). Nothing here can change Wazuh. For a general health check call agents_status, manager_status and alert_summary, then summarise: agents down, notable high-severity alerts, suspicious patterns (failed logins, new source IPs, MITRE techniques) and critical vulnerabilities. Drill into specifics with search_alerts and get_alert.',
}, { webhookId: randomUUID(), credentials: { httpBearerAuth: CRED.bearer } });

const mcp = {
  id: MCP_ID,
  name: 'Wazuh Tools - MCP Server',
  active: false,
  nodes: [trigger, ...toolNodes],
  connections: Object.fromEntries(toolNodes.map(t => [t.name, { ai_tool: [[{ node: trigger.name, type: 'ai_tool', index: 0 }]] }])),
  settings: { executionOrder: 'v1' },
  pinData: {},
};

fs.writeFileSync(path.join(OUT, 'wazuh-tools-runner.json'), JSON.stringify(runner, null, 2));
fs.writeFileSync(path.join(OUT, 'wazuh-tools-mcp.json'), JSON.stringify(mcp, null, 2));
console.log(`wrote wazuh-tools-runner.json and wazuh-tools-mcp.json (${toolNodes.length} tools)`);
