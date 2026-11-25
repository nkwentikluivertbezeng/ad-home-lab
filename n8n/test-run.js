// End-to-end test of the runner logic: builds each command exactly like the
// n8n Code node does, runs it on the DC over SSH as svc-n8n, prints results.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const code = fs.readFileSync(path.join(__dirname, 'runner-build-command.js'), 'utf8');
const build = input => new Function('$input', 'Buffer', code)({ first: () => ({ json: input }) }, Buffer)[0].json.command;
const key = path.join(os.homedir(), '.ssh', 'n8n_ad');

function run(label, input) {
  let cmd;
  try { cmd = build(input); } catch (e) { console.log(`${label.padEnd(34)} VALIDATION: ${e.message}`); return null; }
  const r = spawnSync('ssh', ['-i', key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', 'svc-n8n@192.168.56.10', cmd], { encoding: 'utf8' });
  let out;
  try { out = JSON.parse(r.stdout); } catch { out = { raw: r.stdout.slice(0, 300), stderr: (r.stderr || '').slice(0, 300), len: cmd.length }; }
  const shown = JSON.stringify(out).replace(/"temporaryPassword":"[^"]*"/g, '"temporaryPassword":"<hidden>"');
  console.log(`${label.padEnd(34)} ${shown.slice(0, 400)}`);
  return out;
}

const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const [label, input] of cases) run(label, input);
