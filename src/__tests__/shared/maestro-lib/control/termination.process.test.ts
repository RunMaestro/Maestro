/**
 * The stop ladder against REAL processes.
 *
 * `termination.test.ts` pins the ladder's decisions with fakes. This file
 * proves the decisions do what they claim on a real process table: a signal an
 * agent traps really is followed by the next stage, and a tool the agent left
 * running really is gone afterwards. Nothing is mocked.
 *
 * POSIX only. Windows ends a tree with `taskkill /t /f`, which has no stages
 * to observe; its branches are covered in `termination.test.ts`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';

import { stopProcess } from '../../../../shared/maestro-lib/control/termination';

const GRACE_MS = 200;
const posixOnly = describe.skipIf(process.platform === 'win32');

/** An agent stand-in: a node process running `source`, ready once it prints. */
interface FakeAgent {
	child: ChildProcess;
	/** Resolves with the first stdout line, which each script prints when ready. */
	ready: Promise<string>;
	exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	close: Promise<void>;
}

const started: ChildProcess[] = [];
const strayPids: number[] = [];

function startAgent(source: string): FakeAgent {
	const child = spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'] });
	started.push(child);

	const ready = new Promise<string>((resolve, reject) => {
		let buffered = '';
		child.stdout!.setEncoding('utf8');
		child.stdout!.on('data', (chunk: string) => {
			buffered += chunk;
			const newline = buffered.indexOf('\n');
			if (newline !== -1) resolve(buffered.slice(0, newline));
		});
		child.once('error', reject);
	});
	const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once('exit', (code, signal) => resolve({ code, signal }));
	});
	const close = new Promise<void>((resolve) => {
		child.once('close', () => resolve());
	});
	return { child, ready, exit, close };
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !isAlive(pid);
}

// Holds the event loop open and announces readiness.
const STAY_ALIVE = `setInterval(() => {}, 1000); console.log('ready');`;

// Starts a tool the way an agent's shell tool does, then reports its pid. The
// tool inherits stdout, so it holds the agent's pipe open after the agent dies.
const START_TOOL = `
	const tool = require('child_process').spawn('sleep', ['60'], { stdio: 'inherit' });
	setInterval(() => {}, 1000);
	console.log(String(tool.pid));
`;

afterEach(() => {
	for (const child of started.splice(0)) {
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
	}
	for (const pid of strayPids.splice(0)) {
		try {
			process.kill(pid, 'SIGKILL');
		} catch {
			// already gone
		}
	}
});

posixOnly('stopProcess against real processes', () => {
	it('lets an agent that honours the interrupt end its own turn', async () => {
		const agent = startAgent(`process.on('SIGINT', () => process.exit(0)); ${STAY_ALIVE}`);
		await agent.ready;

		const handle = stopProcess({ child: agent.child }, { from: 'interrupt', graceMs: GRACE_MS });

		expect(await agent.exit).toEqual({ code: 0, signal: null });
		expect(handle.stage()).toBe('interrupt');
	});

	it('terminates an agent that ignores the interrupt', async () => {
		const agent = startAgent(`process.on('SIGINT', () => {}); ${STAY_ALIVE}`);
		await agent.ready;

		const handle = stopProcess({ child: agent.child }, { from: 'interrupt', graceMs: GRACE_MS });

		expect(await agent.exit).toEqual({ code: null, signal: 'SIGTERM' });
		expect(handle.stage()).toBe('terminate');
	});

	it('kills an agent that ignores both the interrupt and the terminate', async () => {
		const agent = startAgent(
			`process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); ${STAY_ALIVE}`
		);
		await agent.ready;

		const handle = stopProcess({ child: agent.child }, { from: 'interrupt', graceMs: GRACE_MS });

		expect(await agent.exit).toEqual({ code: null, signal: 'SIGKILL' });
		expect(handle.stage()).toBe('kill');
	});

	it('runs every stage at once on the shutdown path', async () => {
		const agent = startAgent(
			`process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); ${STAY_ALIVE}`
		);
		await agent.ready;

		const before = Date.now();
		stopProcess({ child: agent.child }, { from: 'terminate', graceMs: 60_000, immediate: true });

		expect(await agent.exit).toEqual({ code: null, signal: 'SIGKILL' });
		expect(Date.now() - before).toBeLessThan(2000);
	});

	it('stops the tool an agent left running when it exited', async () => {
		const agent = startAgent(`process.on('SIGTERM', () => process.exit(0)); ${START_TOOL}`);
		const toolPid = Number(await agent.ready);
		strayPids.push(toolPid);
		expect(isAlive(toolPid)).toBe(true);

		stopProcess({ child: agent.child }, { from: 'terminate', graceMs: GRACE_MS });

		// The agent exits cleanly on SIGTERM and takes nothing with it.
		expect(await agent.exit).toEqual({ code: 0, signal: null });
		expect(await waitUntilGone(toolPid, 2000)).toBe(true);
		// With the tool gone nothing holds the pipe, so the turn can settle.
		await agent.close;
	});

	it('stops the tool along with an agent that had to be killed', async () => {
		const agent = startAgent(
			`process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); ${START_TOOL}`
		);
		const toolPid = Number(await agent.ready);
		strayPids.push(toolPid);

		stopProcess({ child: agent.child }, { from: 'interrupt', graceMs: GRACE_MS });

		expect(await agent.exit).toEqual({ code: null, signal: 'SIGKILL' });
		expect(await waitUntilGone(toolPid, 2000)).toBe(true);
		await agent.close;
	});

	it('leaves what the process started alone when asked to', async () => {
		const agent = startAgent(`process.on('SIGTERM', () => process.exit(0)); ${START_TOOL}`);
		const toolPid = Number(await agent.ready);
		strayPids.push(toolPid);

		stopProcess(
			{ child: agent.child },
			{ from: 'terminate', graceMs: GRACE_MS, includeDescendants: false }
		);

		await agent.exit;
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(isAlive(toolPid)).toBe(true);
	});

	it('does nothing to a process that has already exited', async () => {
		const agent = startAgent(`console.log('ready');`);
		await agent.ready;
		await agent.exit;

		let requested = false;
		const handle = stopProcess(
			{ child: agent.child },
			{ from: 'interrupt', graceMs: GRACE_MS, onStopRequested: () => (requested = true) }
		);

		expect(requested).toBe(true);
		expect(handle.stage()).toBeUndefined();
	});
});
