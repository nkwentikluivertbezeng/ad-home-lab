// Minimal MCP (streamable HTTP) client to test the n8n endpoint.
// usage: node mcp-test.js <url> [bearer-token-env-var-name] -- calls read from mcp-calls.json
const fs = require('fs');
const path = require('path');
const url = process.argv[2];
const tokenVar = process.argv[3];
const headersBase = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
if (tokenVar && process.env[tokenVar]) headersBase.Authorization = 'Bearer ' + process.env[tokenVar];
let session, nextId = 1;

async function rpc(method, params, notify = false) {
  const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id: nextId++ }) };
  const res = await fetch(url, { method: 'POST', headers: { ...headersBase, ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify(body) });
  session = res.headers.get('mcp-session-id') || session;
  const text = await res.text();
  if (notify) return res.status;
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 300)}`);
  const json = (res.headers.get('content-type') || '').includes('event-stream')
    ? JSON.parse(text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).pop())
    : JSON.parse(text);
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

(async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-test', version: '1' } });
  console.log('server:', JSON.stringify(init.serverInfo), 'protocol:', init.protocolVersion);
  await rpc('notifications/initialized', undefined, true);
  const { tools } = await rpc('tools/list', {});
  console.log(`tools (${tools.length}):`);
  for (const t of tools) {
    const props = t.inputSchema?.properties || {};
    const req = t.inputSchema?.required || [];
    console.log(`  ${t.name}(${Object.keys(props).map(k => k + (req.includes(k) ? '' : '?') + ':' + props[k].type).join(', ')})`);
  }
  const callsFile = path.join(__dirname, 'mcp-calls.json');
  const calls = fs.existsSync(callsFile) ? JSON.parse(fs.readFileSync(callsFile, 'utf8')) : [];
  for (const [name, args] of calls) {
    try {
      const r = await rpc('tools/call', { name, arguments: args });
      const txt = (r.content || []).map(c => c.text).join(' ').replace(/"temporaryPassword"\s*:\s*"[^"]*"/g, '"temporaryPassword":"<hidden>"');
      console.log(`CALL ${name} -> ${r.isError ? 'ERROR ' : ''}${txt.slice(0, 350)}`);
    } catch (e) { console.log(`CALL ${name} -> EXCEPTION ${e.message.slice(0, 350)}`); }
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
