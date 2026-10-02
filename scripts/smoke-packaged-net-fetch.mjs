/**
 * Smoke-test the actual Electron package, not the development node_modules.
 * Usage: node scripts/smoke-packaged-net-fetch.mjs <extracted-deb>/opt/Maestro
 * Makes one unauthenticated GET to Discord's public REST API; HTTP 401 proves
 * the connection reached Discord without using a user token.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const packageRoot = process.argv[2] && resolve(process.argv[2]);
if (!packageRoot) {
	console.error('Usage: node scripts/smoke-packaged-net-fetch.mjs <package-root>');
	process.exit(2);
}

const electron = join(packageRoot, 'maestro');
const asar = join(packageRoot, 'resources', 'app.asar');
if (!existsSync(electron) || !existsSync(asar)) {
	throw new Error(`Packaged Electron or app.asar missing under ${packageRoot}`);
}

const smoke = String.raw`
const { createRequire } = require('node:module');
const path = require('node:path');
const assert = require('node:assert/strict');
const fromGuard = createRequire(path.join(process.argv[1], 'dist/main/plugins/net-egress-guard.js'));
const undiciPath = fromGuard.resolve('undici');
assert.match(undiciPath, /app\.asar\/node_modules\/undici\//);
const { createEgressGuard } = fromGuard('./net-egress-guard.js');
const { buildHostCallHandlers } = fromGuard('./plugin-host-handlers.js');
const { PermissionBroker } = fromGuard('./permission-broker.js');
const { HOST_API_VERSION } = fromGuard('../../shared/plugins/host-api.js');
const guard = createEgressGuard();
assert.equal(typeof guard.dispatcher?.dispatch, 'function', 'default dispatcher missing');
const broker = new PermissionBroker({
  getGrants: () => [{ capability: 'net:fetch', scope: 'discord.com', grantedAt: Date.now() }]
});
const handlers = buildHostCallHandlers({ broker, egressGuard: guard });
(async () => {
  await assert.rejects(guard.assertUrlAllowed('http://127.0.0.1/'), /loopback/);
  const result = await handlers['net.fetch']('package-smoke', {
    url: 'https://discord.com/api/v10/users/@me'
  });
  assert.equal(result.status, 401, 'unauthenticated Discord REST should return 401');
  const native = {};
  for (const name of ['better-sqlite3', 'node-pty', '@napi-rs/keyring', '@ast-grep/napi']) {
    native[name] = fromGuard.resolve(name);
    fromGuard(name);
  }
  console.log(JSON.stringify({
    hostApi: HOST_API_VERSION,
    undici: fromGuard('undici/package.json').version,
    undiciPath,
    dispatcher: guard.dispatcher.constructor.name,
    discordStatus: result.status,
    discordContentType: result.headers['content-type'],
    native
  }, null, 2));
})().then(() => guard.dispatcher.close(), (error) => {
  console.error(error);
  process.exitCode = 1;
  return guard.dispatcher.close();
});
`;

const result = spawnSync(electron, ['-e', smoke, asar], {
	env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
	encoding: 'utf8',
	timeout: 60_000,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
