/**
 * Tests for src/main/agents/claude-interactive-replay.ts
 *
 * Strategy: drive the controller against a plain `EventEmitter` so the
 * production wiring (process manager, sessions store, BrowserWindow,
 * sampleUsage) can be swapped out for Vitest spies. Coverage hits every
 * spec checklist item:
 *   (a)→(d) happy path on exit code 2
 *   exit codes 0/1/3 → no respawn
 *   sampleUsage failures → replay still happens
 *   session-id scoping (other sessions' exits don't trigger replay)
 *   replay-once semantics on duplicate exit emits
 *   manual clearInteractiveReplay() detaches cleanly
 *   re-registration replacement drops the prior listener
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

import {
	createInteractiveReplayController,
	LIMIT_EXIT_CODE,
	type InteractiveReplayContext,
	type InteractiveReplayDeps,
	type ResolvedResolution,
	type SessionInteractiveUpdate,
} from '../../../main/agents/claude-interactive-replay';

interface FakeSpawnConfig {
	sessionId: string;
	prompt: string;
	resumeId?: string;
}

interface Harness {
	emitter: EventEmitter;
	sampleUsage: ReturnType<typeof vi.fn>;
	updateSessionInteractive: ReturnType<typeof vi.fn>;
	emitModeResolved: ReturnType<typeof vi.fn>;
	spawnReplay: ReturnType<typeof vi.fn>;
	logger: {
		debug: ReturnType<typeof vi.fn>;
		info: ReturnType<typeof vi.fn>;
		warn: ReturnType<typeof vi.fn>;
	};
	controller: ReturnType<typeof createInteractiveReplayController<FakeSpawnConfig>>;
}

function buildHarness(overrides: Partial<InteractiveReplayDeps<FakeSpawnConfig>> = {}): Harness {
	const emitter = overrides.emitter ?? new EventEmitter();
	const sampleUsage = vi.fn().mockResolvedValue(undefined);
	const updateSessionInteractive = vi.fn();
	const emitModeResolved = vi.fn();
	const spawnReplay = vi.fn();
	const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
	const controller = createInteractiveReplayController<FakeSpawnConfig>({
		emitter,
		sampleUsage,
		updateSessionInteractive,
		emitModeResolved,
		spawnReplay,
		logger,
		...overrides,
	});
	return {
		emitter,
		sampleUsage,
		updateSessionInteractive,
		emitModeResolved,
		spawnReplay,
		logger,
		controller,
	};
}

function buildContext(
	overrides: Partial<InteractiveReplayContext<FakeSpawnConfig>> = {}
): InteractiveReplayContext<FakeSpawnConfig> {
	return {
		configDirKey: '/Users/test/.claude',
		prompt: 'analyze foo.ts',
		buildApiSpawnConfig: ({ prompt }) => ({
			sessionId: 's1',
			prompt,
			resumeId: 'agent-session-xyz',
		}),
		...overrides,
	};
}

/**
 * Yield to microtasks so the async replay flow chained off `void runReplay()`
 * has a chance to complete before the test asserts on its side effects.
 */
async function flushMicrotasks(): Promise<void> {
	// Two yields: one for the `await sampleUsage()`, one for the chained
	// .then() body that contains the rest of the flow.
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe('createInteractiveReplayController', () => {
	beforeEach(() => {
		// `vi.fn()` instances are recreated by buildHarness; no global state to reset.
	});

	describe('happy path on exit code 2', () => {
		it('runs (a)→(d) in order with the right payloads', async () => {
			const h = buildHarness();
			const ctx = buildContext();
			h.controller.registerInteractiveReplay('s1', ctx);

			h.emitter.emit('exit', 's1', LIMIT_EXIT_CODE);
			await flushMicrotasks();

			expect(h.sampleUsage).toHaveBeenCalledTimes(1);
			expect(h.sampleUsage).toHaveBeenCalledWith('/Users/test/.claude');

			expect(h.updateSessionInteractive).toHaveBeenCalledTimes(1);
			expect(h.updateSessionInteractive).toHaveBeenCalledWith('s1', {
				mode: 'api',
				modeReason: 'limit',
				lastUsageSnapshotKey: '/Users/test/.claude',
			} satisfies SessionInteractiveUpdate);

			expect(h.emitModeResolved).toHaveBeenCalledTimes(1);
			expect(h.emitModeResolved).toHaveBeenCalledWith('s1', {
				mode: 'api',
				reason: 'limit',
				configDirKey: '/Users/test/.claude',
			} satisfies ResolvedResolution);

			expect(h.spawnReplay).toHaveBeenCalledTimes(1);
			expect(h.spawnReplay).toHaveBeenCalledWith('s1', {
				sessionId: 's1',
				prompt: 'analyze foo.ts',
				resumeId: 'agent-session-xyz',
			});
		});

		it('calls buildApiSpawnConfig with the captured prompt', async () => {
			const h = buildHarness();
			const buildApiSpawnConfig = vi.fn<(replay: { prompt: string }) => FakeSpawnConfig>(
				(replay) => ({ sessionId: 's1', prompt: replay.prompt })
			);
			h.controller.registerInteractiveReplay(
				's1',
				buildContext({ prompt: 'check the schema migration', buildApiSpawnConfig })
			);

			h.emitter.emit('exit', 's1', LIMIT_EXIT_CODE);
			await flushMicrotasks();

			expect(buildApiSpawnConfig).toHaveBeenCalledWith({ prompt: 'check the schema migration' });
		});

		it('runs steps in order: sample → update → emit → spawn', async () => {
			const callOrder: string[] = [];
			const h = buildHarness({
				sampleUsage: vi.fn(async () => {
					callOrder.push('sample');
				}),
				updateSessionInteractive: vi.fn(() => {
					callOrder.push('update');
				}),
				emitModeResolved: vi.fn(() => {
					callOrder.push('emit');
				}),
				spawnReplay: vi.fn(() => {
					callOrder.push('spawn');
				}),
			});
			h.controller.registerInteractiveReplay('s1', buildContext());

			h.emitter.emit('exit', 's1', LIMIT_EXIT_CODE);
			await flushMicrotasks();

			expect(callOrder).toEqual(['sample', 'update', 'emit', 'spawn']);
		});

		it('clears the registered context after the replay completes', async () => {
			const h = buildHarness();
			h.controller.registerInteractiveReplay('s1', buildContext());
			expect(h.controller.hasInteractiveReplay('s1')).toBe(true);

			h.emitter.emit('exit', 's1', LIMIT_EXIT_CODE);
			await flushMicrotasks();

			expect(h.controller.hasInteractiveReplay('s1')).toBe(false);
		});
	});

	describe('non-limit exit codes', () => {
		it.each([0, 1, 3, 130])('does not replay on exit code %i', async (code) => {
			const h = buildHarness();
			h.controller.registerInteractiveReplay('s1', buildContext());

			h.emitter.emit('exit', 's1', code);
			await flushMicrotasks();

			expect(h.sampleUsage).not.toHaveBeenCalled();
			expect(h.updateSessionInteractive).not.toHaveBeenCalled();
			expect(h.emitModeResolved).not.toHaveBeenCalled();
			expect(h.spawnReplay).not.toHaveBeenCalled();
		});

		it('still clears the registration after a non-limit exit', async () => {
			const h = buildHarness();
			h.controller.registerInteractiveReplay('s1', buildContext());

			h.emitter.emit('exit', 's1', 0);
			await flushMicrotasks();

			expect(h.controller.hasInteractiveReplay('s1')).toBe(false);
		});
	});

	describe('sampleUsage failure tolerance', () => {
		it('continues the replay when sampleUsage rejects', async () => {
			const h = buildHarness({
				sampleUsage: vi.fn().mockRejectedValue(new Error('boom')),
			});
			h.controller.registerInteractiveReplay('s1', buildContext());

			h.emitter.emit('exit', 's1', LIMIT_EXIT_CODE);
			await flushMicrotasks();

			expect(h.updateSessionInteractive).toHaveBeenCalled();
			expect(h.emitModeResolved).toHaveBeenCalled();
			expect(h.spawnReplay).toHaveBeenCalled();
			expect(h.logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('sampleUsage threw'),
				expect.objectContaining({ sessionId: 's1', configDirKey: '/Users/test/.claude' })
			);
		});

		it('continues the replay when sampleUsage throws synchronously', async () => {
			const h = buildHarness({
				sampleUsage: vi.fn(() => {
					throw new Error('sync boom');
				}),
			});
			h.controller.registerInteractiveReplay('s1', buildContext());

			h.emitter.emit('exit', 's1', LIMIT_EXIT_CODE);
			await flushMicrotasks();

			expect(h.updateSessionInteractive).toHaveBeenCalled();
			expect(h.emitModeResolved).toHaveBeenCalled();
			expect(h.spawnReplay).toHaveBeenCalled();
		});
	});

	describe('session-id scoping', () => {
		it('does not replay when a different session exits', async () => {
			const h = buildHarness();
			h.controller.registerInteractiveReplay('s1', buildContext());

			h.emitter.emit('exit', 'other-session', LIMIT_EXIT_CODE);
			await flushMicrotasks();

			expect(h.sampleUsage).not.toHaveBeenCalled();
			expect(h.spawnReplay).not.toHaveBeenCalled();
			// And s1 must still be armed.
			expect(h.controller.hasInteractiveReplay('s1')).toBe(true);
		});

		it('routes exits to the correct registered session', async () => {
			const h = buildHarness();
			const ctxA = buildContext({ configDirKey: '/a', prompt: 'A' });
			const ctxB = buildContext({
				configDirKey: '/b',
				prompt: 'B',
				buildApiSpawnConfig: ({ prompt }) => ({ sessionId: 'sB', prompt }),
			});
			h.controller.registerInteractiveReplay('sA', ctxA);
			h.controller.registerInteractiveReplay('sB', ctxB);

			h.emitter.emit('exit', 'sB', LIMIT_EXIT_CODE);
			await flushMicrotasks();

			expect(h.sampleUsage).toHaveBeenCalledWith('/b');
			expect(h.spawnReplay).toHaveBeenCalledWith('sB', expect.objectContaining({ prompt: 'B' }));
			expect(h.controller.hasInteractiveReplay('sA')).toBe(true);
			expect(h.controller.hasInteractiveReplay('sB')).toBe(false);
		});
	});

	describe('replay-once semantics', () => {
		it('fires at most once when exit is emitted twice', async () => {
			const h = buildHarness();
			h.controller.registerInteractiveReplay('s1', buildContext());

			h.emitter.emit('exit', 's1', LIMIT_EXIT_CODE);
			h.emitter.emit('exit', 's1', LIMIT_EXIT_CODE);
			await flushMicrotasks();

			expect(h.spawnReplay).toHaveBeenCalledTimes(1);
			expect(h.sampleUsage).toHaveBeenCalledTimes(1);
			expect(h.updateSessionInteractive).toHaveBeenCalledTimes(1);
			expect(h.emitModeResolved).toHaveBeenCalledTimes(1);
		});

		it('removes the listener from the emitter after firing', async () => {
			const h = buildHarness();
			h.controller.registerInteractiveReplay('s1', buildContext());
			expect(h.emitter.listenerCount('exit')).toBe(1);

			h.emitter.emit('exit', 's1', LIMIT_EXIT_CODE);
			await flushMicrotasks();

			expect(h.emitter.listenerCount('exit')).toBe(0);
		});
	});

	describe('clearInteractiveReplay', () => {
		it('detaches the listener and forgets the context', () => {
			const h = buildHarness();
			h.controller.registerInteractiveReplay('s1', buildContext());
			expect(h.emitter.listenerCount('exit')).toBe(1);
			expect(h.controller.hasInteractiveReplay('s1')).toBe(true);

			h.controller.clearInteractiveReplay('s1');

			expect(h.emitter.listenerCount('exit')).toBe(0);
			expect(h.controller.hasInteractiveReplay('s1')).toBe(false);
		});

		it('prevents a subsequent exit-code-2 from triggering replay', async () => {
			const h = buildHarness();
			h.controller.registerInteractiveReplay('s1', buildContext());
			h.controller.clearInteractiveReplay('s1');

			h.emitter.emit('exit', 's1', LIMIT_EXIT_CODE);
			await flushMicrotasks();

			expect(h.sampleUsage).not.toHaveBeenCalled();
			expect(h.spawnReplay).not.toHaveBeenCalled();
		});

		it('is idempotent (safe to call when no context is registered)', () => {
			const h = buildHarness();
			expect(() => h.controller.clearInteractiveReplay('s1')).not.toThrow();
			expect(h.emitter.listenerCount('exit')).toBe(0);
		});
	});

	describe('re-registration replacement', () => {
		it('drops the prior listener when the same session re-registers', async () => {
			const h = buildHarness();
			const ctxA = buildContext({
				configDirKey: '/old',
				buildApiSpawnConfig: () => ({ sessionId: 's1', prompt: 'OLD' }),
			});
			const ctxB = buildContext({
				configDirKey: '/new',
				buildApiSpawnConfig: () => ({ sessionId: 's1', prompt: 'NEW' }),
			});
			h.controller.registerInteractiveReplay('s1', ctxA);
			h.controller.registerInteractiveReplay('s1', ctxB);

			// Only one listener total even after two registrations.
			expect(h.emitter.listenerCount('exit')).toBe(1);

			h.emitter.emit('exit', 's1', LIMIT_EXIT_CODE);
			await flushMicrotasks();

			expect(h.sampleUsage).toHaveBeenCalledWith('/new');
			expect(h.spawnReplay).toHaveBeenCalledWith('s1', expect.objectContaining({ prompt: 'NEW' }));
		});
	});

	describe('buildApiSpawnConfig edge cases', () => {
		it('skips spawnReplay when buildApiSpawnConfig returns null', async () => {
			const h = buildHarness();
			h.controller.registerInteractiveReplay(
				's1',
				buildContext({ buildApiSpawnConfig: () => null })
			);

			h.emitter.emit('exit', 's1', LIMIT_EXIT_CODE);
			await flushMicrotasks();

			expect(h.sampleUsage).toHaveBeenCalled();
			expect(h.updateSessionInteractive).toHaveBeenCalled();
			expect(h.emitModeResolved).toHaveBeenCalled();
			expect(h.spawnReplay).not.toHaveBeenCalled();
		});

		it('logs and aborts the spawn step when buildApiSpawnConfig throws', async () => {
			const h = buildHarness();
			h.controller.registerInteractiveReplay(
				's1',
				buildContext({
					buildApiSpawnConfig: () => {
						throw new Error('config build failed');
					},
				})
			);

			h.emitter.emit('exit', 's1', LIMIT_EXIT_CODE);
			await flushMicrotasks();

			expect(h.spawnReplay).not.toHaveBeenCalled();
			expect(h.logger.warn).toHaveBeenCalledWith(
				expect.stringContaining('buildApiSpawnConfig threw'),
				expect.objectContaining({ sessionId: 's1' })
			);
		});
	});

	describe('multi-session independence', () => {
		it('manages registrations for unrelated sessions independently', async () => {
			const h = buildHarness();
			h.controller.registerInteractiveReplay('sA', buildContext({ configDirKey: '/a' }));
			h.controller.registerInteractiveReplay('sB', buildContext({ configDirKey: '/b' }));

			expect(h.emitter.listenerCount('exit')).toBe(2);

			h.controller.clearInteractiveReplay('sA');
			expect(h.emitter.listenerCount('exit')).toBe(1);
			expect(h.controller.hasInteractiveReplay('sA')).toBe(false);
			expect(h.controller.hasInteractiveReplay('sB')).toBe(true);

			h.emitter.emit('exit', 'sB', LIMIT_EXIT_CODE);
			await flushMicrotasks();

			expect(h.sampleUsage).toHaveBeenCalledWith('/b');
		});
	});
});
