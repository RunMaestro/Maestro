/**
 * Stopping a Cue run and waiting for its process, with nothing faked between the standalone
 * engine's dependencies and the operating system.
 *
 * The run is an `action: command` shell run, so the real executors, the real process registry, and
 * the real stop ladder are all in play and no provider is involved: the child is `node` sleeping.
 * What a host needs from this is that after `onStopCueRun` and the wait, the process is gone,
 * because a host that exits before then leaves it running under pid 1.
 */

import * as os from 'os';
import { describe, expect, it, vi } from 'vitest';
import type { CueEvent } from '../../../shared/cue/contracts';

vi.mock('../../../cli/services/storage', () => ({
	readSessions: () => [
		{
			id: 'agent-1',
			name: 'alpha',
			toolType: 'claude-code',
			cwd: os.tmpdir(),
			projectRoot: os.tmpdir(),
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

import {
	buildStandaloneCueEngineDeps,
	waitForStandaloneCueProcesses,
} from '../../../cli/services/cue-standalone-engine';

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
