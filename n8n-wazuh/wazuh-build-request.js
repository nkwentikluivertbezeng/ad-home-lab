// "Build request" node of "Wazuh Tools - Runner".
// Turns one validated tool call into ONE read-only request:
//   backend 'api'     -> GET <path> on the Wazuh manager API
//   backend 'indexer' -> POST <index>/_search on the Wazuh indexer
// Every value from Claude is checked here and only ever placed into JSON
// query objects or fixed URL templates, never concatenated into raw text.
const p = $input.first().json;
const action = String(p.action || '');

const fail = msg => { throw new Error(msg); };
const str = v => (v === undefined || v === null ? '' : String(v).trim());
const int = (v, def, min, max, name) => {
  const s = str(v);
  if (s === '') return def;
  const n = Number(s);
  if (!Number.isInteger(n) || n < min || n > max) fail(`${name} must be a whole number from ${min} to ${max}`);
  return n;
};
const RX = {
  agent: /^[A-Za-z0-9._ -]{1,64}$/,
  rule_id: /^\d{1,7}$/,
  group: /^[A-Za-z0-9._-]{1,64}$/,
  text: /^[\p{L}\p{N} ._:@\\\/-]{1,100}$/u,
  alert_id: /^[A-Za-z0-9_-]{10,40}$/,
};
const opt = (name) => {
  const s = str(p[name]);
  if (s !== '' && !RX[name].test(s)) fail(`invalid ${name}: only letters, digits and . _ - (and space for agent) are allowed`);
  return s;
};

const ALERTS = 'wazuh-alerts-*';
const VULNS = 'wazuh-states-vulnerabilities-*';
const since = h => ({ range: { timestamp: { gte: `now-${h}h` } } });
const agentFilter = a => ({ bool: { should: [{ term: { 'agent.name': a } }, { term: { 'agent.id': /^\d+$/.test(a) ? a.padStart(3, '0') : a } }], minimum_should_match: 1 } });
const interval = h => (h <= 24 ? '1h' : h <= 168 ? '6h' : '1d');
const COMPACT = ['timestamp', 'agent.name', 'agent.id', 'rule.id', 'rule.level', 'rule.description', 'rule.groups', 'rule.mitre.technique', 'rule.mitre.tactic', 'data.srcip', 'data.srcuser', 'data.dstuser', 'data.win.eventdata.targetUserName', 'data.win.eventdata.ipAddress', 'data.win.system.eventID', 'full_log', 'location'];

let req;
switch (action) {
  case 'agents_status':
    req = { backend: 'api', path: '/agents?select=id,name,ip,status,os.name,os.version,version,lastKeepAlive,group,dateAdd&limit=500&sort=%2Bid' };
    break;

  case 'manager_status':
    req = { backend: 'api', path: '/manager/status' };
    break;

  case 'alert_summary': {
    const hours = int(p.hours, 24, 1, 720, 'hours');
    const minLevel = int(p.min_level, 0, 0, 15, 'min_level');
    const agent = opt('agent');
    const filter = [since(hours), { range: { 'rule.level': { gte: minLevel } } }];
    if (agent) filter.push(agentFilter(agent));
    req = {
      backend: 'indexer', index: ALERTS, hours, minLevel, agent,
      body: {
        size: 0, track_total_hits: true, query: { bool: { filter } },
        aggs: {
          by_level: { terms: { field: 'rule.level', size: 16, order: { _key: 'desc' } } },
          top_rules: { terms: { field: 'rule.id', size: 10 }, aggs: { d: { terms: { field: 'rule.description', size: 1 } }, lvl: { max: { field: 'rule.level' } } } },
          top_agents: { terms: { field: 'agent.name', size: 10 } },
          top_groups: { terms: { field: 'rule.groups', size: 10 } },
          mitre: { terms: { field: 'rule.mitre.technique', size: 10 } },
          src_ips: { terms: { field: 'data.srcip', size: 10 } },
          timeline: { date_histogram: { field: 'timestamp', fixed_interval: interval(hours), min_doc_count: 0 } },
          high: { filter: { range: { 'rule.level': { gte: 10 } } }, aggs: { latest: { top_hits: { size: 5, sort: [{ timestamp: 'desc' }], _source: { includes: COMPACT } } } } },
        },
      },
    };
    break;
  }

  case 'search_alerts': {
    const hours = int(p.hours, 24, 1, 720, 'hours');
    const minLevel = int(p.min_level, 0, 0, 15, 'min_level');
    const limit = int(p.limit, 20, 1, 50, 'limit');
    const agent = opt('agent'), ruleId = opt('rule_id'), group = opt('group'), text = opt('text');
    const filter = [since(hours), { range: { 'rule.level': { gte: minLevel } } }];
    if (agent) filter.push(agentFilter(agent));
    if (ruleId) filter.push({ term: { 'rule.id': ruleId } });
    if (group) filter.push({ term: { 'rule.groups': group } });
    const must = text ? [{ bool: { should: [
      { match: { full_log: { query: text, operator: 'and' } } },
      { wildcard: { 'rule.description': { value: `*${text}*`, case_insensitive: true } } },
    ], minimum_should_match: 1 } }] : [];
    req = {
      backend: 'indexer', index: ALERTS,
      body: { size: limit, track_total_hits: true, sort: [{ timestamp: 'desc' }], query: { bool: { filter, must } }, _source: { includes: COMPACT } },
    };
    break;
  }

  case 'get_alert': {
    const id = opt('alert_id');
    if (!id) fail('alert_id is required (the id returned by search_alerts)');
    req = { backend: 'indexer', index: ALERTS, body: { size: 1, query: { ids: { values: [id] } } } };
    break;
  }

  case 'vulnerability_summary': {
    const agent = opt('agent');
    const sev = str(p.severity);
    if (sev && !['Critical', 'High', 'Medium', 'Low'].includes(sev)) fail('severity must be Critical, High, Medium or Low');
    const filter = [];
    if (agent) filter.push(agentFilter(agent));
    if (sev) filter.push({ term: { 'vulnerability.severity': sev } });
    req = {
      backend: 'indexer', index: VULNS,
      body: {
        size: 0, track_total_hits: true, query: { bool: { filter } },
        aggs: {
          by_severity: { terms: { field: 'vulnerability.severity', size: 10 } },
          by_agent: { terms: { field: 'agent.name', size: 20 }, aggs: { sev: { terms: { field: 'vulnerability.severity', size: 10 } } } },
          top_cves: { terms: { field: 'vulnerability.id', size: 15, order: { score: 'desc' } }, aggs: {
            score: { max: { field: 'vulnerability.score.base' } },
            sev: { terms: { field: 'vulnerability.severity', size: 1 } },
            pkg: { terms: { field: 'package.name', size: 3 } },
            agents: { terms: { field: 'agent.name', size: 5 } } } },
          top_packages: { terms: { field: 'package.name', size: 10 } },
        },
      },
    };
    break;
  }

  default:
    fail(`unknown action '${action}'`);
}

return [{ json: { action, ...req } }];
