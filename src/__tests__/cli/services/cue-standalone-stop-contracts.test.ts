// Source: src/__tests__/cli/services/cue-standalone-engine-stop.test.ts
// Source: src/__tests__/cli/services/cue-standalone-ssh-stop.test.ts
import * as os from 'os';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import type { CueEvent } from '../../../shared/cue/contracts';
import { buildStandaloneCueEngineDeps } from '../../../cli/services/cue-standalone-engine';
import { waitForStandaloneCueProcesses } from '../../../cli/services/cue-standalone-engine';
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { getActiveProcessMap } from '../../../main/cue/cue-process-lifecycle';
import { trackCueProcess } from '../../../main/cue/cue-process-lifecycle';
import type { CueActiveProcess } from '../../../main/cue/cue-process-lifecycle';
const remoteStopFixture = vi.hoisted(() => ({ active: false }));
const { mockSignalRemoteAgent } = vi.hoisted(() => ({ mockSignalRemoteAgent: vi.fn() }));
const executeCuePrompt = vi.hoisted(() => vi.fn());
vi.mock('../../../cli/services/storage', () => ({
	readSessions: () => [
		{
			id: 'agent-1',
			name: 'alpha',
			toolType: 'claude-code',
			cwd: remoteStopFixture.active ? '/p' : os.tmpdir(),
			projectRoot: remoteStopFixture.active ? '/p' : os.tmpdir(),
		},
	],
	readSshRemotes: () => [],
	getAgentCustomPath: () => undefined,
	readAgentConfig: () => ({}),
	readSettings: () => ({}),
}));
vi.mock('../../../cli/services/system-prompt', () => ({
	prepareMaestroSystemPromptCli: async () => undefined,
}));
vi.mock('../../../main/utils/ssh-remote-signal', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/utils/ssh-remote-signal')>()),
	signalRemoteAgent: mockSignalRemoteAgent,
}));
vi.mock('../../../shared/maestro-lib/parsers', () => ({ initializeOutputParsers: vi.fn() }));
vi.mock('../../../main/cue/cue-executor', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/cue/cue-executor')>()),
	executeCuePrompt,
}));
vi.mock('../../../main/cue/cue-cli-executor', () => ({ executeCueCli: vi.fn() }));
vi.mock('../../../main/cue/cue-notify-executor', () => ({ executeCueNotify: vi.fn() }));
vi.mock('../../../main/cue/cue-auth-detector', () => ({ detectCueAuthFailure: () => null }));
describe('cue-standalone-engine-stop', () => {
	const event: CueEvent = {
		id: 'evt-1',
		type: 'webhook.received',
		timestamp: new Date().toISOString(),
		triggerName: 'sleeper',
		payload: {},
	};

	function isAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	describe('stopping a standalone Cue run', () => {
		it("ends the run's process, and the wait returns only once it is gone", async () => {
			const deps = buildStandaloneCueEngineDeps({ onLog: vi.fn() });
			// The child prints its pid and then does nothing for a minute.
			const sleeper = `"${process.execPath}" -e "console.log(process.pid); setTimeout(() => {}, 60000)"`;
			const run = deps.onCueRun({
				runId: 'run-sleeper',
				sessionId: 'agent-1',
				prompt: sleeper,
				subscriptionName: 'sleeper',
				event,
				timeoutMs: 120_000,
				action: 'command',
				command: { mode: 'shell', shell: sleeper },
			} as Parameters<typeof deps.onCueRun>[0]);

			// The run is in flight once the registry holds its process.
			const { getCueProcessList } = await import('../../../main/cue/cue-executor');
			await vi.waitFor(
				() => expect(getCueProcessList().map((p) => p.runId)).toContain('run-sleeper'),
				{
					timeout: 10_000,
				}
			);
			const pid = getCueProcessList().find((p) => p.runId === 'run-sleeper')!.pid;
			expect(isAlive(pid)).toBe(true);

			expect(deps.onStopCueRun?.('run-sleeper')).toBe(true);
			expect(await waitForStandaloneCueProcesses()).toBe(0);

			expect(isAlive(pid)).toBe(false);
			// The run itself settles a moment later, once the child's output streams close.
			await run;
			expect(getCueProcessList().map((p) => p.runId)).not.toContain('run-sleeper');
		}, 30_000);
	});
});
describe('cue-standalone-ssh-stop', () => {
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

	beforeEach(() => {
		remoteStopFixture.active = true;
	});
	afterEach(() => {
		remoteStopFixture.active = false;
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
});
