import { describe, it, expect } from 'vitest';
import { CUE_ENGINE_LOCK_SPEC } from '../../../shared/maestro-lib/runtime/lock';
import {
	CUE_ENGINE_LOCK_HEARTBEAT_MS,
	CUE_ENGINE_LOCK_STALE_MS,
} from '../../../main/cue/cue-engine-lock';

/**
 * The TUI doctor reads `cue-engine.lock` without importing `src/main`, so the
 * engine's lock parameters live in the library (`CUE_ENGINE_LOCK_SPEC`) and the
 * engine's exports derive from them. This fails if the engine ever stops doing so,
 * or if the file the engine writes is renamed.
 */
describe('doctor / cue-engine-lock parity', () => {
	it('uses the same staleness window and heartbeat as the engine', () => {
		expect(CUE_ENGINE_LOCK_SPEC.staleMs).toBe(CUE_ENGINE_LOCK_STALE_MS);
		expect(CUE_ENGINE_LOCK_SPEC.heartbeatMs).toBe(CUE_ENGINE_LOCK_HEARTBEAT_MS);
	});

	it('reads the file the engine writes', () => {
		expect(CUE_ENGINE_LOCK_SPEC.fileName).toBe('cue-engine.lock');
	});
});
