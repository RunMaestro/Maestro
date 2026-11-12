#!/usr/bin/env node
// Launch a PACKAGED Maestro build and prove it starts: the main process stays
// up, the renderer loads from app://, React mounts, the preload bridge exists,
// and nothing throws uncaught while it settles.
//
// Why this exists: a release once shipped that would not start on Windows.
// Every pipeline step was green, because nothing ever ran the packaged app.
// This closes that gap. Release CI runs it on the Windows package before the
// artifacts are uploaded, and it works locally on any platform:
//
//   node scripts/smoke-launch-packaged.mjs                 # this platform's release/ output
//   node scripts/smoke-launch-packaged.mjs --app <binary>  # an explicit executable
//
// The app runs in demo mode (MAESTRO_DEMO_DIR in a fresh temp folder), so it
// never touches the user's real data and never meets the single-instance lock
// of a Maestro that is already running.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULTS = {
	port: 9333,
	readyTimeoutMs: 120_000,
	settleMs: 15_000,
};

/**
 * The executable electron-builder's `--dir` output puts on each platform.
 * @param {string} [platform]
 * @param {string} [arch]
 */
export function defaultAppPath(platform = process.platform, arch = process.arch) {
	switch (platform) {
		case 'darwin':
			return path.join(
				rootDir,
				'release',
				arch === 'arm64' ? 'mac-arm64' : 'mac',
				'Maestro.app/Contents/MacOS/Maestro'
			);
		case 'win32':
			return path.join(rootDir, 'release', 'win-unpacked', 'Maestro.exe');
		default:
			return path.join(rootDir, 'release', 'linux-unpacked', 'maestro');
	}
}

export function parseArgs(argv) {
	const options = { ...DEFAULTS, app: null };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		switch (flag) {
			case '--app':
				options.app = value;
				i++;
				break;
			case '--port':
				options.port = Number(value);
				i++;
				break;
			case '--ready-timeout':
				options.readyTimeoutMs = Number(value) * 1000;
				i++;
				break;
			case '--settle':
				options.settleMs = Number(value) * 1000;
				i++;
				break;
			default:
				throw new Error(`Unknown argument: ${flag}`);
		}
	}
	for (const key of ['port', 'readyTimeoutMs', 'settleMs']) {
		if (!Number.isFinite(options[key]) || options[key] < 0) {
			throw new Error(`Invalid value for ${key}: ${options[key]}`);
		}
	}
	return options;
}

/**
 * Turn one look at the renderer into a list of failures (empty = healthy).
 * `probe` is null when no app:// page exists yet.
 */
export function assessProbe(probe) {
	if (!probe) return ['no app://app renderer page is open'];
	const failures = [];
	if (!(probe.rootChildren > 0)) failures.push('React did not mount into #root');
	if (!probe.hasBridge) failures.push('window.maestro (the preload bridge) is missing');
	if (probe.errorBoundary) failures.push('the renderer is showing the error boundary');
	return failures;
}

const PROBE_EXPRESSION = `({
	rootChildren: document.getElementById('root')?.childElementCount ?? 0,
	hasBridge: typeof window.maestro === 'object' && window.maestro !== null,
	errorBoundary: /Something went wrong/.test(document.body?.innerText ?? ''),
})`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function findAppPage(port) {
	try {
		const response = await fetch(`http://127.0.0.1:${port}/json/list`);
		const targets = await response.json();
		return targets.find((t) => t.type === 'page' && t.url.startsWith('app://app/')) ?? null;
	} catch {
		return null; // DevTools endpoint is not up yet.
	}
}

/** A minimal CDP session: send commands, and collect uncaught exceptions. */
async function connect(webSocketUrl) {
	const ws = new WebSocket(webSocketUrl);
	await new Promise((resolve, reject) => {
		ws.addEventListener('open', resolve, { once: true });
		ws.addEventListener('error', reject, { once: true });
	});
	let nextId = 0;
	const pending = new Map();
	const exceptions = [];
	ws.addEventListener('message', (event) => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			pending.get(message.id)(message);
			pending.delete(message.id);
		} else if (message.method === 'Runtime.exceptionThrown') {
			const details = message.params.exceptionDetails;
			exceptions.push(details.exception?.description ?? details.text);
		}
	});
	// A renderer that reloads closes this socket mid-command; time out rather
	// than wait forever on a reply that will never come.
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = ++nextId;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`CDP ${method} timed out`));
			}, 10_000);
			pending.set(id, (message) => {
				clearTimeout(timer);
				resolve(message);
			});
			ws.send(JSON.stringify({ id, method, params }));
		});
	const probe = async () => {
		const reply = await send('Runtime.evaluate', {
			expression: PROBE_EXPRESSION,
			returnByValue: true,
		});
		return reply.result?.result?.value ?? null;
	};
	return { send, probe, exceptions, close: () => ws.close() };
}

function killTree(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform === 'win32') {
		spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
	} else {
		child.kill('SIGTERM');
	}
}

async function run(options) {
	const app = path.resolve(options.app ?? defaultAppPath());
	if (!fs.existsSync(app)) throw new Error(`Packaged app not found: ${app}`);

	const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-smoke-'));
	const env = { ...process.env, MAESTRO_DEMO_DIR: demoDir };
	// Set inside an Electron-hosted shell (an agent's terminal), this makes the
	// binary run as plain Node and reject every Chromium flag.
	delete env.ELECTRON_RUN_AS_NODE;

	console.log(`Launching ${app}`);
	console.log(`Demo data: ${demoDir}`);
	const child = spawn(
		app,
		[`--remote-debugging-port=${options.port}`, '--remote-debugging-address=127.0.0.1'],
		{ env, stdio: ['ignore', 'pipe', 'pipe'] }
	);
	let output = '';
	child.stdout.on('data', (chunk) => (output += chunk));
	child.stderr.on('data', (chunk) => (output += chunk));
	let exited = null;
	child.on('exit', (code, signal) => (exited = { code, signal }));

	const failures = [];
	let session = null;
	try {
		// Phase 1: wait for a mounted, bridged renderer.
		const deadline = Date.now() + options.readyTimeoutMs;
		let lastFailures = ['the app did not open a DevTools endpoint'];
		while (Date.now() < deadline && !exited) {
			const page = await findAppPage(options.port);
			if (page) {
				try {
					session ??= await connect(page.webSocketDebuggerUrl);
					lastFailures = assessProbe(await session.probe());
					if (lastFailures.length === 0) break;
				} catch {
					// The page went away under us (a reload); reconnect next pass.
					session?.close();
					session = null;
				}
			}
			await sleep(1000);
		}
		if (exited) {
			failures.push(`the app exited during startup (${JSON.stringify(exited)})`);
		} else if (lastFailures.length > 0) {
			failures.push(...lastFailures.map((f) => `not ready after timeout: ${f}`));
		} else {
			console.log('Renderer mounted with the preload bridge. Watching it settle...');
			await session.send('Runtime.enable');
			// Phase 2: it must STAY up. A renderer that dies and reloads on every
			// launch passes a single probe; it does not survive this window.
			await sleep(options.settleMs);
			if (exited) {
				failures.push(`the app exited after startup (${JSON.stringify(exited)})`);
			} else {
				const page = await findAppPage(options.port);
				let settled = null;
				if (page) {
					const check = await connect(page.webSocketDebuggerUrl);
					settled = await check.probe().catch(() => null);
					check.close();
				}
				failures.push(...assessProbe(settled).map((f) => `after settling: ${f}`));
			}
			for (const exception of session.exceptions) {
				failures.push(`uncaught renderer exception: ${exception.split('\n')[0]}`);
			}
		}
	} finally {
		session?.close();
		killTree(child);
		await sleep(1500);
		fs.rmSync(demoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
	}

	if (failures.length > 0) {
		console.error('\nSMOKE TEST FAILED');
		for (const failure of failures) console.error(`  - ${failure}`);
		console.error('\nLast app output:\n' + output.split('\n').slice(-60).join('\n'));
		return 1;
	}
	console.log('SMOKE TEST PASSED: the packaged app starts and stays up.');
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	run(parseArgs(process.argv.slice(2))).then(
		(code) => process.exit(code),
		(error) => {
			console.error(error);
			process.exit(1);
		}
	);
}
