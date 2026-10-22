/**
 * The standalone runner stops an SSH Cue run on its remote host, the same way
 * the desktop does. Killing the local ssh client alone leaves the remote agent
 * working, so Stop and the drain's forced kill must reach the host through the
 * pid record the launch script wrote (see ssh-remote-signal.ts).
 *
 * The runner's deps are driven for real down to cue-process-lifecycle; only the
 * one-shot signal ssh and the run itself are stand-ins.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import type { CueEvent } from '../../../shared/cue/contracts';

const { mockSignalRemoteAgent } = vi.hoisted(() => ({ mockSignalRemoteAgent: vi.fn() }));
vi.mock('../../../main/utils/ssh-remote-signal', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/utils/ssh-remote-signal')>()),
	signalRemoteAgent: mockSignalRemoteAgent,
}));

const executeCuePrompt = vi.fn();
vi.mock('../../../shared/maestro-lib/parsers', () => ({ initializeOutputParsers: vi.fn() }));
vi.mock('../../../main/cue/cue-executor', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/cue/cue-executor')>()),
	executeCuePrompt,
}));
vi.mock('../../../main/cue/cue-shell-executor', () => ({ executeCueShell: vi.fn() }));
vi.mock('../../../cli/services/system-prompt', () => ({
	prepareMaestroSystemPromptCli: async () => undefined,
}));
vi.mock('../../../main/cue/cue-cli-executor', () => ({ executeCueCli: vi.fn() }));
vi.mock('../../../main/cue/cue-notify-executor', () => ({ executeCueNotify: vi.fn() }));
vi.mock('../../../main/cue/cue-auth-detector', () => ({ detectCueAuthFailure: () => null }));
vi.mock('../../../cli/services/storage', () => ({
	readSessions: () => [
		{ id: 'agent-1', name: 'alpha', toolType: 'claude-code', cwd: '/p', projectRoot: '/p' },
	],
	readSshRemotes: () => [],
	getAgentCustomPath: () => undefined,
	readAgentConfig: () => ({}),
	readSettings: () => ({}),
}));

import { buildStandaloneCueEngineDeps } from '../../../cli/services/cue-standalone-engine';
import {
	getActiveProcessMap,
	trackCueProcess,
	type CueActiveProcess,
} from '../../../main/cue/cue-process-lifecycle';

const event: CueEvent = {
	id: 'evt-1',
	type: 'time.heartbeat',
	timestamp: new Date().toISOString(),
	triggerName: 'tick',
	payload: {},
};

const sshArgs = ['u@h', '/bin/bash', '--norc', '--noprofile', '-s'];

/** A tracked SSH run as `runProcess` registers it, with a pid record. */
function trackSshRun(runId: string): string {
	const child = Object.assign(new EventEmitter(), {
		pid: 4242,
		killed: false,
		exitCode: null,
		kill: vi.fn(() => true),
	}) as unknown as ChildProcess;
	const pidFile = `/tmp/maestro-agent-${runId}.pid`;
	const entry: CueActiveProcess = {
		child,
		command: '/usr/bin/ssh',
		args: sshArgs,
		cwd: '/home/u',
		toolType: 'claude-code',
		startTime: Date.now(),
		sshRemotePidFile: pidFile,
		getStdout: () => '',
		getStderr: () => '',
	};
	trackCueProcess(runId, entry);
	return pidFile;
}

/** Fire one run so the runner loads its executors, as the first event does. */
async function loadRunnerExecutors(deps: ReturnType<typeof buildStandaloneCueEngineDeps>) {
	executeCuePrompt.mockResolvedValue({ runId: 'warmup', status: 'completed' });
	await deps.onCueRun({
		runId: 'warmup',
		sessionId: 'agent-1',
		prompt: 'warm up',
		subscriptionName: 'tick',
		event,
		timeoutMs: 1000,
	} as Parameters<typeof deps.onCueRun>[0]);
}

afterEach(() => {
	getActiveProcessMap().clear();
	vi.clearAllMocks();
});

describe('standalone runner: SSH Cue runs stop on their remote host', () => {
	it('Stop signals the remote agent, not only the local ssh client', async () => {
		const deps = buildStandaloneCueEngineDeps({ onLog: vi.fn() });
		await loadRunnerExecutors(deps);
		const pidFile = trackSshRun('run-ssh');

		expect(deps.onStopCueRun?.('run-ssh')).toBe(true);
		expect(mockSignalRemoteAgent).toHaveBeenCalledWith(
			{ sshCommand: '/usr/bin/ssh', sshArgs, pidFile, sessionId: 'run-ssh' },
			'terminate'
		);
	});

	it("the drain's forced kill signals every remote agent still running", async () => {
		const deps = buildStandaloneCueEngineDeps({ onLog: vi.fn() });
		await loadRunnerExecutors(deps);
		const pidFile = trackSshRun('run-ssh-shutdown');

		deps.killAllCueProcessesNow?.();
		expect(mockSignalRemoteAgent).toHaveBeenCalledWith(
			{ sshCommand: '/usr/bin/ssh', sshArgs, pidFile, sessionId: 'run-ssh-shutdown' },
			'terminate'
		);
		expect(getActiveProcessMap().size).toBe(0);
	});
});
