// Fixture-only execution limits. Nothing here is installed into the production desktop.
const assert = require('node:assert/strict');
const { syncBuiltinESMExports } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');

function installRenderedBoundary(electron, validate, record, gitProbe) {
	const deny = (operation) => () => {
		record.denied.push(operation);
		throw new Error(`Isolated Board fixture denies ${operation}`);
	};
	const childProcess = require('node:child_process');
	const originalExecFile = childProcess.execFile;
	// Install before loading any host module. Cover both CJS and ESM built-in consumers.
	for (const [module, methods] of [
		[
			'node:child_process',
			['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'],
		],
		['node:http', ['request', 'get']],
		['node:https', ['request', 'get']],
		['node:net', ['connect', 'createConnection', 'createServer']],
		['node:tls', ['connect', 'createServer']],
		['node:dgram', ['createSocket']],
	]) {
		const api = require(module);
		for (const method of methods) api[method] = deny(`${module}.${method}`);
	}
	const execFile = (command, args, options, callback) => {
		const allowed =
			gitProbe &&
			command === 'git' &&
			Array.isArray(args) &&
			args.length === 2 &&
			args[0] === 'rev-parse' &&
			args[1] === '--show-toplevel' &&
			options &&
			options.shell === false &&
			typeof callback === 'function' &&
			gitProbe.roots.includes(options.cwd) &&
			fs.realpathSync(options.cwd) === options.cwd &&
			fs.realpathSync(gitProbe.executable) === gitProbe.executable &&
			crypto.createHash('sha256').update(fs.readFileSync(gitProbe.executable)).digest('hex') ===
				gitProbe.sha256;
		if (!allowed) return deny('node:child_process.execFile')();
		return originalExecFile(
			gitProbe.executable,
			args,
			{
				cwd: options.cwd,
				encoding: 'utf8',
				maxBuffer: 1024 * 1024,
				timeout: 20000,
				env: {
					PATH: gitProbe.path,
					HOME: gitProbe.home,
					GIT_CONFIG_NOSYSTEM: '1',
					GIT_CONFIG_GLOBAL: '/dev/null',
					GIT_TERMINAL_PROMPT: '0',
					GIT_OPTIONAL_LOCKS: '0',
					GIT_CEILING_DIRECTORIES: path.dirname(options.cwd),
				},
			},
			callback
		);
	};
	execFile[promisify.custom] = (command, args, options) =>
		new Promise((resolve, reject) => {
			execFile(command, args, options, (error, stdout, stderr) => {
				if (error) {
					error.stdout = stdout;
					error.stderr = stderr;
					reject(error);
				} else resolve({ stdout, stderr });
			});
		});
	childProcess.execFile = execFile;
	require('node:net').Socket.prototype.connect = deny('Socket.connect');
	globalThis.fetch = deny('fetch');
	syncBuiltinESMExports();
	electron.net.request = deny('electron.net.request');
	electron.net.fetch = deny('electron.net.fetch');
	electron.shell.openExternal = deny('shell.openExternal');
	electron.shell.openPath = deny('shell.openPath');
	const originalHandle = electron.ipcMain.handle.bind(electron.ipcMain);
	const support = new Set([
		'sessions:getAll',
		'groups:getAll',
		'settings:getAll',
		'settings:set',
		'logger:log',
		'logger:getLogLevel',
		'logger:getMaxLogBuffer',
		'notification:show',
	]);
	electron.ipcMain.handle = (channel, handler) => {
		assert.ok(
			channel.startsWith('board:') || support.has(channel),
			`Unexpected fixture IPC: ${channel}`
		);
		originalHandle(channel, (event, ...args) => {
			validate(event);
			// There is no runtime owner, Cue engine, CLI server or provider service in this host.
			if (['board:cancelCard', 'board:resumeCard'].includes(channel)) return deny(channel)();
			if (channel === 'board:runtimeCommand') {
				record.denied.push(channel);
				return {
					ok: false,
					error: { code: 'runtime-unavailable', message: 'Fixture execution is disabled' },
				};
			}
			return handler(event, ...args);
		});
	};
	return {
		secureSession(session) {
			session.setPermissionCheckHandler(() => false);
			session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
			session.webRequest.onBeforeRequest((details, callback) => {
				const allowed =
					details.url.startsWith('file:') ||
					details.url === 'about:blank' ||
					details.url.startsWith('data:');
				if (!allowed) record.denied.push(`request:${details.url}`);
				callback({ cancel: !allowed });
			});
		},
	};
}

module.exports = { installRenderedBoundary };
