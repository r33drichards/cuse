#!/usr/bin/env bash
set -euo pipefail
umask 077
# Keep only controlled diagnostics for shell/config startup failures.
exec 2>/dev/null
startup_failed() { printf '%s\n' 'cuse startup failed; ask the private administrator to verify configuration.'; exit 1; }
set -E
trap startup_failed ERR
shopt -s execfail
[[ -n "${COMPUTERUSE_API_TOKEN:-}" && -n "${IRC_SERVER:-}" ]] || startup_failed
export PI_CODING_AGENT_DIR=/data/agent
export IRC_NICK="${IRC_NICK:-cuse}" IRC_CONTROL_CHANNEL="${IRC_CONTROL_CHANNEL:-#cuse}"
mkdir -p /data/agent
# OAuth file belongs to pi AuthStorage: preserve its bytes, only restrict mode.
if [[ -f /data/agent/auth.json ]]; then chmod 0600 /data/agent/auth.json; fi
# Do not interpolate secrets into JSON or echo them. Mounted models win;
# absent both inputs, retain the volume's existing custom model definitions.
node --input-type=commonjs <<'NODE'
try {
const fs = require('node:fs');
const path = '/data/agent';
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be a JSON object');
  return value;
}
function read(file) { return object(JSON.parse(fs.readFileSync(file, 'utf8')), file); }
function write(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
let models;
if (fs.existsSync('/config/models.json')) models = read('/config/models.json');
else if (process.env.PI_MODELS_JSON) models = object(JSON.parse(process.env.PI_MODELS_JSON), 'PI_MODELS_JSON');
if (models) write(path + '/models.json', models);
const file = path + '/settings.json';
const current = fs.existsSync(file) ? read(file) : {};
const overlay = fs.existsSync('/config/settings.json') ? read('/config/settings.json') : {};
const settings = { ...current, ...overlay };
// Explicit env wins, then mounted/persisted settings, then defaults.
settings.defaultProvider = process.env.PI_DEFAULT_PROVIDER || settings.defaultProvider || 'openai-codex';
settings.defaultModel = process.env.PI_DEFAULT_MODEL || settings.defaultModel || 'gpt-5.4';
// cuse talks directly to Computer Use; never inherit pi-irc's coordinator.
delete settings.mcpJs;
write(file, settings);
} catch {
 console.error("cuse configuration failed; ask the private administrator to verify configuration.");
 process.exitCode = 1;
}
NODE
[[ -x /app/node_modules/.bin/tsx ]] || startup_failed
exec /app/node_modules/.bin/tsx --tsconfig /app/tsconfig.json /app/packages/coding-agent/src/cuse/main.ts "$@" || startup_failed
