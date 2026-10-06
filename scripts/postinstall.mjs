// Root postinstall: apply patches, repair electron, rebuild native modules
// for Electron's ABI.
//
// `MAESTRO_SERVER_INSTALL=1` is the server install (a Docker image or a
// systemd host running `maestro-cli cue engine start` under plain Node). It
// skips the two Electron steps. better-sqlite3's own install script has
// already fetched (or built) a binary for THIS Node's ABI, and
// `electron-rebuild` would replace it with one plain Node refuses to load
// ("compiled against a different Node.js version using NODE_MODULE_VERSION").
// A desktop install leaves the variable unset and runs exactly what it ran
// before this script existed.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
// npm puts `node_modules/.bin` on PATH for a lifecycle script; add it here too
// so `node scripts/postinstall.mjs` run by hand behaves the same.
// Windows usually spells the key `Path`; reuse whatever spelling is there so
// the child does not see two competing entries.
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
const env = {
	...process.env,
	[pathKey]: [path.join(rootDir, 'node_modules', '.bin'), process.env[pathKey]]
		.filter(Boolean)
		.join(path.delimiter),
};

const serverInstall =
	process.env.MAESTRO_SERVER_INSTALL === '1' || process.env.MAESTRO_SERVER_INSTALL === 'true';

function run(command, args) {
	// `shell` so the `.bin` shims (patch-package, electron-rebuild) resolve the
	// same way they did as an npm script string, on Windows too.
	const result = spawnSync(command, args, { stdio: 'inherit', shell: true, cwd: rootDir, env });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

run('patch-package', []);

if (serverInstall) {
	// eslint-disable-next-line no-console
	console.log(
		'[maestro] MAESTRO_SERVER_INSTALL=1: skipping electron repair and electron-rebuild; native modules stay built for this Node.'
	);
} else {
	run('node', ['scripts/ensure-electron.mjs']);
	run('electron-rebuild', ['-f', '-w', 'node-pty,better-sqlite3']);
}
