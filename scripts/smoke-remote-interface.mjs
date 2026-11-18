// Smoke-test the remote interface (web-desktop / phone) against a RUNNING Maestro.
//
// Dials the bridge the way the browser does: `bridgeChunks=1` framing,
// cumulative chunk acknowledgements, and the startup reads fired together.
// Then it holds the socket open so broadcast pushes (lifecycleSync and the
// rest) arrive too. It fails when the host closes the socket, when a read
// fails or never answers, or when any one message is larger than the
// host's per-client output ceiling.
//
// Why this exists: the phone showed "Could not load your agents" because the
// bootstrap had grown to 47 MB (stored file trees) and the host closed the
// socket with 1013 on every reconnect. Every remote test used small fixtures
// and mocked transports, so nothing ever sent a real profile down the wire.
//
//   node scripts/smoke-remote-interface.mjs                      # this machine's app
//   node scripts/smoke-remote-interface.mjs --data-dir <dir>     # a dev or demo profile
//   node scripts/smoke-remote-interface.mjs --host 192.168.1.46  # through the LAN (Live mode on)

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Same value as WEB_CLIENT_MAX_BUFFERED_BYTES in src/main/web-server/services/socket-send.ts. */
export const HOST_OUTPUT_CEILING_BYTES = 8 * 1024 * 1024;

export const DEFAULTS = {
	dataDir: null,
	host: '127.0.0.1',
	replyTimeoutMs: 30_000,
	settleMs: 10_000,
	warnBytes: 4 * 1024 * 1024,
};

/** The read probes the host itself uses to advertise each remote workflow (remote-workflows.ts). */
export const READ_CHANNELS = [
	'sessions:getBootstrap',
	'groups:getAll',
	'web:getAutoRunStates',
	'settings:getAll',
	'prompts:getSystemPromptPaths',
	'process:getActiveProcesses',
	'fs:homeDir',
];

/** Maestro's production data directory on each platform. */
export function defaultDataDir(
	platform = process.platform,
	env = process.env,
	home = os.homedir()
) {
	if (env.MAESTRO_USER_DATA) return env.MAESTRO_USER_DATA;
	if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'maestro');
	if (platform === 'win32')
		return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'maestro');
	return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'maestro');
}

export function parseArgs(argv) {
	const options = { ...DEFAULTS };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = argv[i + 1];
		switch (flag) {
			case '--data-dir':
				options.dataDir = value;
				break;
			case '--host':
				options.host = value;
				break;
			case '--reply-timeout':
				options.replyTimeoutMs = Number(value) * 1000;
				break;
			case '--settle':
				options.settleMs = Number(value) * 1000;
				break;
			default:
				throw new Error(`Unknown argument: ${flag}`);
		}
		i++;
		if (value === undefined) throw new Error(`Missing value for ${flag}`);
	}
	for (const key of ['replyTimeoutMs', 'settleMs']) {
		if (!Number.isFinite(options[key]) || options[key] < 0)
			throw new Error(`Invalid value for ${key}: ${options[key]}`);
	}
	return options;
}

/**
 * Turn one run into failures and warnings (no failures = healthy).
 * `run.replies` maps a channel to `{ ok, bytes, ms, error? }`; a missing entry never answered.
 * `run.messages` lists every whole message as `{ label, bytes }`.
 * `run.close` is `{ code, reason }` when the host closed the socket during the run.
 */
export function assessRun(run, warnBytes = DEFAULTS.warnBytes) {
	const failures = [];
	const warnings = [];
	if (run.close)
		failures.push(`the host closed the socket: ${run.close.code} ${run.close.reason || ''}`.trim());
	for (const channel of READ_CHANNELS) {
		const reply = run.replies[channel];
		if (!reply) failures.push(`${channel} never answered`);
		else if (!reply.ok) failures.push(`${channel} failed: ${reply.error ?? 'no error text'}`);
	}
	for (const message of run.messages) {
		const size = `${(message.bytes / 1e6).toFixed(2)} MB`;
		if (message.bytes > HOST_OUTPUT_CEILING_BYTES)
			failures.push(`${message.label} is ${size}, over the host's 8 MiB per-client ceiling`);
		else if (message.bytes > warnBytes)
			warnings.push(`${message.label} is ${size}, more than half the 8 MiB ceiling`);
	}
	return { failures, warnings };
}

function readEndpoint(dataDir) {
	const file = path.join(dataDir, 'cli-server.json');
	try {
		const { port, token } = JSON.parse(readFileSync(file, 'utf8'));
		if (!port || !token) throw new Error('missing port or token');
		return { port, token };
	} catch (error) {
		throw new Error(`No running Maestro found through ${file}: ${error.message}`);
	}
}

/** One connection, as the browser makes it. Resolves with the run record `assessRun` reads. */
function probe(options) {
	const { port, token } = readEndpoint(options.dataDir ?? defaultDataDir());
	const socket = new WebSocket(`ws://${options.host}:${port}/${token}/ws?bridgeChunks=1`);
	const started = Date.now();
	const run = { replies: {}, messages: [], close: null };
	let chunks = null;
	return new Promise((resolve, reject) => {
		let settleTimer;
		const finish = () => {
			clearTimeout(replyTimer);
			clearTimeout(settleTimer);
			socket.onclose = null;
			socket.close();
			resolve(run);
		};
		const replyTimer = setTimeout(finish, options.replyTimeoutMs);
		socket.onerror = () => reject(new Error(`Could not connect to ws://${options.host}:${port}`));
		socket.onopen = () => {
			for (const channel of READ_CHANNELS)
				socket.send(
					JSON.stringify({ type: 'bridge.invoke', requestId: channel, channel, args: [] })
				);
		};
		socket.onclose = (event) => {
			run.close = { code: event.code, reason: event.reason };
			finish();
		};
		socket.onmessage = (event) => {
			let text = String(event.data);
			let message = JSON.parse(text);
			if (message.type === 'bridge.chunk') {
				chunks = (chunks ?? '') + message.data;
				socket.send(
					JSON.stringify({ type: 'bridge.chunkAck', offset: message.offset + message.data.length })
				);
				if (!message.final) return;
				text = chunks;
				chunks = null;
				message = JSON.parse(text);
			}
			const label =
				message.type === 'bridge.response'
					? `reply to ${message.requestId}`
					: message.type === 'bridge.event'
						? `event ${message.channel}`
						: `push ${message.type}`;
			run.messages.push({ label, bytes: Buffer.byteLength(text) });
			if (message.type !== 'bridge.response' || !READ_CHANNELS.includes(message.requestId)) return;
			run.replies[message.requestId] = {
				ok: message.ok === true,
				bytes: Buffer.byteLength(text),
				ms: Date.now() - started,
				error: message.error,
			};
			if (Object.keys(run.replies).length === READ_CHANNELS.length) {
				clearTimeout(replyTimer);
				settleTimer = setTimeout(finish, options.settleMs);
			}
		};
	});
}

async function run(options) {
	const result = await probe(options);
	for (const channel of READ_CHANNELS) {
		const reply = result.replies[channel];
		if (reply)
			console.log(
				`  ${reply.ok ? 'ok  ' : 'FAIL'} ${channel}  ${(reply.bytes / 1e6).toFixed(2)} MB  ${reply.ms} ms`
			);
	}
	const largest = [...result.messages].sort((a, b) => b.bytes - a.bytes).slice(0, 3);
	console.log(
		`  ${result.messages.length} messages; largest: ${largest
			.map((m) => `${m.label} ${(m.bytes / 1e6).toFixed(2)} MB`)
			.join(', ')}`
	);
	const { failures, warnings } = assessRun(result, options.warnBytes);
	for (const warning of warnings) console.warn(`  warning: ${warning}`);
	if (failures.length > 0) {
		console.error('\nREMOTE INTERFACE SMOKE TEST FAILED');
		for (const failure of failures) console.error(`  - ${failure}`);
		return 1;
	}
	console.log('REMOTE INTERFACE SMOKE TEST PASSED: a browser can load and stay connected.');
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	run(parseArgs(process.argv.slice(2))).then(
		(code) => process.exit(code),
		(error) => {
			console.error(error.message);
			process.exit(1);
		}
	);
}
