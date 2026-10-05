import { describe, expect, it, vi } from 'vitest';

import type { CueEngineLockInfo } from '../../../main/cue/cue-engine-lock';
import { startHostCue, type HostCueDeps, type HostCueEngine } from '../../../cli/services/host-cue';

const PATHS = { userDataDir: '/data', settingsFile: '/data/maestro-settings.json' };
const PID = 4242;

function lock(pid: number, mode: CueEngineLockInfo['mode'] = 'standalone'): CueEngineLockInfo {
	return { pid, mode, startedAt: '2026-10-04T12:00:00.000Z' };
}

function fakeEngine(overrides: Partial<HostCueEngine> = {}): HostCueEngine {
	return {
		start: vi.fn(),
		stop: vi.fn(),
		triggerSubscription: vi.fn(() => true),
		...overrides,
	};
}

/** Deps where the engine's start takes the lock, as the real one does. */
function deps(overrides: Partial<HostCueDeps> & { engine?: HostCueEngine } = {}) {
	let held: CueEngineLockInfo | null = null;
	const engine =
		overrides.engine ??
		fakeEngine({
			start: vi.fn(() => {
				held = lock(PID);
			}),
		});
	const stopInbox = vi.fn();
	const all: HostCueDeps = {
		isEnabled: async () => true,
		readLock: () => held,
		createEngine: async () => engine,
		startInbox: vi.fn(() => stopInbox),
		pid: PID,
		...overrides,
	};
	return { all, engine, stopInbox };
}

describe('startHostCue', () => {
	it('starts no engine when Cue is off', async () => {
		const { all, engine } = deps({ isEnabled: async () => false });
		const cue = await startHostCue(PATHS, all);
		expect(cue.state()).toEqual({ state: 'disabled' });
		expect(engine.start).not.toHaveBeenCalled();
	});

	it('leaves Cue to whoever holds the lock, and says who', async () => {
		const { all, engine } = deps({ readLock: () => lock(77, 'desktop') });
		const cue = await startHostCue(PATHS, all);
		expect(cue.state()).toEqual({ state: 'held', mode: 'desktop', pid: 77 });
		expect(engine.start).not.toHaveBeenCalled();
	});

	it('runs the engine, serves the trigger inbox, and stops both', async () => {
		const { all, engine, stopInbox } = deps();
		const cue = await startHostCue(PATHS, all);
		expect(engine.start).toHaveBeenCalledWith('system-boot');
		expect(cue.state()).toEqual({ state: 'running' });
		expect(all.startInbox).toHaveBeenCalledWith(engine, '/data');

		cue.stop();
		cue.stop();
		expect(engine.stop).toHaveBeenCalledTimes(1);
		expect(stopInbox).toHaveBeenCalledTimes(1);
		expect(cue.state()).toEqual({ state: 'disabled' });
	});

	it('reports the winner when another engine took the lock first', async () => {
		let reads = 0;
		const { all, engine } = deps({
			engine: fakeEngine(),
			readLock: () => (++reads === 1 ? null : lock(88)),
		});
		const cue = await startHostCue(PATHS, all);
		expect(cue.state()).toEqual({ state: 'held', mode: 'standalone', pid: 88 });
		expect(engine.stop).toHaveBeenCalled();
		expect(all.startInbox).not.toHaveBeenCalled();
	});

	it('reports a start that took no lock as a failure', async () => {
		const { all } = deps({ engine: fakeEngine(), readLock: () => null });
		const cue = await startHostCue(PATHS, all);
		expect(cue.state()).toMatchObject({ state: 'failed' });
	});

	it('never throws: a broken engine is the reported state', async () => {
		const { all } = deps({
			createEngine: async () => {
				throw new Error('no sqlite');
			},
		});
		const cue = await startHostCue(PATHS, all);
		expect(cue.state()).toEqual({ state: 'failed', reason: 'no sqlite' });
	});
});
