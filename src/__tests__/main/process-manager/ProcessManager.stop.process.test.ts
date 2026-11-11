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
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
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
import type { ManagedProcess } from '../../../main/process-manager/types';
import { ChildProcessSpawner } from '../../../main/process-manager/spawners/ChildProcessSpawner';
import * as termination from '../../../shared/maestro-lib/control/termination';
import * as remoteSignal from '../../../main/utils/ssh-remote-signal';
import { opencodeServerManager } from '../../../main/opencode-server/OpencodeServerManager';
import { logger } from '../../../main/utils/logger';

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

	it('quitting the app sends SIGTERM and lets the agent finish writing its state', async () => {
		// An agent saves its session when it is told to terminate. Quitting must
		// give it the time to: a SIGKILL right behind the SIGTERM would not.
		const stateFile = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-quit-')),
			'state.json'
		);
		const agent = await runAgent(`
			process.on('SIGTERM', () => {
				setTimeout(() => {
					require('fs').writeFileSync(${JSON.stringify(stateFile)}, '{"saved":true}');
					process.exit(0);
				}, 300);
			});
			${START_TOOL}
		`);

		agent.manager.killAll({ shutdown: true });

		expect(agent.manager.get(SESSION_ID)).toBeUndefined();
		expect(await agent.exit).toEqual({ code: 0, signal: null });
		expect(fs.readFileSync(stateFile, 'utf8')).toBe('{"saved":true}');
		fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
	});
});

// Synthetic ownership checks do not invoke the real-process fixtures above.
describe('ProcessManager synthetic SSH prompt artifact stops', () => {
	let manager: ProcessManager;
	let child: ChildProcess;
	let managed: ManagedProcess;
	let processes: Map<string, ManagedProcess>;
	const owner = '/tmp/maestro-prompt-owner-11111111-1111-4111-8111-111111111111.pid';
	const artifactPath = '/tmp/maestro-prompt-11111111-1111-4111-8111-111111111111.json';

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(termination, 'stopProcess').mockReturnValue({
			stage: () => undefined,
			dispose: vi.fn(),
		});
		vi.spyOn(remoteSignal, 'signalRemoteAgent').mockReturnValue(true);
		vi.spyOn(opencodeServerManager, 'shutdown').mockImplementation(() => {});
		vi.mocked(logger.warn).mockClear();
		manager = new ProcessManager(() => false, { isCoworkingEnabled: () => false });
		child = Object.assign(new EventEmitter(), {
			pid: 4242,
			exitCode: null,
			signalCode: null,
			kill: vi.fn(),
		}) as unknown as ChildProcess;
		managed = {
			sessionId: SESSION_ID,
			toolType: 'grok',
			childProcess: child,
			cwd: os.tmpdir(),
			pid: 4242,
			isTerminal: false,
			startTime: Date.now(),
			command: '/synthetic/bin/ssh',
			args: ['-p', '2222', 'user@fixture.invalid', '/bin/bash', '--norc', '--noprofile', '-s'],
			sshRemotePidFile: owner,
			sshRemotePromptArtifactPath: artifactPath,
		};
		processes = (manager as unknown as { processes: Map<string, ManagedProcess> }).processes;
		processes.set(SESSION_ID, managed);
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it.each(['interrupt', 'kill', 'shutdown'] as const)(
		'%s forwards the exact remote owner and private cleanup path',
		(action) => {
			if (action === 'shutdown') manager.killAll({ shutdown: true });
			else expect(manager[action](SESSION_ID)).toBe(true);
			expect(remoteSignal.signalRemoteAgent).toHaveBeenCalledExactlyOnceWith(
				{
					sshCommand: managed.command,
					sshArgs: managed.args,
					pidFile: owner,
					sessionId: SESSION_ID,
					promptArtifactPath: artifactPath,
				},
				action === 'interrupt' ? 'interrupt' : 'terminate'
			);
			expect(termination.stopProcess).toHaveBeenCalledOnce();
			expect(termination.stopProcess).toHaveBeenCalledWith(
				{ child },
				expect.objectContaining({
					from: action === 'interrupt' ? 'interrupt' : 'terminate',
					sessionId: SESSION_ID,
					...(action === 'shutdown' ? { immediate: true, blocking: true, upTo: 'terminate' } : {}),
				})
			);
			expect(managed.interrupted).toBe(true);
			expect(manager.getAll()).toEqual(action === 'interrupt' ? [managed] : []);
			expect(child.kill).not.toHaveBeenCalled();
		}
	);

	it.each(['exit', 'close'] as const)(
		'retains the old artifact owner after local SSH %s and replacement',
		(event) => {
			manager.interrupt(SESSION_ID);
			child.exitCode = 0;
			child.emit(event, 0, null);
			const replacement = {
				...managed,
				pid: 5353,
				sshRemotePidFile: '/tmp/new-owner.pid',
				sshRemotePromptArtifactPath: '/tmp/new-prompt.json',
			};
			processes.set(SESSION_ID, replacement);
			vi.advanceTimersByTime(termination.INTERACTIVE_STOP_GRACE_MS - 1);
			expect(remoteSignal.signalRemoteAgent).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(1);
			expect(remoteSignal.signalRemoteAgent).toHaveBeenNthCalledWith(
				2,
				{
					sshCommand: managed.command,
					sshArgs: managed.args,
					pidFile: owner,
					sessionId: SESSION_ID,
					promptArtifactPath: artifactPath,
				},
				'terminate'
			);
			expect(manager.get(SESSION_ID)).toBe(replacement);
			expect(remoteSignal.signalRemoteAgent).toHaveBeenCalledTimes(2);
		}
	);

	it('terminates the stale remote artifact owner before registering a successor', () => {
		vi.spyOn(process, 'kill').mockImplementation(() => {
			throw Object.assign(new Error('Synthetic missing PID'), { code: 'ESRCH' });
		});
		const replacement = { ...managed, pid: 5353, sshRemotePidFile: '/tmp/new-owner.pid' };
		const spawn = vi.spyOn(ChildProcessSpawner.prototype, 'spawn').mockImplementation(() => {
			expect(remoteSignal.signalRemoteAgent).toHaveBeenCalledExactlyOnceWith(
				{
					sshCommand: managed.command,
					sshArgs: managed.args,
					pidFile: owner,
					sessionId: SESSION_ID,
					promptArtifactPath: artifactPath,
				},
				'terminate'
			);
			expect(processes.has(SESSION_ID)).toBe(false);
			processes.set(SESSION_ID, replacement);
			return { pid: replacement.pid, success: true };
		});
		expect(
			manager.spawn({
				sessionId: SESSION_ID,
				toolType: 'grok',
				cwd: os.tmpdir(),
				command: 'grok',
				args: [],
				prompt: 'Synthetic next turn',
			})
		).toEqual({ pid: 5353, success: true });
		expect(spawn).toHaveBeenCalledOnce();
		expect(manager.getAll()).toEqual([replacement]);
		expect(termination.stopProcess).not.toHaveBeenCalled();
	});

	it.each(['interrupt', 'kill', 'shutdown'] as const)(
		'%s refuses a prompt owner without its private artifact witness',
		(action) => {
			delete managed.sshRemotePromptArtifactPath;
			if (action === 'shutdown') manager.killAll({ shutdown: true });
			else manager[action](SESSION_ID);
			vi.advanceTimersByTime(termination.INTERACTIVE_STOP_GRACE_MS);
			expect(remoteSignal.signalRemoteAgent).not.toHaveBeenCalled();
			expect(logger.warn).toHaveBeenCalledWith(
				'Remote signal ownership is unavailable',
				'ProcessManager',
				{ sessionId: SESSION_ID, mode: 'terminate' }
			);
			expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(owner);
			expect(termination.stopProcess).toHaveBeenCalledOnce();
		}
	);

	it.each(['exit', 'close'] as const)(
		'preserves ordinary SSH observed-%s cancellation without artifact metadata',
		(event) => {
			managed.toolType = 'claude-code';
			delete managed.sshRemotePromptArtifactPath;
			managed.sshRemotePidFile = '/tmp/maestro-agent-11111111-1111-4111-8111-111111111111.pid';
			manager.interrupt(SESSION_ID);
			child.exitCode = 0;
			child.emit(event, 0, null);
			vi.advanceTimersByTime(termination.INTERACTIVE_STOP_GRACE_MS);
			expect(remoteSignal.signalRemoteAgent).toHaveBeenCalledExactlyOnceWith(
				{
					sshCommand: managed.command,
					sshArgs: managed.args,
					pidFile: managed.sshRemotePidFile,
					sessionId: SESSION_ID,
				},
				'interrupt'
			);
		}
	);

	it('keeps local provider interruption on the local stop owner', () => {
		managed.toolType = 'codex';
		delete managed.sshRemotePidFile;
		delete managed.sshRemotePromptArtifactPath;
		expect(manager.interrupt(SESSION_ID)).toBe(true);
		vi.advanceTimersByTime(termination.INTERACTIVE_STOP_GRACE_MS);
		expect(remoteSignal.signalRemoteAgent).not.toHaveBeenCalled();
		expect(termination.stopProcess).toHaveBeenCalledExactlyOnceWith(
			{ child },
			{
				from: 'interrupt',
				graceMs: termination.INTERACTIVE_STOP_GRACE_MS,
				sessionId: SESSION_ID,
				label: 'interrupt',
			}
		);
	});
});
