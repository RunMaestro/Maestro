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
		// Deterministic setup: wait for chokidar's 'ready' event via the
		// opt-in hook instead of sleeping on a timer. The prior 50ms sleep
		// raced with chokidar's initial scan on slow CI runners and made
		// this assertion trivially pass when no change event ever fired.
		let cleanup!: () => void;
		await new Promise<void>((resolve) => {
			cleanup = watchCueConfigFile(projectRoot, onChange, { onReady: resolve });
		});

		// Trigger a real change so the debounced callback is scheduled — this
		// exercises the path the torn flag actually protects. Writing the
		// canonical .maestro/cue.yaml is exactly what the session runtime does.
		const maestroDir = path.join(projectRoot, '.maestro');
		fs.mkdirSync(maestroDir, { recursive: true });
		fs.writeFileSync(path.join(maestroDir, 'cue.yaml'), 'subscriptions: []', 'utf-8');

		// Cleanup IMMEDIATELY — the debounced setTimeout is already scheduled
		// (or about to be). The torn flag must reject it when it fires.
		cleanup();

		// Wait beyond the 1s debounce window — nothing should fire.
		await new Promise((resolve) => setTimeout(resolve, 1200));
		expect(onChange).not.toHaveBeenCalled();
	});

	it('cleanup is idempotent and does not leak an unhandled rejection', async () => {
		const onChange = vi.fn();
		const cleanup = watchCueConfigFile(projectRoot, onChange);

		// chokidar.close() returns a Promise. We don't await it, so any
		// rejection on a double-close would surface as an unhandled rejection
		// rather than a synchronous throw — watch for both.
		const unhandled: unknown[] = [];
		const onUnhandled = (event: { reason?: unknown } | PromiseRejectionEvent) => {
			unhandled.push((event as { reason?: unknown }).reason);
		};
		process.on('unhandledRejection', onUnhandled);

		try {
			cleanup();
			// Second call must not throw synchronously…
			expect(() => cleanup()).not.toThrow();
			// …and must not produce an async rejection either. Give the
			// microtask queue a tick to surface one if it's going to.
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(unhandled).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});
});

describe('recovery-service negative-gap guard', () => {
	// Exercised via the CueRecoveryService directly to lock in the clock-
	// moved-backward handling added in this release.
	let mockGetLastHeartbeat: ReturnType<typeof vi.fn>;
	let mockRecordHeartbeat: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mockGetLastHeartbeat = vi.fn();
		mockRecordHeartbeat = vi.fn();
	});

	afterEach(() => {
		// vi.restoreAllMocks undoes vi.spyOn(Date, 'now') below (and any other
		// spies), removing the need for manual save/restore bookkeeping.
		vi.restoreAllMocks();
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
			pruneCueEvents: vi.fn(),
		}));

		const { createCueRecoveryService } = await import('../../../main/cue/cue-recovery-service');

		const onLog = vi.fn();
		const reconcileSession = vi.fn();
		const service = createCueRecoveryService({
			enabled: () => true,
			getSessions: () => new Map(),
			onLog,
			reconcileSession,
		});

		// Init opens the DB (mocked as a no-op here).
		service.init();

		// Heartbeat is 10 seconds in the future — gapMs will be negative.
		vi.spyOn(Date, 'now').mockReturnValue(1000);
		mockGetLastHeartbeat.mockReturnValue(11000);

		service.detectSleepAndReconcile();

		expect(onLog).toHaveBeenCalledWith('cue', expect.stringContaining('Clock moved backward'));
		// Regression gate: a future version that logged the warning but
		// ALSO ran reconciliation (or rewrote the heartbeat) would defeat
		// the whole point of the guard. Pin both side-effects off.
		expect(reconcileSession).not.toHaveBeenCalled();
		expect(mockRecordHeartbeat).not.toHaveBeenCalled();
	});
});
