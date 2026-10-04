import { describe, it, expect } from 'vitest';
import {
	DOCTOR_CUE_LOCK_STALE_MS,
	CUE_ENGINE_LOCK_FILE_NAME,
} from '../../../shared/maestro-lib/paths/doctor';
import { CUE_ENGINE_LOCK_STALE_MS } from '../../../main/cue/cue-engine-lock';

/**
 * The TUI doctor reads `cue-engine.lock` without importing `src/main`, so it
 * keeps its own copy of the staleness window. This fails if the engine changes it.
 */
describe('doctor / cue-engine-lock parity', () => {
	it('uses the same staleness window as the engine', () => {
		expect(DOCTOR_CUE_LOCK_STALE_MS).toBe(CUE_ENGINE_LOCK_STALE_MS);
	});

	it('reads the file the engine writes', () => {
		expect(CUE_ENGINE_LOCK_FILE_NAME).toBe('cue-engine.lock');
	});
});
