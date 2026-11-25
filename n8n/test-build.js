// Runs the n8n Code node logic outside n8n: node test-build.js '<json input>'
// Prints the command it would send (or the validation error).
const fs = require('fs');
const path = require('path');
const code = fs.readFileSync(path.join(__dirname, 'runner-build-command.js'), 'utf8');
const input = JSON.parse(process.argv[2] || '{}');
const $input = { first: () => ({ json: input }) };
try {
  const out = new Function('$input', 'Buffer', code)($input, Buffer);
  process.stdout.write(out[0].json.command);
} catch (e) {
  process.stdout.write('VALIDATION_ERROR: ' + e.message);
  process.exitCode = 2;
}
