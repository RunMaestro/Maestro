/**
 * Desktop Stop and close-tab against REAL processes.
 *
 * The rest of the process-manager suite fakes the child and asserts which
 * signals were requested. This file asserts what those signals achieve: the
 * agent is gone, and so is the tool it was running. It exists because the
 * faked assertions passed for as long as the escalation they described never
 * fired (it keyed on `child.killed`, which Node sets when a signal is SENT).
 *
 * POSIX only; Windows ends a tree with a single `taskkill /t /f`.
 */
import * as os from 'os';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';

vi.mock('node-pty', () => ({
	spawn: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/tmp/maestro-test-coworking.sock',
}));

import { ProcessManager } from '../../../main/process-manager';

const SESSION_ID = 'agent-1-ai-tab-1';
const posixOnly = describe.skipIf(process.platform === 'win32');

// Each script starts a tool the way an agent's shell tool does and prints the
// tool's pid. The tool inherits stdout, so it holds the agent's pipe open.
const START_TOOL = `
	const tool = require('child_process').spawn('sleep', ['60'], { stdio: 'inherit' });
	setInterval(() => {}, 1000);
	console.log(String(tool.pid));
`;

const started: ChildProcess[] = [];
const strayPids: number[] = [];

interface RunningAgent {
	manager: ProcessManager;
	child: ChildProcess;
	managed: { interrupted?: boolean };
	toolPid: number;
	exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	close: Promise<void>;
}

/** Start a real agent stand-in and track it the way a spawned agent is tracked. */
async function runAgent(source: string): Promise<RunningAgent> {
	const child = spawn(process.execPath, ['-e', source], { stdio: ['pipe', 'pipe', 'pipe'] });
	started.push(child);

	const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once('exit', (code, signal) => resolve({ code, signal }));
	});
	const close = new Promise<void>((resolve) => {
		child.once('close', () => resolve());
	});
	const toolPid = await new Promise<number>((resolve, reject) => {
		let buffered = '';
		child.stdout!.setEncoding('utf8');
		child.stdout!.on('data', (chunk: string) => {
			buffered += chunk;
			const newline = buffered.indexOf('\n');
			if (newline !== -1) resolve(Number(buffered.slice(0, newline)));
		});
		child.once('error', reject);
	});
	strayPids.push(toolPid);

	const manager = new ProcessManager();
	const managed = {
		sessionId: SESSION_ID,
		toolType: 'opencode',
		childProcess: child,
		isTerminal: false,
		pid: child.pid!,
		cwd: os.tmpdir(),
		startTime: Date.now(),
	};
	(manager as unknown as { processes: Map<string, unknown> }).processes.set(SESSION_ID, managed);

	return { manager, child, managed, toolPid, exit, close };
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

posixOnly('ProcessManager stop against real processes', () => {
	it('Stop leaves no tool behind when the agent exits on the interrupt', async () => {
		// What OpenCode does: it dies on the signal and leaves its tool running.
		const agent = await runAgent(`process.on('SIGINT', () => process.exit(0)); ${START_TOOL}`);

		expect(agent.manager.interrupt(SESSION_ID)).toBe(true);

		expect(agent.managed.interrupted).toBe(true);
		expect(await agent.exit).toEqual({ code: 0, signal: null });
		expect(await waitUntilGone(agent.toolPid, 2000)).toBe(true);
		// Nothing holds the pipe any more, so the turn can settle.
		await agent.close;
	});

	it('Stop reaches an agent that ignores the interrupt', async () => {
		const agent = await runAgent(`process.on('SIGINT', () => {}); ${START_TOOL}`);

		agent.manager.interrupt(SESSION_ID);

		expect(await agent.exit).toEqual({ code: null, signal: 'SIGTERM' });
		expect(await waitUntilGone(agent.toolPid, 2000)).toBe(true);
		await agent.close;
	});

	it('closing the tab kills an agent that traps SIGTERM, and its tool', async () => {
		const agent = await runAgent(`process.on('SIGTERM', () => {}); ${START_TOOL}`);

		expect(agent.manager.kill(SESSION_ID)).toBe(true);
		expect(agent.manager.get(SESSION_ID)).toBeUndefined();

		expect(await agent.exit).toEqual({ code: null, signal: 'SIGKILL' });
		expect(await waitUntilGone(agent.toolPid, 2000)).toBe(true);
		await agent.close;
	});

	it('quitting the app leaves nothing running', async () => {
		const agent = await runAgent(
			`process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); ${START_TOOL}`
		);

		agent.manager.killAll({ shutdown: true });

		expect(await agent.exit).toEqual({ code: null, signal: 'SIGKILL' });
		expect(await waitUntilGone(agent.toolPid, 2000)).toBe(true);
	});
});
