#!/usr/bin/env node
/**
 * Record one real provider turn for the replay tests.
 *
 * Starts a provider with exactly the arguments Maestro gives it (planned by
 * maestro-lib's `planSessionTurn`, the same code the headless program runs),
 * in a clean environment, and writes everything the process did to a JSON
 * file: every stdout chunk as it arrived, its stderr, and how it closed. The
 * file has the shape of the recordings in
 * `src/__tests__/main/process-manager/recordings/captured/`, so a capture made
 * on any machine drops in beside them and replaces a documented-format
 * recording (`documented.ts`) with a real one.
 *
 *   node scripts/record-provider-turn.mjs --agent <id> --out <file.json>
 *        [--prompt <text>] [--resume <session id>] [--model <model>]
 *        [--command <path>] [--cwd <dir>] [--keep-env <NAME>]...
 *        [--stop SIGINT|SIGTERM --stop-after <text> [--stop-delay <ms>]]
 *        [--tool-command <command line>]
 *
 * `--stop` sends the signal `--stop-delay` ms (1500 by default) after
 * `--stop-after` first appears in stdout: the desktop Stop button sends SIGINT,
 * a CLI stop sends SIGTERM. `--tool-command` names the command the agent's
 * shell tool is running (for example `sleep 41`); after a stop the recorder
 * reports whether it survived the agent, and ends it.
 *
 * The provider runs with HOME, PATH and the locale from this shell, the
 * variables Maestro sets, and any `--keep-env` names (an API key, a config
 * directory). Nothing else is inherited, so a recording does not depend on
 * what the capturing shell happened to export.
 *
 * Before anything is written the capture is cleaned and then checked: the
 * working directory reads `/project`, a Claude-style init event loses its MCP
 * servers, skills, plugins and machine paths, and em and en dashes become
 * hyphens (repo rule). If a home directory path, the local user name or an
 * email address is still present, nothing is written and the offending text
 * is printed instead.
 */

import * as esbuild from 'esbuild';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NORMAL_PROMPT =
	'Reply with exactly this sentence and nothing else: The capital of France is Paris.';
const DEFAULT_STOP_DELAY_MS = 1500;
const INHERITED_ENV = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR'];
const VALUE_FLAGS = [
	'--agent',
	'--out',
	'--prompt',
	'--resume',
	'--model',
	'--command',
	'--cwd',
	'--stop',
	'--stop-after',
	'--stop-delay',
	'--tool-command',
];

const USAGE = `Usage: node scripts/record-provider-turn.mjs --agent <id> --out <file.json>
       [--prompt <text>] [--resume <session id>] [--model <model>]
       [--command <path>] [--cwd <dir>] [--keep-env <NAME>]...
       [--stop SIGINT|SIGTERM --stop-after <text> [--stop-delay <ms>]]
       [--tool-command <command line>]`;

/** Parse the command line. Returns `{ error }` for a request that cannot be run. */
export function parseArgs(argv) {
	const values = {};
	const keepEnv = [];
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === '--keep-env') {
			if (value === undefined) return { error: '--keep-env needs a variable name' };
			keepEnv.push(value);
			index++;
			continue;
		}
		if (!VALUE_FLAGS.includes(flag)) return { error: `Unknown option: ${flag}` };
		if (value === undefined) return { error: `${flag} needs a value` };
		values[flag] = value;
		index++;
	}

	if (!values['--agent']) return { error: '--agent is required' };
	if (!values['--out']) return { error: '--out is required' };
	const stop = values['--stop'];
	if (stop !== undefined && stop !== 'SIGINT' && stop !== 'SIGTERM') {
		return { error: '--stop must be SIGINT or SIGTERM' };
	}
	if (stop && !values['--stop-after']) {
		return { error: '--stop needs --stop-after: the stdout text that shows the turn is under way' };
	}
	const stopDelayMs = values['--stop-delay']
		? Number(values['--stop-delay'])
		: DEFAULT_STOP_DELAY_MS;
	if (!Number.isFinite(stopDelayMs) || stopDelayMs < 0) {
		return { error: '--stop-delay must be a number of milliseconds' };
	}

	return {
		agentId: values['--agent'],
		out: values['--out'],
		prompt: values['--prompt'] ?? NORMAL_PROMPT,
		resumeSessionId: values['--resume'],
		model: values['--model'],
		command: values['--command'],
		cwd: values['--cwd'],
		stop: stop ? { signal: stop, after: values['--stop-after'], delayMs: stopDelayMs } : null,
		toolCommand: values['--tool-command'],
		keepEnv,
	};
}

/**
 * The environment the provider runs in: the few variables a CLI needs from the
 * shell, the ones Maestro set on top of what it inherited, and the ones the
 * operator asked to keep.
 */
export function cleanEnvironment(plannedEnv, inheritedEnv, keepEnv) {
	const env = {};
	for (const name of [...INHERITED_ENV, ...keepEnv]) {
		if (inheritedEnv[name] !== undefined) env[name] = inheritedEnv[name];
	}
	for (const [name, value] of Object.entries(plannedEnv)) {
		if (value !== undefined && value !== inheritedEnv[name]) env[name] = value;
	}
	return env;
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Machine-specific fields of a Claude-style `system` / `init` event. */
function trimInitEvent(event) {
	const trimmed = { ...event, cwd: '/project' };
	for (const key of ['mcp_servers', 'skills', 'plugins', 'agents']) {
		if (Array.isArray(trimmed[key])) trimmed[key] = [];
	}
	if (Array.isArray(trimmed.tools)) {
		trimmed.tools = trimmed.tools.filter(
			(tool) => typeof tool !== 'string' || !tool.startsWith('mcp__')
		);
	}
	if (Array.isArray(trimmed.slash_commands)) {
		// A plugin's or a project's command is named `owner:command`.
		trimmed.slash_commands = trimmed.slash_commands.filter(
			(command) => typeof command !== 'string' || !command.includes(':')
		);
	}
	for (const key of Object.keys(trimmed)) {
		if (/memory|scratchpad|socket/i.test(key)) delete trimmed[key];
	}
	return trimmed;
}

/**
 * Clean one stdout chunk. Chunk boundaries are part of the recording, so a
 * chunk is cleaned in place and never split or joined: complete JSON lines
 * inside it are trimmed as events, and the rest only has its paths and dashes
 * replaced.
 */
export function sanitizeChunk(chunk, { cwd, realCwd }) {
	const pieces = chunk.split(/(\n)/);
	const cleaned = pieces.map((piece) => {
		if (piece === '\n' || piece.trim() === '') return piece;
		let text = piece;
		try {
			const event = JSON.parse(piece);
			if (event && event.type === 'system' && event.subtype === 'init') {
				text = JSON.stringify(trimInitEvent(event));
			}
		} catch {
			// Not a whole JSON line: a line split across two chunks, or plain text.
		}
		return text;
	});

	let text = cleaned.join('');
	// The longer path first, so a cwd inside the real path is not half replaced.
	for (const dir of [...new Set([realCwd, cwd])].sort((a, b) => b.length - a.length)) {
		if (dir && dir !== '/') text = text.replace(new RegExp(escapeRegExp(dir), 'g'), '/project');
	}
	return text.replace(/[\u2013\u2014]/g, '-');
}

/**
 * What in `text` still names the capturing machine or its user. Empty when the
 * text is safe to commit.
 */
export function findLeaks(text, { username }) {
	const patterns = [
		['a home directory path', /(?:\/Users\/|\/home\/|[A-Za-z]:\\\\?Users\\\\?)[^\s"'\\/]+/g],
		['an email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/g],
	];
	if (username && username.length >= 3) {
		patterns.push(['the local user name', new RegExp(`\\b${escapeRegExp(username)}\\b`, 'g')]);
	}

	const leaks = [];
	for (const [what, pattern] of patterns) {
		for (const match of text.matchAll(pattern)) {
			const from = Math.max(0, match.index - 30);
			leaks.push({ what, excerpt: text.slice(from, match.index + match[0].length + 30) });
		}
	}
	return leaks;
}

/** The command as it is recorded: the binary by name, the prompt and the directory masked. */
export function describeCommand(command, args, { prompt, cwd, realCwd }) {
	const mask = (arg) => {
		if (arg === prompt) return '<prompt>';
		let text = arg;
		for (const dir of [realCwd, cwd]) {
			if (dir && dir !== '/') text = text.split(dir).join('/project');
		}
		return text;
	};
	return [path.basename(command), ...args.map(mask)];
}

/** Load `planSessionTurn` from the library's TypeScript source. */
async function loadPlanner() {
	const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-record-'));
	const outfile = path.join(bundleDir, 'session.cjs');
	await esbuild.build({
		entryPoints: [path.join(rootDir, 'src/shared/maestro-lib/run/session.ts')],
		bundle: true,
		platform: 'node',
		target: 'node20',
		format: 'cjs',
		outfile,
		external: ['node-pty'],
		logLevel: 'silent',
	});
	const { planSessionTurn } = createRequire(import.meta.url)(outfile);
	fs.rmSync(bundleDir, { recursive: true, force: true });
	return planSessionTurn;
}

function providerVersion(command, env) {
	try {
		const output = execFileSync(command, ['--version'], { env, encoding: 'utf8', timeout: 15000 });
		return output.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? output.trim().split('\n')[0];
	} catch {
		return 'unknown';
	}
}

/** Pids of processes whose whole command line is `commandLine`. */
function pidsRunning(commandLine) {
	if (process.platform === 'win32') return [];
	try {
		return execFileSync('ps', ['-eo', 'pid=,command='], { encoding: 'utf8' })
			.split('\n')
			.map((row) => row.trim().match(/^(\d+)\s+(.*)$/))
			.filter((match) => match && match[2] === commandLine)
			.map((match) => Number(match[1]));
	} catch {
		return [];
	}
}

function localDate() {
	const now = new Date();
	const pad = (value) => String(value).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function runProvider(spec, env, stop) {
	return new Promise((resolve, reject) => {
		const child = spawn(spec.command, spec.args, {
			cwd: spec.cwd,
			env,
			stdio: [spec.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
		});
		const chunks = [];
		let stdout = '';
		let stderr = '';
		let stopTimer;
		let stopSent = false;

		// Decoded on the stream, as Maestro decodes it, so a multibyte character
		// split across two reads is not recorded as two broken halves.
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', (text) => {
			chunks.push(text);
			stdout += text;
			if (stop && !stopTimer && stdout.includes(stop.after)) {
				stopTimer = setTimeout(() => {
					stopSent = child.kill(stop.signal);
				}, stop.delayMs);
			}
		});
		child.stderr.on('data', (text) => {
			stderr += text;
		});
		child.once('error', reject);
		child.once('close', (code, signal) => {
			clearTimeout(stopTimer);
			resolve({ chunks, stderr, close: { code, signal }, stopSent });
		});

		if (spec.stdin) {
			child.stdin.on('error', () => {});
			child.stdin.end(spec.stdin);
		}
	});
}

async function main(argv) {
	const options = parseArgs(argv);
	if (options.error) {
		process.stderr.write(`${options.error}\n${USAGE}\n`);
		return 2;
	}

	const cwd = path.resolve(options.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-turn-')));
	const realCwd = fs.realpathSync(cwd);

	const planSessionTurn = await loadPlanner();
	const planned = await planSessionTurn({
		agentId: options.agentId,
		cwd,
		prompt: options.prompt,
		resumeSessionId: options.resumeSessionId,
		model: options.model,
		command: options.command,
	});
	if (!planned.ok) {
		process.stderr.write(`${planned.error}\n`);
		return 2;
	}

	const { spec } = planned;
	const env = cleanEnvironment(spec.env, process.env, options.keepEnv);
	const version = providerVersion(spec.command, env);

	process.stderr.write(`Recording ${options.agentId} ${version} in ${cwd}\n`);
	const run = await runProvider(spec, env, options.stop);

	if (options.stop && !run.stopSent) {
		process.stderr.write(
			`The turn ended before the stop was sent: "${options.stop.after}" never appeared in stdout, ` +
				'or the turn finished inside the delay. Nothing was written.\n'
		);
		return 1;
	}

	let stopNote = null;
	if (options.stop) {
		stopNote = `${options.stop.signal} ${options.stop.delayMs}ms after "${options.stop.after}" appeared in stdout.`;
		if (options.toolCommand) {
			const survivors = pidsRunning(options.toolCommand);
			stopNote += survivors.length
				? ` The tool (${options.toolCommand}) was still running after the agent exited.`
				: ` The tool (${options.toolCommand}) was gone once the agent exited.`;
			for (const pid of survivors) {
				try {
					process.kill(pid, 'SIGKILL');
				} catch {
					// Already gone.
				}
			}
		}
	}

	const paths = { cwd, realCwd };
	const recording = {
		provider: options.agentId,
		providerVersion: version,
		capturedOn: localDate(),
		platform: process.platform,
		command: describeCommand(spec.command, spec.args, { prompt: options.prompt, ...paths }),
		prompt: options.prompt,
		stop: stopNote,
		chunks: run.chunks.map((chunk) => sanitizeChunk(chunk, paths)),
		stderr: sanitizeChunk(run.stderr, paths),
		close: run.close,
	};

	const leaks = findLeaks(JSON.stringify(recording), { username: os.userInfo().username });
	if (leaks.length > 0) {
		process.stderr.write(
			'The capture still names this machine or its user, so nothing was written:\n'
		);
		for (const leak of leaks.slice(0, 20)) {
			process.stderr.write(`  ${leak.what}: ...${leak.excerpt}...\n`);
		}
		return 1;
	}

	fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
	fs.writeFileSync(options.out, `${JSON.stringify(recording, null, '\t')}\n`);
	process.stderr.write(
		`Wrote ${options.out}: ${recording.chunks.length} chunk(s), ` +
			`close ${JSON.stringify(recording.close)}\n`
	);
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main(process.argv.slice(2)).then(
		(status) => {
			process.exitCode = status;
		},
		(error) => {
			process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
			process.exitCode = 1;
		}
	);
}
