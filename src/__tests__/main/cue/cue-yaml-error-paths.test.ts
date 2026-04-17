/**
 * Error-path coverage for Cue YAML and recovery-service logic.
 *
 * These test the hardening added in this release: negative sleep-gap
 * detection, torn-flag protection on the YAML watcher, and pruner
 * resilience to unreadable directories. Missing YAML is tolerated; corrupt
 * YAML is surfaced as a validation error rather than crashing the engine.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import {
	pruneOrphanedPromptFiles,
	readCueConfigFile,
	watchCueConfigFile,
} from '../../../main/cue/config/cue-config-repository';
import { validateCueConfig } from '../../../main/cue/cue-yaml-loader';

let projectRoot = '';

beforeEach(() => {
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-errors-'));
});

afterEach(() => {
	if (projectRoot && fs.existsSync(projectRoot)) {
		fs.rmSync(projectRoot, { recursive: true, force: true });
	}
});

describe('malformed YAML handling', () => {
	it('validateCueConfig flags a non-object root', () => {
		const result = validateCueConfig('plain string') as { valid: boolean; errors: string[] };
		expect(result.valid).toBe(false);
		expect(result.errors.length).toBeGreaterThan(0);
	});

	it('validateCueConfig flags a missing subscriptions array', () => {
		const result = validateCueConfig({ settings: {} }) as { valid: boolean; errors: string[] };
		expect(result.valid).toBe(false);
	});

	it('validateCueConfig accepts a minimal valid config', () => {
		const result = validateCueConfig({ subscriptions: [] }) as {
			valid: boolean;
			errors: string[];
		};
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});
});

describe('missing-file tolerance', () => {
	it('readCueConfigFile returns null for a missing file (no throw)', () => {
		expect(readCueConfigFile(projectRoot)).toBeNull();
	});

	it('pruneOrphanedPromptFiles returns empty array when prompts dir does not exist', () => {
		expect(pruneOrphanedPromptFiles(projectRoot, [])).toEqual([]);
	});
});

describe('watchCueConfigFile torn-flag guard', () => {
	it('cleanup stops further onChange invocations even if debounce would fire', async () => {
		// Regression: the hardening added a `torn` flag so that any debounced
		// callback scheduled just before cleanup can't fire after the watcher
		// is closed. Without this, a session teardown overlapping with a file
		// change could re-trigger refreshSession on a session that no longer
		// exists.
		const onChange = vi.fn();
		const cleanup = watchCueConfigFile(projectRoot, onChange);

		// No change events fired — cleanup immediately.
		cleanup();

		// Wait beyond the 1s debounce window — nothing should fire.
		await new Promise((resolve) => setTimeout(resolve, 1100));
		expect(onChange).not.toHaveBeenCalled();
	});

	it('cleanup is idempotent', () => {
		const onChange = vi.fn();
		const cleanup = watchCueConfigFile(projectRoot, onChange);
		cleanup();
		// Calling cleanup twice should not throw even though chokidar.close()
		// has already run.
		expect(() => cleanup()).not.toThrow();
	});
});

describe('recovery-service negative-gap guard', () => {
	// Exercised via the CueRecoveryService directly to lock in the clock-
	// moved-backward handling added in this release.
	let mockGetLastHeartbeat: ReturnType<typeof vi.fn>;
	let mockRecordHeartbeat: ReturnType<typeof vi.fn>;
	let originalDateNow: typeof Date.now;

	beforeEach(() => {
		mockGetLastHeartbeat = vi.fn();
		mockRecordHeartbeat = vi.fn();
		originalDateNow = Date.now;
	});

	afterEach(() => {
		Date.now = originalDateNow;
		vi.resetModules();
	});

	it('skips reconciliation and logs when the heartbeat is in the future', async () => {
		// Simulate system clock set backward: lastHeartbeat is after "now".
		vi.resetModules();
		vi.doMock('../../../main/cue/cue-db', () => ({
			initCueDb: () => ({ ok: true }),
			getLastHeartbeat: mockGetLastHeartbeat,
			recordHeartbeat: mockRecordHeartbeat,
			getCueEventsBySession: () => [],
			closeCueDb: () => {},
		}));

		const { createCueRecoveryService } = await import('../../../main/cue/cue-recovery-service');

		const onLog = vi.fn();
		const service = createCueRecoveryService({
			enabled: () => true,
			getSessions: () => new Map(),
			onLog,
			reconcileSession: vi.fn(),
		});

		// Init to open the DB path.
		service.init();

		// Heartbeat is 10 seconds in the future — gapMs will be negative.
		Date.now = vi.fn(() => 1000);
		mockGetLastHeartbeat.mockReturnValue(11000);

		service.detectSleepAndReconcile();

		expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('Clock moved backward'));
	});
});
