#!/usr/bin/env node
/**
 * A stand-in for llama.cpp's `llama-server` in router mode, for the model server
 * supervisor's tests.
 *
 * It takes the arguments the supervisor starts the real one with:
 *
 *   --host, --port       where it listens
 *   --api-key-file       the keys every route but /health requires, read once at start
 *   --models-preset      the presets file; its section names are the models it lists
 *   --models-max         how many models it keeps loaded
 *
 * and answers what the supervisor asks, in the real one's shapes:
 *
 *   GET  /health             200 {"status":"ok"}, with no key
 *   GET  /models[?reload=1]  { data: [{ id, status: { value, failed?, exit_code? } }] }
 *   POST /models/load        { model }: "loading", then "loaded" (or a failed unload)
 *
 * It exits 0 on SIGTERM. The environment changes what it does:
 *
 *   FAKE_LLAMA_SERVER_ARGV_OUT        write its arguments here (JSON)
 *   FAKE_LLAMA_SERVER_ENV_OUT         write its environment here (JSON)
 *   FAKE_LLAMA_SERVER_KEYS_OUT        write the keys it read here (JSON)
 *   FAKE_LLAMA_SERVER_FAIL_START      print this line to stderr and exit 1 without listening
 *   FAKE_LLAMA_SERVER_STARTS_FILE     append a line per start, to count them
 *   FAKE_LLAMA_SERVER_CRASHES         on this many starts (counted in STARTS_FILE), exit 3 once up
 *   FAKE_LLAMA_SERVER_CRASH_AFTER_MS  how long after it is up that comes (default 100)
 *   FAKE_LLAMA_SERVER_HANGS           on this many starts (counted in STARTS_FILE), stop
 *                                     answering /health 200 ms after it is up
 *   FAKE_LLAMA_SERVER_LOAD_MS         how long a model takes to load (default 50)
 *   FAKE_LLAMA_SERVER_LOAD_FAIL       a model load fails with exit code 1
 */

import fs from 'node:fs';
import http from 'node:http';

const env = process.env;
const argv = process.argv.slice(2);

function option(name) {
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
}

if (env.FAKE_LLAMA_SERVER_ARGV_OUT) {
	fs.writeFileSync(env.FAKE_LLAMA_SERVER_ARGV_OUT, JSON.stringify(argv));
}
if (env.FAKE_LLAMA_SERVER_ENV_OUT) {
	fs.writeFileSync(env.FAKE_LLAMA_SERVER_ENV_OUT, JSON.stringify(env));
}

let startNumber = 0;
if (env.FAKE_LLAMA_SERVER_STARTS_FILE) {
	fs.appendFileSync(env.FAKE_LLAMA_SERVER_STARTS_FILE, 'start\n');
	startNumber = fs
		.readFileSync(env.FAKE_LLAMA_SERVER_STARTS_FILE, 'utf8')
		.split('\n')
		.filter(Boolean).length;
}

/**
 * Print `line` to stderr, then exit. Written synchronously: a `process.stderr`
 * write to a pipe can still be pending when the process exits on macOS.
 */
function exitWith(code, line) {
	fs.writeSync(2, `${line}\n`);
	process.exit(code);
}

if (env.FAKE_LLAMA_SERVER_FAIL_START) exitWith(1, env.FAKE_LLAMA_SERVER_FAIL_START);

// Read once, at start, like the real one: the file may be gone a moment later.
const keyFile = option('--api-key-file');
const keys = keyFile
	? fs
			.readFileSync(keyFile, 'utf8')
			.split('\n')
			.filter((line) => line && !line.startsWith('#'))
	: [];
if (env.FAKE_LLAMA_SERVER_KEYS_OUT) {
	fs.writeFileSync(env.FAKE_LLAMA_SERVER_KEYS_OUT, JSON.stringify(keys));
}

const presetsFile = option('--models-preset');
const maxModels = Number(option('--models-max') ?? 4);
const loadMs = Number(env.FAKE_LLAMA_SERVER_LOAD_MS ?? 50);

/** id -> { value, failed, exitCode, usedAt } */
const models = new Map();

function readPresets() {
	if (!presetsFile) return;
	const ids = [];
	for (const line of fs.readFileSync(presetsFile, 'utf8').split('\n')) {
		const match = /^\s*\[(.+?)\]\s*$/.exec(line);
		if (match && match[1] !== '*') ids.push(match[1]);
	}
	for (const id of ids) {
		if (!models.has(id))
			models.set(id, { value: 'unloaded', failed: false, exitCode: 0, usedAt: 0 });
	}
	for (const id of [...models.keys()]) if (!ids.includes(id)) models.delete(id);
}
readPresets();

function send(res, status, body) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(body));
}

function authorized(req) {
	if (keys.length === 0) return true;
	let key = req.headers.authorization ?? req.headers['x-api-key'] ?? '';
	if (key.startsWith('Bearer ')) key = key.slice('Bearer '.length);
	return keys.includes(key);
}

function readBody(req) {
	return new Promise((resolve) => {
		let text = '';
		req.setEncoding('utf8');
		req.on('data', (chunk) => (text += chunk));
		req.on('end', () => resolve(text));
	});
}

let hangHealth = false;

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', 'http://localhost');
	if (url.pathname === '/health') {
		if (hangHealth) return; // never answered
		send(res, 200, { status: 'ok' });
		return;
	}
	if (!authorized(req)) {
		send(res, 401, {
			error: { code: 401, message: 'Invalid API Key', type: 'authentication_error' },
		});
		return;
	}
	if (req.method === 'GET' && url.pathname === '/models') {
		if (url.searchParams.has('reload')) readPresets();
		send(res, 200, {
			data: [...models.entries()].map(([id, model]) => ({
				id,
				status: {
					value: model.value,
					...(model.failed ? { failed: true, exit_code: model.exitCode } : {}),
				},
			})),
		});
		return;
	}
	if (req.method === 'POST' && url.pathname === '/models/load') {
		const { model: id } = JSON.parse((await readBody(req)) || '{}');
		const model = models.get(id);
		if (!model) {
			send(res, 404, {
				error: { code: 404, message: 'model is not found', type: 'not_found_error' },
			});
			return;
		}
		if (model.value !== 'unloaded') {
			send(res, 400, {
				error: { code: 400, message: 'model is already running', type: 'invalid_request_error' },
			});
			return;
		}
		// Least recently used goes first, as in the real router.
		const running = [...models.entries()].filter(([, other]) => other.value !== 'unloaded');
		if (maxModels > 0 && running.length >= maxModels) {
			running.sort(([, a], [, b]) => a.usedAt - b.usedAt);
			running[0][1].value = 'unloaded';
		}
		Object.assign(model, { value: 'loading', failed: false, exitCode: 0, usedAt: Date.now() });
		setTimeout(() => {
			if (env.FAKE_LLAMA_SERVER_LOAD_FAIL) {
				Object.assign(model, { value: 'unloaded', failed: true, exitCode: 1 });
			} else {
				model.value = 'loaded';
			}
		}, loadMs);
		send(res, 200, { success: true });
		return;
	}
	send(res, 404, { error: { code: 404, message: 'File Not Found', type: 'not_found_error' } });
});

server.on('error', (error) => exitWith(1, `couldn't bind HTTP server socket: ${error.message}`));

server.listen(Number(option('--port')), option('--host') ?? '127.0.0.1', () => {
	process.stderr.write(`main: server is listening on ${option('--host')}:${option('--port')}\n`);
	const hangs = Number(env.FAKE_LLAMA_SERVER_HANGS ?? 0);
	if (startNumber > 0 && startNumber <= hangs) {
		// Up just long enough for a start to see it.
		setTimeout(() => (hangHealth = true), 200);
	}
	const crashes = Number(env.FAKE_LLAMA_SERVER_CRASHES ?? 0);
	if (startNumber > 0 && startNumber <= crashes) {
		setTimeout(
			() => exitWith(3, 'fake crash'),
			Number(env.FAKE_LLAMA_SERVER_CRASH_AFTER_MS ?? 100)
		);
	}
});

process.on('SIGTERM', () => {
	server.close();
	process.exit(0);
});
