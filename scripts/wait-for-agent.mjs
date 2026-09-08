#!/usr/bin/env node
/**
 * Block until a Maestro agent is genuinely idle, then exit.
 *
 * Usage:
 *   node scripts/wait-for-agent.mjs [options]
 *
 * Options:
 *   --cwd <path>       Resolve the target by working directory. Default: ~/Projects/Maestro
 *   --agent <id>       Resolve the target by agent id instead (wins over --cwd)
 *   --name <name>      Resolve the target by exact agent name instead (wins over --cwd)
 *   --caller <id>      Your own agent id. The wait refuses to target it.
 *   --idle-for <sec>   Continuous idle required before declaring done. Default: 30
 *   --timeout <sec>    Ceiling on the whole wait. Default: 1800
 *   --interval <sec>   Seconds between probes. Default: 5
 *   --cli <path>       maestro-cli.js path. Default: the installed Maestro.app copy
 *   --quiet            Only print the final line
 *
 * Exit codes:
 *   0  idle confirmed
 *   1  timed out while the agent was still working (the last state is printed)
 *   2  misconfigured: app unreachable, target unresolvable, or you targeted yourself
 *
 * Why it is written this way
 * -------------------------
 * Busy state exists ONLY in the running app. Persistence rewrites every session
 * and tab to `state: 'idle'` on the way to disk (see src/main/utils/agent-busy.ts),
 * so maestro-sessions.json reports a fully idle app while a tab is mid-turn.
 * The probe is therefore `maestro-cli session list --json`, which reads live state
 * over the desktop's WebSocket bridge and has no on-disk fallback. `ps`/`pgrep`
 * is no substitute either: an agent can run over SSH, so there is no local process.
 * And `sleep N` is the failure this replaces - sleeping is not detecting.
 *
 * Four rules keep the answer honest:
 *   - The target is resolved by working directory, not by name. Several agents
 *     have "maestro" in their name; exactly one has a given cwd. An ambiguous
 *     match refuses to proceed rather than picking one.
 *   - It never waits on the caller. The caller's own tab is busy for as long as
 *     this runs, so that wait could only ever end in a timeout.
 *   - Idle must be SUSTAINED. An agent between queued items blips idle, so the
 *     window resets the instant work resumes. A queued item counts as working:
 *     the agent is about to start again.
 *   - A failed probe is not evidence of idle. If the desktop goes away, the naive
 *     read is "no busy tabs, therefore done" - reporting success at the exact
 *     moment the truth is unknown. Probe failures reset the window, and three in
 *     a row abort. For the same reason only `state === 'idle'` counts as idle;
 *     `'unknown'` is treated as busy.
 */

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_CLI = '/Applications/Maestro.app/Contents/Resources/maestro-cli.js';
const PROBE_TIMEOUT_MS = 20_000;
const MAX_CONSECUTIVE_PROBE_FAILURES = 3;

function parseArgs(argv) {
	const opts = {
		cwd: path.join(os.homedir(), 'Projects', 'Maestro'),
		agent: null,
		name: null,
		caller: null,
		idleFor: 30,
		timeout: 1800,
		interval: 5,
		cli: process.env.MAESTRO_CLI || DEFAULT_CLI,
		quiet: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) fatal(`${arg} needs a value`);
			return value;
		};
		switch (arg) {
			case '--cwd':
				opts.cwd = next();
				break;
			case '--agent':
				opts.agent = next();
				break;
			case '--name':
				opts.name = next();
				break;
			case '--caller':
				opts.caller = next();
				break;
			case '--idle-for':
				opts.idleFor = Number(next());
				break;
			case '--timeout':
				opts.timeout = Number(next());
				break;
			case '--interval':
				opts.interval = Number(next());
				break;
			case '--cli':
				opts.cli = next();
				break;
			case '--quiet':
				opts.quiet = true;
				break;
			case '-h':
			case '--help':
				printUsage();
				process.exit(0);
			default:
				fatal(`unknown option: ${arg}`);
		}
	}
	for (const key of ['idleFor', 'timeout', 'interval']) {
		if (!Number.isFinite(opts[key]) || opts[key] <= 0) fatal(`--${key} must be a positive number`);
	}
	return opts;
}

function printUsage() {
	console.log(
		[
			'Block until a Maestro agent is idle.',
			'',
			'  node scripts/wait-for-agent.mjs [--cwd <path> | --agent <id> | --name <name>]',
			'                                  [--caller <id>] [--idle-for 30] [--timeout 1800]',
			'                                  [--interval 5] [--cli <path>] [--quiet]',
			'',
			'Exit 0 idle confirmed, 1 timed out still working, 2 misconfigured.',
		].join('\n')
	);
}

function fatal(message) {
	console.error(`FATAL: ${message}`);
	process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toTimeString().slice(0, 8);

/** Run a maestro-cli verb. Resolves to stdout, or null when the call failed. */
function runCli(cliPath, args) {
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			[cliPath, ...args],
			{ timeout: PROBE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
			(error, stdout) => resolve(error ? null : stdout)
		);
	});
}

async function runCliJson(cliPath, args) {
	const stdout = await runCli(cliPath, args);
	if (stdout === null) return null;
	try {
		return JSON.parse(stdout);
	} catch {
		return null;
	}
}

/** Trailing separators and symlinked homes make raw string equality unreliable. */
function normalizeDir(dir) {
	if (typeof dir !== 'string' || dir.length === 0) return null;
	const resolved = path.resolve(dir.replace(/^~(?=$|[/\\])/, os.homedir()));
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function resolveTarget(opts) {
	const agents = await runCliJson(opts.cli, ['list', 'agents', '--json']);
	if (!Array.isArray(agents)) fatal('could not list agents');

	let matches;
	let criterion;
	if (opts.agent) {
		criterion = `id ${opts.agent}`;
		matches = agents.filter((a) => a.id === opts.agent);
	} else if (opts.name) {
		criterion = `name "${opts.name}"`;
		matches = agents.filter((a) => a.name === opts.name);
	} else {
		const want = normalizeDir(opts.cwd);
		criterion = `cwd ${want}`;
		matches = agents.filter((a) => normalizeDir(a.cwd) === want);
	}

	if (matches.length !== 1) {
		fatal(`${matches.length} agents match ${criterion} - need exactly 1`);
	}
	return matches[0];
}

/**
 * Live busy tabs for one agent. Returns null when the probe could not be
 * trusted, which the caller must treat as "not idle" rather than as zero.
 */
async function probeBusyTabs(cliPath, agentId) {
	const data = await runCliJson(cliPath, ['session', 'list', '--json']);
	const sessions = data?.sessions;
	if (!Array.isArray(sessions)) return null;
	return sessions.filter((tab) => tab.agentId === agentId && tab.state !== 'idle');
}

/** Queued items for one agent, or null when the probe could not be trusted. */
async function probeQueueDepth(cliPath, agentId) {
	const data = await runCliJson(cliPath, ['queue', 'list', '--agent', agentId]);
	if (!data || data.success !== true) return null;
	if (Number.isInteger(data.totalItems)) return data.totalItems;
	if (!Array.isArray(data.queues)) return null;
	return data.queues.reduce((sum, queue) => sum + (queue.items?.length ?? 0), 0);
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const log = (line) => {
		if (!opts.quiet) console.log(line);
	};

	if ((await runCli(opts.cli, ['status'])) === null) {
		fatal('Maestro desktop not reachable');
	}

	const target = await resolveTarget(opts);
	if (opts.caller && target.id === opts.caller) {
		fatal(`'${target.name}' is me - waiting on myself never returns.`);
	}

	log(
		`Waiting on '${target.name}' (${target.id.slice(0, 8)}): ` +
			`${opts.idleFor}s continuous idle, timeout ${opts.timeout}s`
	);

	const deadline = Date.now() + opts.timeout * 1000;
	let idleSince = null;
	let consecutiveFailures = 0;
	let lastPrinted = '';
	let lastState = 'unknown';

	for (;;) {
		if (Date.now() >= deadline) {
			console.log(`TIMEOUT ${opts.timeout}s - '${target.name}' still working: ${lastState}`);
			return 1;
		}

		const [busyTabs, queueDepth] = await Promise.all([
			probeBusyTabs(opts.cli, target.id),
			probeQueueDepth(opts.cli, target.id),
		]);

		if (busyTabs === null || queueDepth === null) {
			consecutiveFailures++;
			idleSince = null;
			log(
				`[${stamp()}] probe failed (${consecutiveFailures}/${MAX_CONSECUTIVE_PROBE_FAILURES}) - not idle`
			);
			if (consecutiveFailures >= MAX_CONSECUTIVE_PROBE_FAILURES) {
				fatal('lost contact with Maestro');
			}
			await sleep(opts.interval * 1000);
			continue;
		}

		consecutiveFailures = 0;

		if (busyTabs.length === 0 && queueDepth === 0) {
			if (idleSince === null) {
				idleSince = Date.now();
				log(`[${stamp()}] idle - opening ${opts.idleFor}s window`);
			}
			const held = Math.round((Date.now() - idleSince) / 1000);
			if (held >= opts.idleFor) {
				console.log(`[${stamp()}] '${target.name}' idle ${held}s, 0 queued - DONE`);
				return 0;
			}
		} else {
			if (idleSince !== null) log(`[${stamp()}] activity resumed - window reset`);
			idleSince = null;
			const detail = busyTabs.map((tab) => `${tab.name}[${tab.state}]`).join('; ');
			lastState = `${busyTabs.length} busy${detail ? ` (${detail})` : ''}, ${queueDepth} queued`;
			if (lastState !== lastPrinted) log(`[${stamp()}] ${lastState}`);
			lastPrinted = lastState;
		}

		await sleep(opts.interval * 1000);
	}
}

main().then(
	(code) => process.exit(code),
	(error) => {
		console.error(`FATAL: ${error?.stack || error}`);
		process.exit(2);
	}
);
