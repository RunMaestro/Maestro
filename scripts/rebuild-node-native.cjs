/** Rebuild the Node-test ABI; npm ci's postinstall prepares Electron instead. */
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run through npm run rebuild:node-native');
if (process.platform === 'win32') {
	// npm's bundled node-gyp may not recognize Visual Studio 2026. Invoke the
	// pinned implementation directly so npm cannot select its bundled copy.
	const prefix = path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'maestro-node-gyp');
	execFileSync(
		process.execPath,
		[npmCli, 'install', '--prefix', prefix, '--no-save', '--ignore-scripts', 'node-gyp@12.1.0'],
		{ stdio: 'inherit' }
	);
	execFileSync(
		process.execPath,
		[path.join(prefix, 'node_modules/node-gyp/bin/node-gyp.js'), 'rebuild', '--release'],
		{ cwd: path.resolve('node_modules/better-sqlite3'), stdio: 'inherit' }
	);
} else {
	execFileSync(process.execPath, [npmCli, 'rebuild', 'better-sqlite3'], { stdio: 'inherit' });
}
