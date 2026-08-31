/**
 * Tests for src/renderer/services/shellCommand.ts
 *
 * Command mode ("bang commands"): running a shell command from the AI composer
 * and streaming its output into the transcript without involving the agent.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	runShellCommand,
	dispatchShellCommand,
	cancelShellCommand,
	buildShellRunSessionId,
	SHELL_COMMAND_OUTPUT_LIMIT,
} from '../../../renderer/services/shellCommand';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';
import type { LogEntry } from '../../../renderer/types';

const SESSION_ID = 'session-1';
const TAB_ID = 'tab-1';

type Listener = (sessionId: string, arg: never) => void;

let dataListeners: Listener[] = [];
let stderrListeners: Listener[] = [];
let exitListeners: Listener[] = [];

const runCommand = vi.fn();
const cancelCommand = vi.fn();

function emitData(sessionId: string, text: string): void {
	dataListeners.forEach((l) => l(sessionId, text as never));
}
function emitStderr(sessionId: string, text: string): void {
	stderrListeners.forEach((l) => l(sessionId, text as never));
}
function emitExit(sessionId: string, code: number): void {
	exitListeners.forEach((l) => l(sessionId, code as never));
}

function getLogs(): LogEntry[] {
	const session = useSessionStore.getState().sessions.find((s) => s.id === SESSION_ID);
	return session?.aiTabs.find((t) => t.id === TAB_ID)?.logs ?? [];
}

function getCard(): LogEntry | undefined {
	return getLogs().find((l) => l.shellCommand);
}

beforeEach(() => {
	vi.clearAllMocks();
	dataListeners = [];
	stderrListeners = [];
	exitListeners = [];

	runCommand.mockResolvedValue({ exitCode: 0 });
	cancelCommand.mockResolvedValue(true);

	(window as unknown as { maestro: unknown }).maestro = {
		process: {
			runCommand,
			cancelCommand,
			onData: (cb: Listener) => {
				dataListeners.push(cb);
				return () => {
					dataListeners = dataListeners.filter((l) => l !== cb);
				};
			},
			onStderr: (cb: Listener) => {
				stderrListeners.push(cb);
				return () => {
					stderrListeners = stderrListeners.filter((l) => l !== cb);
				};
			},
			onCommandExit: (cb: Listener) => {
				exitListeners.push(cb);
				return () => {
					exitListeners = exitListeners.filter((l) => l !== cb);
				};
			},
		},
	};

	// Flush synchronously so assertions don't need to wait a frame.
	vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
		cb(0);
		return 1;
	});
	vi.stubGlobal('cancelAnimationFrame', () => {});

	useSessionStore.setState({
		sessions: [
			createMockSession({
				id: SESSION_ID,
				cwd: '/repo',
				activeTabId: TAB_ID,
				aiTabs: [createMockAITab({ id: TAB_ID, logs: [] })],
			}),
		],
		activeSessionId: SESSION_ID,
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('buildShellRunSessionId', () => {
	test('is distinguishable from every agent session id shape', () => {
		const id = buildShellRunSessionId('abc', 'run1');
		expect(id).toBe('abc-shell-run1');
		// Must not match the AI tab / terminal / batch routing patterns, or the
		// agent listeners would swallow the output.
		expect(id).not.toMatch(/-ai-/);
		expect(id.endsWith('-terminal')).toBe(false);
		expect(id).not.toContain('-batch-');
	});
});

describe('runShellCommand', () => {
	test('runs in the session cwd with a synthetic session id', async () => {
		const promise = runShellCommand({
			session: useSessionStore.getState().sessions[0],
			tabId: TAB_ID,
			command: 'git status',
		});

		expect(runCommand).toHaveBeenCalledTimes(1);
		const config = runCommand.mock.calls[0][0];
		expect(config.command).toBe('git status');
		expect(config.cwd).toBe('/repo');
		expect(config.sessionId).toMatch(/^session-1-shell-/);
		expect(config.sessionId).not.toBe(SESSION_ID);

		emitExit(config.sessionId, 0);
		await promise;
	});

	test('appends a running card immediately, then streams output into it', async () => {
		const promise = runShellCommand({
			session: useSessionStore.getState().sessions[0],
			tabId: TAB_ID,
			command: 'ls',
		});

		const runSessionId = runCommand.mock.calls[0][0].sessionId;
		expect(getCard()?.shellCommand?.status).toBe('running');

		emitData(runSessionId, 'file-a\n');
		emitData(runSessionId, 'file-b\n');
		expect(getCard()?.text).toBe('file-a\nfile-b\n');

		emitExit(runSessionId, 0);
		await promise;

		expect(getCard()?.shellCommand?.status).toBe('finished');
		expect(getCard()?.shellCommand?.exitCode).toBe(0);
		expect(getCard()?.shellCommand?.durationMs).toBeTypeOf('number');
	});

	test('captures stderr into the same card', async () => {
		const promise = runShellCommand({
			session: useSessionStore.getState().sessions[0],
			tabId: TAB_ID,
			command: 'bad-command',
		});
		const runSessionId = runCommand.mock.calls[0][0].sessionId;

		emitStderr(runSessionId, 'command not found\n');
		emitExit(runSessionId, 127);
		await promise;

		expect(getCard()?.text).toContain('command not found');
		expect(getCard()?.shellCommand?.exitCode).toBe(127);
	});

	test('ignores output from other runs', async () => {
		const promise = runShellCommand({
			session: useSessionStore.getState().sessions[0],
			tabId: TAB_ID,
			command: 'ls',
		});
		const runSessionId = runCommand.mock.calls[0][0].sessionId;

		emitData(SESSION_ID, 'agent output');
		emitData('session-1-shell-someone-else', 'other command output');
		expect(getCard()?.text).toBe('');

		emitExit(runSessionId, 0);
		await promise;
	});

	test('never adds a user message entry - the card carries the command', async () => {
		const promise = runShellCommand({
			session: useSessionStore.getState().sessions[0],
			tabId: TAB_ID,
			command: 'ls',
		});
		emitExit(runCommand.mock.calls[0][0].sessionId, 0);
		await promise;

		expect(getLogs().filter((l) => l.source === 'user')).toHaveLength(0);
		expect(getLogs()).toHaveLength(1);
		expect(getCard()?.shellCommand?.command).toBe('ls');
	});

	test('truncates output past the cap and flags the card', async () => {
		const promise = runShellCommand({
			session: useSessionStore.getState().sessions[0],
			tabId: TAB_ID,
			command: 'yes',
		});
		const runSessionId = runCommand.mock.calls[0][0].sessionId;

		emitData(runSessionId, 'x'.repeat(SHELL_COMMAND_OUTPUT_LIMIT + 5_000));
		emitData(runSessionId, 'more');
		emitExit(runSessionId, 0);
		await promise;

		expect(getCard()?.text.length).toBe(SHELL_COMMAND_OUTPUT_LIMIT);
		expect(getCard()?.shellCommand?.truncated).toBe(true);
	});

	test('routes to the SSH remote when the agent is remote', async () => {
		useSessionStore.setState({
			sessions: [
				createMockSession({
					id: SESSION_ID,
					cwd: '/local/path',
					activeTabId: TAB_ID,
					aiTabs: [createMockAITab({ id: TAB_ID, logs: [] })],
					sshRemote: { id: 'r1', name: 'builder', host: 'build.local' },
					sessionSshRemoteConfig: {
						enabled: true,
						remoteId: 'r1',
						workingDirOverride: '/remote/path',
					},
				}),
			],
			activeSessionId: SESSION_ID,
		});

		const promise = runShellCommand({
			session: useSessionStore.getState().sessions[0],
			tabId: TAB_ID,
			command: 'uname -a',
		});

		const config = runCommand.mock.calls[0][0];
		expect(config.cwd).toBe('/remote/path');
		expect(config.sessionSshRemoteConfig).toEqual({
			enabled: true,
			remoteId: 'r1',
			workingDirOverride: '/remote/path',
		});
		expect(getCard()?.shellCommand?.remoteName).toBe('builder');

		emitExit(config.sessionId, 0);
		await promise;
	});

	test('surfaces a spawn failure in the card instead of throwing', async () => {
		runCommand.mockRejectedValueOnce(new Error('boom'));

		await runShellCommand({
			session: useSessionStore.getState().sessions[0],
			tabId: TAB_ID,
			command: 'ls',
		});

		expect(getCard()?.text).toContain('boom');
		expect(getCard()?.shellCommand?.status).toBe('finished');
		expect(getCard()?.shellCommand?.exitCode).toBe(1);
	});
});

describe('cancelShellCommand', () => {
	test('kills the run and marks the card stopped', async () => {
		const promise = runShellCommand({
			session: useSessionStore.getState().sessions[0],
			tabId: TAB_ID,
			command: 'tail -f log',
		});
		const runSessionId = runCommand.mock.calls[0][0].sessionId;
		const logId = getCard()!.id;

		await cancelShellCommand(logId);
		expect(cancelCommand).toHaveBeenCalledWith(runSessionId);

		// The kill makes the process exit; that's what settles the card.
		emitExit(runSessionId, 143);
		await promise;

		expect(getCard()?.shellCommand?.status).toBe('cancelled');
	});

	test('is a no-op for a run that already finished', async () => {
		const promise = runShellCommand({
			session: useSessionStore.getState().sessions[0],
			tabId: TAB_ID,
			command: 'ls',
		});
		const runSessionId = runCommand.mock.calls[0][0].sessionId;
		const logId = getCard()!.id;
		emitExit(runSessionId, 0);
		await promise;

		await expect(cancelShellCommand(logId)).resolves.toBe(false);
		expect(cancelCommand).not.toHaveBeenCalled();
	});
});

describe('the generating request', () => {
	test('is stamped on the card when the command came from AI command mode', async () => {
		await runShellCommand({
			session: useSessionStore.getState().sessions[0],
			tabId: TAB_ID,
			command: "find . -newermt '2 days ago' -type f",
			request: 'what files were edited in the past two days',
		});

		expect(getCard()?.shellCommand?.request).toBe('what files were edited in the past two days');
	});

	test('is absent for a typed command, so its presence means "generated"', async () => {
		await runShellCommand({
			session: useSessionStore.getState().sessions[0],
			tabId: TAB_ID,
			command: 'git status',
		});

		expect(getCard()?.shellCommand).not.toHaveProperty('request');
	});

	test('survives dispatchShellCommand rather than being dropped in the handoff', async () => {
		await dispatchShellCommand({
			session: useSessionStore.getState().sessions[0],
			tabId: TAB_ID,
			command: 'du -sh *',
			request: 'how big is everything here',
		});

		expect(getCard()?.shellCommand?.request).toBe('how big is everything here');
	});
});

describe('dispatchShellCommand', () => {
	function history(): string[] {
		return (
			useSessionStore.getState().sessions.find((s) => s.id === SESSION_ID)?.aiCommandHistory ?? []
		);
	}

	test('records the command bang-prefixed so recall can tell it from a message', async () => {
		// aiCommandHistory mixes agent messages and shell commands; the `!` is the
		// only thing that distinguishes them on the way back out.
		await dispatchShellCommand({
			session: useSessionStore.getState().sessions[0],
			tabId: TAB_ID,
			command: 'npm test',
		});

		expect(history()).toContain('!npm test');
	});

	test('runs the command as well as recording it', async () => {
		await dispatchShellCommand({
			session: useSessionStore.getState().sessions[0],
			tabId: TAB_ID,
			command: 'git status',
		});

		expect(runCommand).toHaveBeenCalledTimes(1);
		expect(getCard()?.shellCommand?.command).toBe('git status');
	});

	test('moves a repeated command to the end instead of duplicating it', async () => {
		const session = () => useSessionStore.getState().sessions[0];
		await dispatchShellCommand({ session: session(), tabId: TAB_ID, command: 'ls' });
		await dispatchShellCommand({ session: session(), tabId: TAB_ID, command: 'pwd' });
		await dispatchShellCommand({ session: session(), tabId: TAB_ID, command: 'ls' });

		expect(history()).toEqual(['!pwd', '!ls']);
	});
});
