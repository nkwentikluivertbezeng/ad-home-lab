// "Format result" node of "Wazuh Tools - Runner".
// Shrinks the raw Wazuh responses into compact JSON that is easy to summarise.
const req = $('Build request').first().json;
const r = $input.first().json;

const cut = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '...' : s);
const buckets = (agg, f = b => ({ key: b.key, count: b.doc_count })) => ((agg && agg.buckets) || []).map(f);
const compact = h => {
  const s = h._source || {};
  const d = s.data || {};
  const ev = (d.win && d.win.eventdata) || {};
  return {
    alert_id: h._id,
    time: s.timestamp,
    agent: s.agent && `${s.agent.name} (${s.agent.id})`,
    rule: s.rule && { id: s.rule.id, level: s.rule.level, description: s.rule.description, groups: s.rule.groups },
    mitre: s.rule && s.rule.mitre ? { technique: s.rule.mitre.technique, tactic: s.rule.mitre.tactic } : undefined,
    src_ip: d.srcip || ev.ipAddress,
    user: ev.targetUserName || d.dstuser || d.srcuser,
    windows_event_id: d.win && d.win.system && d.win.system.eventID,
    log: cut(s.full_log, 300),
  };
};

let out;
if (r.error || (r.title && r.detail)) {
  // Indexer errors are objects, API errors are numbers with a message
  out = { ok: false, error: typeof r.error === 'object' ? (r.error.reason || r.error.type || JSON.stringify(r.error).slice(0, 300)) : (r.detail || r.message || r.title || `Wazuh API error ${r.error}`) };
} else switch (req.action) {
  case 'agents_status': {
    const agents = (r.data && r.data.affected_items) || [];
    const counts = {};
    for (const a of agents) counts[a.status] = (counts[a.status] || 0) + 1;
    out = { ok: true, total: agents.length, by_status: counts, agents: agents.map(a => ({
      id: a.id, name: a.name, status: a.status, ip: a.ip,
      os: a.os && [a.os.name, a.os.version].filter(Boolean).join(' '),
      version: a.version, last_keepalive: a.lastKeepAlive, groups: a.group })) };
    break;
  }
  case 'manager_status': {
    const s = ((r.data && r.data.affected_items) || [])[0] || {};
    const running = Object.keys(s).filter(k => s[k] === 'running');
    out = { ok: true, running, not_running: Object.keys(s).filter(k => s[k] !== 'running').map(k => `${k}: ${s[k]}`) };
    break;
  }
  case 'alert_summary': {
    const a = r.aggregations || {};
    out = {
      ok: true,
      window: `last ${req.hours}h`, min_level: req.minLevel, agent: req.agent || 'all',
      total_alerts: r.hits && r.hits.total && r.hits.total.value,
      by_level: buckets(a.by_level, b => ({ level: b.key, count: b.doc_count })),
      high_severity_count: a.high && a.high.doc_count,
      latest_high_severity: ((a.high && a.high.latest && a.high.latest.hits.hits) || []).map(compact),
      top_rules: buckets(a.top_rules, b => ({ rule_id: b.key, description: (b.d.buckets[0] || {}).key, level: b.lvl.value, count: b.doc_count })),
      top_agents: buckets(a.top_agents),
      top_groups: buckets(a.top_groups),
      mitre_techniques: buckets(a.mitre),
      top_source_ips: buckets(a.src_ips),
      timeline: buckets(a.timeline, b => ({ from: b.key_as_string, count: b.doc_count })),
    };
    break;
  }
  case 'search_alerts': {
    const hits = (r.hits && r.hits.hits) || [];
    out = { ok: true, total_matches: r.hits && r.hits.total && r.hits.total.value, returned: hits.length, alerts: hits.map(compact) };
    break;
  }
  case 'get_alert': {
    const h = ((r.hits && r.hits.hits) || [])[0];
    out = h ? { ok: true, alert_id: h._id, index: h._index, alert: { ...h._source, full_log: cut(h._source.full_log, 4000) } }
            : { ok: false, error: 'No alert with that id' };
    break;
  }
  case 'vulnerability_summary': {
    const a = r.aggregations || {};
    out = {
      ok: true,
      total_findings: r.hits && r.hits.total && r.hits.total.value,
      by_severity: buckets(a.by_severity),
      by_agent: buckets(a.by_agent, b => ({ agent: b.key, count: b.doc_count, by_severity: buckets(b.sev) })),
      top_cves: buckets(a.top_cves, b => ({ cve: b.key, score: b.score.value, severity: (b.sev.buckets[0] || {}).key,
        packages: b.pkg.buckets.map(x => x.key), agents: b.agents.buckets.map(x => x.key), findings: b.doc_count })),
      top_packages: buckets(a.top_packages),
    };
    break;
  }
  default:
    out = { ok: false, error: 'unexpected action' };
}
return [{ json: out }];
