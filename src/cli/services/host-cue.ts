/**
 * Cue inside a detached host (spec D3 and Q5).
 *
 * `maestro-cli host` is the long-lived process, so it is where Cue runs when nothing else runs it.
 * It is not a second engine: it composes the standalone one (`cue-standalone-engine.ts`) behind the
 * same cross-process Cue lock the desktop and `maestro-cli cue engine start` use. The rule, in
 * order: Cue off in the shared Encore settings means no engine; a live holder of the lock means no
 * engine here either, and `status` says whose; otherwise start one and check that the lock is ours,
 * because `CueEngine.start()` refuses silently when it loses the race.
 */

import { readCueEngineLock, type CueEngineLockInfo } from '../../main/cue/cue-engine-lock';
import { resolveEncoreFeatures } from '../../shared/encoreFeatureDefaults';
import type { HostCueState } from '../../shared/maestro-lib/client/host-control';
import { readStoreDocument } from '../../shared/maestro-lib/store/io';
import { createStandaloneCueEngine } from './cue-standalone-engine';
import { startCueTriggerInbox } from './cue-trigger-inbox';

/** The part of `CueEngine` the host drives. */
export interface HostCueEngine {
	start(reason: 'system-boot'): void;
	stop(): void;
	triggerSubscription(name: string, prompt?: string, sourceAgentId?: string): boolean;
}

export interface HostCueDeps {
	/** Is Cue on in the shared settings? Default: the Encore flags in `settingsFile`, resolved over the shared defaults. */
	isEnabled(settingsFile: string): Promise<boolean>;
	readLock(dataDir: string): CueEngineLockInfo | null;
	createEngine(): Promise<HostCueEngine>;
	/** Serve `maestro-cli cue trigger`, which has no desktop WebSocket to reach this process by. Returns the stop. */
	startInbox(engine: HostCueEngine, dataDir: string): () => void;
	pid: number;
}

export interface HostCue {
	state(): HostCueState;
	stop(): void;
}

async function encoreCueEnabled(settingsFile: string): Promise<boolean> {
	const read = await readStoreDocument<Record<string, unknown>>(settingsFile);
	const document = read.status === 'ok' ? read.data : {};
	return resolveEncoreFeatures(document.encoreFeatures).maestroCue;
}

const defaultDeps: HostCueDeps = {
	isEnabled: encoreCueEnabled,
	readLock: (dataDir) => readCueEngineLock(dataDir),
	createEngine: () => createStandaloneCueEngine() as Promise<HostCueEngine>,
	startInbox: (engine, dataDir) =>
		startCueTriggerInbox(
			(name, prompt, sourceAgentId) => engine.triggerSubscription(name, prompt, sourceAgentId),
			dataDir
		),
	pid: process.pid,
};

/** Start Cue in this process when the rules allow it. Never throws: a failure is the reported state. */
export async function startHostCue(
	paths: { userDataDir: string; settingsFile: string },
	overrides: Partial<HostCueDeps> = {}
): Promise<HostCue> {
	const deps = { ...defaultDeps, ...overrides };
	const held = (state: HostCueState): HostCue => ({ state: () => state, stop: () => undefined });

	try {
		if (!(await deps.isEnabled(paths.settingsFile))) return held({ state: 'disabled' });

		const holder = deps.readLock(paths.userDataDir);
		if (holder && holder.pid !== deps.pid) {
			return held({ state: 'held', mode: holder.mode, pid: holder.pid });
		}

		const engine = await deps.createEngine();
		engine.start('system-boot');
		const after = deps.readLock(paths.userDataDir);
		if (after?.pid !== deps.pid) {
			engine.stop();
			return after
				? held({ state: 'held', mode: after.mode, pid: after.pid })
				: held({ state: 'failed', reason: 'The engine did not start (see the host log).' });
		}

		const stopInbox = deps.startInbox(engine, paths.userDataDir);
		let stopped = false;
		return {
			state: () => (stopped ? { state: 'disabled' } : { state: 'running' }),
			stop: () => {
				if (stopped) return;
				stopped = true;
				stopInbox();
				engine.stop();
			},
		};
	} catch (error) {
		return held({
			state: 'failed',
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}
