import net from 'node:net';
import { spawn } from 'node:child_process';
import { findAvailablePort } from './dev-port.mjs';

const isWindows = process.platform === 'win32';
const npmCommand = isWindows ? 'npm.cmd' : 'npm';
const rendererScript = 'dev:renderer';
const mainScript = process.env.USE_PROD_DATA ? 'dev:main:prod-data' : 'dev:main';
const startupTimeoutMs = 20000;
const pollIntervalMs = 200;

// Spawn an `npm run <script>` child. On Windows npm resolves to npm.cmd, which
// Node >=22.12 refuses to spawn without a shell (post CVE-2024-27980, throwing
// EINVAL). We pass a single shell command string there rather than an args
// array, which both satisfies the shell requirement and avoids the DEP0190
// "args with shell" warning. Args are static and trusted (no user input).
function spawnNpm(args, options) {
	if (isWindows) {
		return spawn([npmCommand, ...args].join(' '), { ...options, shell: true });
	}
	return spawn(npmCommand, args, options);
}

function waitForPort(port, timeoutMs = startupTimeoutMs) {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const hosts = ['127.0.0.1', '::1'];

		const tryHost = (hostIndex = 0) => {
			const socket = net.createConnection({ host: hosts[hostIndex], port });

			socket.once('connect', () => {
				socket.end();
				resolve();
			});

			socket.once('error', () => {
				socket.destroy();

				if (hostIndex < hosts.length - 1) {
					tryHost(hostIndex + 1);
					return;
				}

				if (Date.now() - startedAt >= timeoutMs) {
					reject(new Error(`Timed out waiting for Vite dev server on port ${port}`));
					return;
				}
				setTimeout(() => tryHost(0), pollIntervalMs);
			});
		};

		tryHost();
	});
}

function killChild(child) {
	if (child.exitCode === null && !child.killed) {
		child.kill('SIGTERM');
	}
}

const port = await findAvailablePort();
const sharedEnv = { ...process.env, VITE_PORT: String(port) };

console.log(`[dev] Using VITE_PORT=${port}`);

const renderer = spawnNpm(['run', rendererScript], {
	env: sharedEnv,
	stdio: 'inherit',
});

let shuttingDown = false;
let main = null;

const shutdown = (code = 0) => {
	if (shuttingDown) return;
	shuttingDown = true;
	killChild(renderer);
	if (main) {
		killChild(main);
	}
	process.exit(code);
};

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

renderer.once('exit', (code) => {
	if (shuttingDown) return;
	console.error(`[dev] Renderer exited before Electron started (code ${code ?? 0})`);
	shutdown(code ?? 1);
});

try {
	await waitForPort(port);
} catch (error) {
	console.error(
		`[dev] ${error instanceof Error ? error.message : 'Failed waiting for Vite dev server'}`
	);
	shutdown(1);
}

const cdpPort = process.env.MAESTRO_CDP_PORT;
const mainArgs = ['run', mainScript];
if (cdpPort) {
	mainArgs.push('--', `--remote-debugging-port=${cdpPort}`);
	console.log(`[dev] Electron CDP enabled on port ${cdpPort}`);
}

main = spawnNpm(mainArgs, {
	env: sharedEnv,
	stdio: 'inherit',
});

main.once('exit', (code) => {
	if (shuttingDown) return;
	shutdown(code ?? 0);
});
