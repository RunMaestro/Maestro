// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/main/agents/claude-interactive-replay.test.ts
// Source: src/__tests__/main/agents/claude-transcript-sanitizer.test.ts
// Source: src/__tests__/main/agents/claudeSpawnCore.test.ts
// Source: src/__tests__/main/agents/codex-reset-credits.test.ts
// Source: src/__tests__/main/agents/limitResetEstimator.test.ts
// Source: src/__tests__/main/agents/remoteMaestroPCache.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import {
	createInteractiveReplayController,
	LIMIT_EXIT_CODE,
	type InteractiveReplayContext,
	type InteractiveReplayDeps,
	type ResolvedResolution,
	type SessionInteractiveUpdate,
} from '../../../main/agents/claude-interactive-replay';
import * as s2_fs from 'fs';
import * as s2_os from 'os';
import * as s2_path from 'path';
import { stripThinkingFromTranscript } from '../../../main/agents/claude-transcript-sanitizer';
import s3_path from 'path';
import s3_os from 'os';
import {
	resolveClaudeSpawnModeCore,
	findPackagedAppHost,
	isMaestroPBinaryPath,
	resolveConfigDirKeyFromEnv,
	mergeClaudeSpawnEnvLayers,
	defaultSelectMode,
	applyClaudeSpawnDecision,
	buildRemoteInteractiveSpawn,
	isAgentOwnWorkingDirectory,
	MAESTRO_P_ACCEPT_WORKSPACE_TRUST_ENV,
	type ClaudeSpawnCoreDeps,
	type ClaudeSpawnDecision,
} from '../../../main/agents/claudeSpawnCore';
import { mkdtempSync } from 'fs';
import s4_fs from 'fs/promises';
import s4_os from 'os';
import s4_path from 'path';
import {
	consumeCodexResetCredit,
	fetchCodexResetCredits,
} from '../../../main/agents/codex-reset-credits';
import { getLimitResetAt } from '../../../main/agents/limitResetEstimator';
import {
	setRemoteMaestroPAvailable,
	getRemoteMaestroPAvailable,
	isRemoteMaestroPProbeStale,
	REMOTE_MAESTRO_P_TTL_MS,
	__clearRemoteMaestroPCache,
} from '../../../main/agents/remoteMaestroPCache';
const { captureMessageMock } = vi.hoisted(() => ({
	captureMessageMock: vi.fn(),
}));
// Mock the usage store so the estimator can be exercised without electron-store.
const { mockGetSnapshot } = vi.hoisted(() => ({ mockGetSnapshot: vi.fn() }));
vi.mock('../../../main/utils/sentry', () => ({
	captureMessage: captureMessageMock,
}));
vi.mock('../../../main/stores/claudeUsageStore', () => ({
	getSnapshot: (...args: unknown[]) => mockGetSnapshot(...args),
	resolveConfigDirKey: (env: NodeJS.ProcessEnv) => env.CLAUDE_CONFIG_DIR ?? '/home/u/.claude',
}));
// Source: src/__tests__/main/agents/claude-interactive-replay.test.ts
describe('', () => {
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
			it('re-sends (update → emit → spawn) before the backgrounded usage sample settles', async () => {
				// The usage sample is fire-and-forget: it must NOT gate the replay spawn,
				// because sampleUsage runs `maestro-p --status` (~30s) and awaiting it
				// stalled the user's re-sent prompt long after the mode-switch banner.
				// So update/emit/spawn run synchronously first; 'sample' settles last.
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
				expect(callOrder).toEqual(['update', 'emit', 'spawn', 'sample']);
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
				expect(h.spawnReplay).toHaveBeenCalledWith(
					's1',
					expect.objectContaining({ prompt: 'NEW' })
				);
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
});
// Source: src/__tests__/main/agents/claude-transcript-sanitizer.test.ts
describe('', () => {
	let dir: string;
	let transcriptPath: string;
	function write(rows: unknown[]): void {
		s2_fs.writeFileSync(
			transcriptPath,
			rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
			'utf8'
		);
	}
	function readRows(): Array<Record<string, unknown>> {
		return s2_fs
			.readFileSync(transcriptPath, 'utf8')
			.split('\n')
			.filter((l) => l.trim().length > 0)
			.map((l) => JSON.parse(l));
	}
	beforeEach(() => {
		dir = s2_fs.mkdtempSync(s2_path.join(s2_os.tmpdir(), 'maestro-sanitize-'));
		transcriptPath = s2_path.join(dir, 'session.jsonl');
	});
	afterEach(() => {
		s2_fs.rmSync(dir, { recursive: true, force: true });
	});
	describe('stripThinkingFromTranscript', () => {
		it('drops thinking-only assistant rows and re-links the parentUuid chain', () => {
			write([
				{ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' } },
				{
					type: 'assistant',
					uuid: 'a1',
					parentUuid: 'u1',
					message: {
						role: 'assistant',
						content: [{ type: 'thinking', thinking: '', signature: 'sig-abc' }],
					},
				},
				{
					type: 'assistant',
					uuid: 'a2',
					parentUuid: 'a1',
					message: {
						role: 'assistant',
						content: [{ type: 'text', text: 'hello there' }],
					},
				},
			]);
			const res = stripThinkingFromTranscript(transcriptPath);
			expect(res.sanitized).toBe(true);
			expect(res.droppedRows).toBe(1);
			expect(res.strippedBlocks).toBe(0);
			const rows = readRows();
			expect(rows.map((r) => r.uuid)).toEqual(['u1', 'a2']);
			// a2 was re-linked past the dropped a1 to a1's parent (u1).
			expect(rows.find((r) => r.uuid === 'a2')?.parentUuid).toBe('u1');
		});
		it('re-links transitively across consecutive dropped rows', () => {
			write([
				{ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'go' } },
				{
					type: 'assistant',
					uuid: 't1',
					parentUuid: 'u1',
					message: {
						role: 'assistant',
						content: [{ type: 'thinking', thinking: '', signature: 's1' }],
					},
				},
				{
					type: 'assistant',
					uuid: 't2',
					parentUuid: 't1',
					message: {
						role: 'assistant',
						content: [{ type: 'thinking', thinking: '', signature: 's2' }],
					},
				},
				{ type: 'attachment', uuid: 'att', parentUuid: 't2' },
			]);
			const res = stripThinkingFromTranscript(transcriptPath);
			expect(res.droppedRows).toBe(2);
			const rows = readRows();
			expect(rows.map((r) => r.uuid)).toEqual(['u1', 'att']);
			expect(rows.find((r) => r.uuid === 'att')?.parentUuid).toBe('u1');
		});
		it('strips thinking blocks from a mixed-content row without dropping it', () => {
			write([
				{
					type: 'assistant',
					uuid: 'a1',
					parentUuid: null,
					message: {
						role: 'assistant',
						content: [
							{ type: 'thinking', thinking: '', signature: 'sig' },
							{ type: 'text', text: 'visible' },
							{ type: 'tool_use', id: 'tu1', name: 'Read', input: {} },
						],
					},
				},
			]);
			const res = stripThinkingFromTranscript(transcriptPath);
			expect(res.sanitized).toBe(true);
			expect(res.droppedRows).toBe(0);
			expect(res.strippedBlocks).toBe(1);
			const content = (
				readRows()[0].message as {
					content: Array<{
						type: string;
					}>;
				}
			).content;
			expect(content.map((b) => b.type)).toEqual(['text', 'tool_use']);
		});
		it('is a no-op when there are no thinking blocks (byte-identical, no backup)', () => {
			write([
				{ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' } },
				{
					type: 'assistant',
					uuid: 'a1',
					parentUuid: 'u1',
					message: { role: 'assistant', content: [{ type: 'text', text: 'yo' }] },
				},
			]);
			const before = s2_fs.readFileSync(transcriptPath, 'utf8');
			const res = stripThinkingFromTranscript(transcriptPath);
			expect(res.sanitized).toBe(false);
			expect(res.backupPath).toBeNull();
			expect(s2_fs.readFileSync(transcriptPath, 'utf8')).toBe(before);
			expect(s2_fs.existsSync(`${transcriptPath}.maestro-presanitize.bak`)).toBe(false);
		});
		it('writes a one-time backup of the original before mutating', () => {
			write([
				{
					type: 'assistant',
					uuid: 'a1',
					parentUuid: null,
					message: {
						role: 'assistant',
						content: [{ type: 'thinking', thinking: '', signature: 's' }],
					},
				},
			]);
			const original = s2_fs.readFileSync(transcriptPath, 'utf8');
			const res = stripThinkingFromTranscript(transcriptPath);
			expect(res.backupPath).toBe(`${transcriptPath}.maestro-presanitize.bak`);
			expect(s2_fs.readFileSync(res.backupPath as string, 'utf8')).toBe(original);
		});
		it('preserves malformed (non-JSON) lines verbatim', () => {
			s2_fs.writeFileSync(
				transcriptPath,
				[
					JSON.stringify({
						type: 'assistant',
						uuid: 'a1',
						parentUuid: null,
						message: {
							role: 'assistant',
							content: [{ type: 'thinking', thinking: '', signature: 's' }],
						},
					}),
					'{ not valid json',
					JSON.stringify({
						type: 'assistant',
						uuid: 'a2',
						parentUuid: 'a1',
						message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
					}),
				].join('\n') + '\n',
				'utf8'
			);
			stripThinkingFromTranscript(transcriptPath);
			const out = s2_fs.readFileSync(transcriptPath, 'utf8');
			expect(out).toContain('{ not valid json');
			const rows = out
				.split('\n')
				.filter((l) => l.trim().length > 0 && l.trim().startsWith('{"'))
				.map((l) => JSON.parse(l));
			expect(rows.map((r) => r.uuid)).toEqual(['a2']);
		});
		it('returns a no-op for a missing file', () => {
			const res = stripThinkingFromTranscript(s2_path.join(dir, 'does-not-exist.jsonl'));
			expect(res.sanitized).toBe(false);
			expect(res.droppedRows).toBe(0);
		});
		it('preserves valid API-account thinking blocks (non-empty reasoning text)', () => {
			// Pure-API transcripts: the sanitizer must NOT strip thinking blocks
			// that carry non-empty reasoning. Anthropic's API rejects re-resumes
			// where the latest assistant message's thinking blocks were modified,
			// so stripping them would itself trip the 400 we're trying to prevent.
			write([
				{ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' } },
				{
					type: 'assistant',
					uuid: 'a1',
					parentUuid: 'u1',
					message: {
						role: 'assistant',
						content: [
							{ type: 'thinking', thinking: 'Let me consider this.', signature: 'api-sig' },
							{ type: 'text', text: 'sure' },
						],
					},
				},
			]);
			const before = s2_fs.readFileSync(transcriptPath, 'utf8');
			const res = stripThinkingFromTranscript(transcriptPath);
			expect(res.sanitized).toBe(false);
			expect(res.strippedBlocks).toBe(0);
			expect(res.droppedRows).toBe(0);
			expect(res.backupPath).toBeNull();
			expect(s2_fs.readFileSync(transcriptPath, 'utf8')).toBe(before);
		});
		it('strips empty shells while preserving non-empty thinking siblings in the same message', () => {
			// Hybrid shape: a single assistant message carrying both a maestro-p
			// shell and a valid API-account thinking block. Only the shell is
			// removed; the signed reasoning block survives untouched.
			write([
				{
					type: 'assistant',
					uuid: 'a1',
					parentUuid: null,
					message: {
						role: 'assistant',
						content: [
							{ type: 'thinking', thinking: '', signature: 'maestro-p-sig' },
							{ type: 'thinking', thinking: 'real reasoning', signature: 'api-sig' },
							{ type: 'text', text: 'answer' },
						],
					},
				},
			]);
			const res = stripThinkingFromTranscript(transcriptPath);
			expect(res.sanitized).toBe(true);
			expect(res.droppedRows).toBe(0);
			expect(res.strippedBlocks).toBe(1);
			const content = (
				readRows()[0].message as {
					content: Array<{
						type: string;
						thinking?: string;
					}>;
				}
			).content;
			expect(content.map((b) => b.type)).toEqual(['thinking', 'text']);
			expect(content[0].thinking).toBe('real reasoning');
		});
		it('treats `redacted_thinking` without a thinking field as an empty shell', () => {
			// `redacted_thinking` blocks may legitimately omit `thinking`; they
			// only carry an account-bound signature, so they're stripped just like
			// the empty-string shells maestro-p writes.
			write([
				{
					type: 'assistant',
					uuid: 'a1',
					parentUuid: null,
					message: {
						role: 'assistant',
						content: [
							{ type: 'redacted_thinking', signature: 'sig' },
							{ type: 'text', text: 'visible' },
						],
					},
				},
			]);
			const res = stripThinkingFromTranscript(transcriptPath);
			expect(res.sanitized).toBe(true);
			expect(res.strippedBlocks).toBe(1);
			const content = (
				readRows()[0].message as {
					content: Array<{
						type: string;
					}>;
				}
			).content;
			expect(content.map((b) => b.type)).toEqual(['text']);
		});
		// The sanitizer skips its per-line parse when the raw text cannot hold a
		// shell. That pre-check must not miss one written with JSON whitespace.
		it('finds an empty shell written with whitespace around the colon', () => {
			const row = {
				type: 'assistant',
				uuid: 'a1',
				parentUuid: null,
				message: {
					role: 'assistant',
					content: [
						{ type: 'thinking', thinking: '', signature: 'sig' },
						{ type: 'text', text: 'visible' },
					],
				},
			};
			s2_fs.writeFileSync(
				transcriptPath,
				`${JSON.stringify(row).replace('"thinking":""', '"thinking" : ""')}\n`,
				'utf8'
			);
			const res = stripThinkingFromTranscript(transcriptPath);
			expect(res.sanitized).toBe(true);
			expect(res.strippedBlocks).toBe(1);
		});
	});
});
// Source: src/__tests__/main/agents/claudeSpawnCore.test.ts
describe('', () => {
	const CLAUDE_AGENT = {
		id: 'claude-code',
		interactiveCommand: 'maestro-p',
		interactiveModeArgs: ['--dangerously-skip-permissions'],
	};
	/**
	 * Deps mirroring the CLI's `cliSpawnCoreDeps`: no SQLite usage snapshot, an
	 * optimistic remote probe, and an injectable maestro-p presence flag.
	 */
	function cliShapedDeps(overrides?: Partial<ClaudeSpawnCoreDeps>): ClaudeSpawnCoreDeps {
		return {
			getMaestroPBinPath: () => '/bundle/maestro-p.js',
			isMaestroPBinaryPath: isMaestroPBinaryPath,
			resolveConfigDirKey: resolveConfigDirKeyFromEnv,
			getUsageSnapshot: () => null,
			fileExists: () => true,
			getRemoteMaestroPAvailable: () => undefined,
			selectMode: defaultSelectMode,
			...overrides,
		};
	}
	describe('isMaestroPBinaryPath', () => {
		it('matches maestro-p by basename across path styles and variants', () => {
			expect(isMaestroPBinaryPath('/usr/local/bin/maestro-p')).toBe(true);
			expect(isMaestroPBinaryPath('/opt/app/maestro-p.js')).toBe(true);
			expect(isMaestroPBinaryPath('C:\\tools\\maestro-p.exe')).toBe(true);
			expect(isMaestroPBinaryPath('MAESTRO-P')).toBe(true);
		});
		it('does not match a plain claude binary or empty input', () => {
			expect(isMaestroPBinaryPath('/usr/local/bin/claude')).toBe(false);
			expect(isMaestroPBinaryPath('claude')).toBe(false);
			expect(isMaestroPBinaryPath(undefined)).toBe(false);
			expect(isMaestroPBinaryPath(null)).toBe(false);
			expect(isMaestroPBinaryPath('')).toBe(false);
		});
	});
	describe('resolveConfigDirKeyFromEnv', () => {
		it('uses CLAUDE_CONFIG_DIR when set (resolved to absolute)', () => {
			const configDir = s3_path.join(s3_os.tmpdir(), '.claude-test');
			const key = resolveConfigDirKeyFromEnv({ CLAUDE_CONFIG_DIR: configDir });
			expect(key).toBe(s3_path.resolve(configDir));
		});
		it('falls back to ~/.claude when unset', () => {
			const key = resolveConfigDirKeyFromEnv({});
			expect(key.endsWith('/.claude') || key.endsWith('\\.claude')).toBe(true);
		});
	});
	// The CLAUDE_CONFIG_DIR key must be built from every env layer the spawned
	// claude receives, in the order the spawn applies them. Leaving a layer out
	// sends the API-resume sanitizer to the wrong transcript.
	describe('mergeClaudeSpawnEnvLayers', () => {
		const dir = (name: string) => s3_path.resolve('/accounts', name);
		it('orders the layers process env < global < agent defaults < user set', () => {
			const env = mergeClaudeSpawnEnvLayers(
				{
					globalShellEnvVars: { A: 'global', B: 'global', C: 'global' },
					agentDefaultEnvVars: { B: 'default', C: 'default' },
					agentCustomEnvVars: { C: 'agent-level' },
				},
				{ A: 'process', P: 'process' }
			);
			expect(env).toMatchObject({ P: 'process', A: 'global', B: 'default', C: 'agent-level' });
		});
		it("uses the agent's own vars INSTEAD of the provider-level set, never both", () => {
			const env = mergeClaudeSpawnEnvLayers(
				{
					agentCustomEnvVars: { CLAUDE_CONFIG_DIR: dir('team'), TEAM_ONLY: '1' },
					sessionCustomEnvVars: { MINE: '1' },
				},
				{}
			);
			expect(env.MINE).toBe('1');
			expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
			expect(env.TEAM_ONLY).toBeUndefined();
		});
		it('feeds the resolver key from the global and provider-level layers', () => {
			const NOW = new Date('2026-07-05T00:00:00.000Z');
			const decide = (layers: {
				globalShellEnvVars?: Record<string, string>;
				agentCustomEnvVars?: Record<string, string>;
			}) =>
				resolveClaudeSpawnModeCore(
					{
						agent: CLAUDE_AGENT,
						tokenMode: 'api',
						sshEnabled: false,
						command: 'claude',
						// Stale interactive state makes the resolver compute the key itself.
						persisted: { mode: 'interactive' },
						now: NOW,
						...layers,
					},
					cliShapedDeps()
				).configDirKey;
			expect(decide({ globalShellEnvVars: { CLAUDE_CONFIG_DIR: dir('work') } })).toBe(dir('work'));
			expect(
				decide({
					globalShellEnvVars: { CLAUDE_CONFIG_DIR: dir('work') },
					agentCustomEnvVars: { CLAUDE_CONFIG_DIR: dir('team') },
				})
			).toBe(dir('team'));
		});
	});
	describe('resolveClaudeSpawnModeCore under CLI-shaped deps', () => {
		const NOW = new Date('2026-07-05T00:00:00.000Z');
		it('api token mode resolves to api (claude --print)', () => {
			const d = resolveClaudeSpawnModeCore(
				{ agent: CLAUDE_AGENT, tokenMode: 'api', sshEnabled: false, command: 'claude', now: NOW },
				cliShapedDeps()
			);
			expect(d.mode).toBe('api');
			expect(d.maestroPBinPath).toBeNull();
		});
		it('interactive token mode resolves to the local maestro-p TUI when present', () => {
			const d = resolveClaudeSpawnModeCore(
				{
					agent: CLAUDE_AGENT,
					tokenMode: 'interactive',
					sshEnabled: false,
					command: 'claude',
					now: NOW,
				},
				cliShapedDeps()
			);
			expect(d.mode).toBe('interactive');
			expect(d.maestroPBinPath).toBe('/bundle/maestro-p.js');
			expect(d.claudeRealBinPath).toBe('claude');
		});
		it('interactive falls back to api when no maestro-p binary is found', () => {
			const d = resolveClaudeSpawnModeCore(
				{
					agent: CLAUDE_AGENT,
					tokenMode: 'interactive',
					sshEnabled: false,
					command: 'claude',
					now: NOW,
				},
				cliShapedDeps({ getMaestroPBinPath: () => null })
			);
			expect(d.mode).toBe('api');
			expect(d.maestroPBinPath).toBeNull();
		});
		it('dynamic with no usage snapshot resolves to interactive (CLI prefers the TUI it cannot rate-limit)', () => {
			// The standalone CLI has no SQLite snapshot, so getUsageSnapshot() => null;
			// selectMode(null) => interactive. This honors "start on TUI" for Dynamic.
			const d = resolveClaudeSpawnModeCore(
				{
					agent: CLAUDE_AGENT,
					tokenMode: 'dynamic',
					sshEnabled: false,
					command: 'claude',
					now: NOW,
				},
				cliShapedDeps()
			);
			expect(d.mode).toBe('interactive');
			expect(d.maestroPBinPath).toBe('/bundle/maestro-p.js');
		});
		it('non-claude agents always resolve to api', () => {
			const d = resolveClaudeSpawnModeCore(
				{
					agent: { id: 'codex' },
					tokenMode: 'interactive',
					sshEnabled: false,
					command: 'codex',
					now: NOW,
				},
				cliShapedDeps()
			);
			expect(d.mode).toBe('api');
		});
		it('SSH interactive resolves to a remote maestro-p spawn (optimistic when unprobed)', () => {
			const d = resolveClaudeSpawnModeCore(
				{
					agent: CLAUDE_AGENT,
					tokenMode: 'interactive',
					sshEnabled: true,
					sshRemoteId: 'r1',
					command: 'claude',
					now: NOW,
				},
				cliShapedDeps()
			);
			expect(d.mode).toBe('interactive');
			expect(d.remote).toBe(true);
			expect(d.maestroPBinPath).toBeNull();
		});
		it('SSH dynamic falls back to api (no remote quota signal)', () => {
			const d = resolveClaudeSpawnModeCore(
				{
					agent: CLAUDE_AGENT,
					tokenMode: 'dynamic',
					sshEnabled: true,
					sshRemoteId: 'r1',
					command: 'claude',
					now: NOW,
				},
				cliShapedDeps()
			);
			expect(d.mode).toBe('api');
		});
	});
	describe('findPackagedAppHost (#1770)', () => {
		const existsAmong =
			(...present: string[]) =>
			(p: string) =>
				present.includes(p);
		it('finds the macOS app binary beside a packaged Resources dir', () => {
			const resources = s3_path.join('/Applications', 'Maestro.app', 'Contents', 'Resources');
			const binary = s3_path.join('/Applications', 'Maestro.app', 'Contents', 'MacOS', 'Maestro');
			expect(
				findPackagedAppHost(
					resources,
					'darwin',
					existsAmong(s3_path.join(resources, 'app.asar'), binary)
				)
			).toEqual({ execPath: binary, resourcesPath: resources });
		});
		it('finds Maestro.exe on Windows and the lowercase binary on Linux', () => {
			const resources = s3_path.join('/opt', 'Maestro', 'resources');
			const asar = s3_path.join(resources, 'app.asar');
			const exe = s3_path.join('/opt', 'Maestro', 'Maestro.exe');
			const linuxBin = s3_path.join('/opt', 'Maestro', 'maestro');
			expect(findPackagedAppHost(resources, 'win32', existsAmong(asar, exe))?.execPath).toBe(exe);
			expect(findPackagedAppHost(resources, 'linux', existsAmong(asar, linuxBin))?.execPath).toBe(
				linuxBin
			);
		});
		it('returns null for a dev build with no app.asar beside the CLI', () => {
			const devCli = s3_path.join('/repo', 'dist', 'cli');
			expect(findPackagedAppHost(devCli, 'darwin', () => false)).toBeNull();
		});
		it('returns null when the app binary is missing, leaving the spawn unchanged', () => {
			const resources = s3_path.join('/Applications', 'Maestro.app', 'Contents', 'Resources');
			expect(
				findPackagedAppHost(resources, 'darwin', existsAmong(s3_path.join(resources, 'app.asar')))
			).toBeNull();
		});
	});
	describe("workspace trust for the agent's own cwd (#1872)", () => {
		const localDecision: ClaudeSpawnDecision = {
			mode: 'interactive',
			reason: 'auto',
			maestroPBinPath: '/app/maestro-p.js',
			claudeRealBinPath: '/usr/local/bin/claude',
		};
		const remoteDecision: ClaudeSpawnDecision = {
			mode: 'interactive',
			reason: 'auto',
			maestroPBinPath: null,
			remote: true,
		};
		const applyLocal = (acceptWorkspaceTrust?: boolean) =>
			applyClaudeSpawnDecision({
				decision: localDecision,
				command: 'claude',
				args: ['--print', '--', 'hi'],
				execPath: '/usr/bin/node',
				resourcesPath: '',
				acceptWorkspaceTrust,
			});
		it('matches the agent cwd or project root, ignoring trailing and doubled separators', () => {
			const agent = { cwd: '/Users/me/project/', projectRoot: '/Users/me/root' };
			expect(isAgentOwnWorkingDirectory('/Users/me/project', agent)).toBe(true);
			expect(isAgentOwnWorkingDirectory('/Users/me//root', agent)).toBe(true);
		});
		it('does not match another folder, a sibling prefix, or a missing agent', () => {
			const agent = { cwd: '/Users/me/project' };
			expect(isAgentOwnWorkingDirectory('/Users/me', agent)).toBe(false);
			expect(isAgentOwnWorkingDirectory('/Users/me/project-two', agent)).toBe(false);
			expect(isAgentOwnWorkingDirectory('/Users/me/project', undefined)).toBe(false);
			expect(isAgentOwnWorkingDirectory(undefined, agent)).toBe(false);
		});
		it('local maestro-p spawn gets the opt-in only when asked', () => {
			expect(applyLocal(true).customEnvVars?.[MAESTRO_P_ACCEPT_WORKSPACE_TRUST_ENV]).toBe('1');
			expect(applyLocal().customEnvVars).not.toHaveProperty(MAESTRO_P_ACCEPT_WORKSPACE_TRUST_ENV);
		});
		it('remote maestro-p spawn gets the opt-in only when asked', () => {
			expect(
				buildRemoteInteractiveSpawn({ decision: remoteDecision, acceptWorkspaceTrust: true })?.env
			).toEqual({ [MAESTRO_P_ACCEPT_WORKSPACE_TRUST_ENV]: '1' });
			expect(buildRemoteInteractiveSpawn({ decision: remoteDecision })?.env).toEqual({});
		});
	});
});
// Source: src/__tests__/main/agents/codex-reset-credits.test.ts
describe('', () => {
	// Unique per run: a fixed path collides with a concurrent suite in the same checkout.
	const TEST_ROOT = mkdtempSync(s4_path.join(s4_os.tmpdir(), 'maestro-codex-reset-credits-'));
	/** The shape the live endpoint actually returns, trimmed to what we parse. */
	const LIVE_CREDIT = {
		id: 'RateLimitResetCredit_2bbb734c82088191a977cd8453f280cd',
		reset_type: 'codex_rate_limits',
		is_supported_by_plan: true,
		status: 'available',
		granted_at: '2026-09-04T05:41:42.552756Z',
		expires_at: '2026-10-04T05:41:42.552756Z',
		redeem_started_at: null,
		redeemed_at: null,
		profile_user_id: 'Codex Team',
		title: 'Full reset (Weekly + 5 hr)',
		description: "Thanks for using Codex! You've been granted one free rate limit reset.",
	};
	async function writeAuth(tokens: Record<string, unknown> = {}): Promise<void> {
		await s4_fs.writeFile(
			s4_path.join(TEST_ROOT, 'auth.json'),
			JSON.stringify({
				tokens: { access_token: 'redacted-token', account_id: 'account-123', ...tokens },
			})
		);
	}
	function jsonResponse(body: unknown, status = 200): Response {
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	describe('codex-reset-credits', () => {
		beforeEach(async () => {
			await s4_fs.rm(TEST_ROOT, { recursive: true, force: true });
			await s4_fs.mkdir(TEST_ROOT, { recursive: true });
			captureMessageMock.mockReset().mockResolvedValue(undefined);
			vi.stubGlobal('fetch', vi.fn());
		});
		afterEach(async () => {
			vi.unstubAllGlobals();
			await s4_fs.rm(TEST_ROOT, { recursive: true, force: true });
		});
		describe('fetchCodexResetCredits (READ)', () => {
			it('never calls the endpoint for an account with no auth.json', async () => {
				const result = await fetchCodexResetCredits({ codexHome: TEST_ROOT });
				expect(result.ok).toBe(false);
				expect(result.error).toContain('No auth.json');
				expect(globalThis.fetch).not.toHaveBeenCalled();
			});
			it('parses the live payload into sanitized credits', async () => {
				await writeAuth();
				vi.mocked(globalThis.fetch).mockResolvedValue(
					jsonResponse({
						credits: [LIVE_CREDIT],
						available_count: 2,
						immediate_reset_purchase_eligible: false,
					})
				);
				const result = await fetchCodexResetCredits({ codexHome: TEST_ROOT });
				expect(globalThis.fetch).toHaveBeenCalledWith(
					'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits',
					expect.objectContaining({
						headers: expect.objectContaining({
							Authorization: 'Bearer redacted-token',
							'ChatGPT-Account-Id': 'account-123',
						}),
					})
				);
				expect(result.ok).toBe(true);
				expect(result.detail).toMatchObject({
					available: 2,
					purchaseEligible: false,
				});
				expect(result.detail?.credits[0]).toEqual({
					id: LIVE_CREDIT.id,
					resetType: 'codex_rate_limits',
					supportedByPlan: true,
					status: 'available',
					grantedAt: LIVE_CREDIT.granted_at,
					expiresAt: LIVE_CREDIT.expires_at,
					title: LIVE_CREDIT.title,
					description: LIVE_CREDIT.description,
					grantedBy: 'Codex Team',
				});
			});
			// Unknown and zero are different answers, and only one of them justifies
			// calling a spend wasteful.
			it('leaves an absent applicable count undefined rather than zero', async () => {
				await writeAuth();
				vi.mocked(globalThis.fetch).mockResolvedValue(
					jsonResponse({ credits: [LIVE_CREDIT], available_count: 1 })
				);
				const result = await fetchCodexResetCredits({ codexHome: TEST_ROOT });
				expect(result.detail?.applicable).toBeUndefined();
			});
			it('carries the applicable count through when present', async () => {
				await writeAuth();
				vi.mocked(globalThis.fetch).mockResolvedValue(
					jsonResponse({
						credits: [LIVE_CREDIT],
						available_count: 2,
						applicable_available_count: 0,
					})
				);
				const result = await fetchCodexResetCredits({ codexHome: TEST_ROOT });
				expect(result.detail).toMatchObject({ available: 2, applicable: 0 });
			});
			// Without an id the credit can never be redeemed, so rendering it would
			// put a dead button in the list.
			it('drops a credit with no id', async () => {
				await writeAuth();
				vi.mocked(globalThis.fetch).mockResolvedValue(
					jsonResponse({ credits: [{ status: 'available' }], available_count: 1 })
				);
				const result = await fetchCodexResetCredits({ codexHome: TEST_ROOT });
				expect(result.detail?.credits).toEqual([]);
			});
			// Only an explicit `false` is a refusal; defaulting the other way hides
			// every credit on a response that simply omits the flag.
			it('treats an omitted plan-support flag as supported', async () => {
				await writeAuth();
				vi.mocked(globalThis.fetch).mockResolvedValue(
					jsonResponse({ credits: [{ id: 'c1', status: 'available' }], available_count: 1 })
				);
				const result = await fetchCodexResetCredits({ codexHome: TEST_ROOT });
				expect(result.detail?.credits[0]?.supportedByPlan).toBe(true);
			});
			it('reports a rejected token without a Sentry breadcrumb', async () => {
				await writeAuth();
				vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({}, 401));
				const result = await fetchCodexResetCredits({ codexHome: TEST_ROOT });
				expect(result.ok).toBe(false);
				expect(result.error).toContain('codex login');
				expect(captureMessageMock).not.toHaveBeenCalled();
			});
			it('reports an unexpected HTTP status to Sentry', async () => {
				await writeAuth();
				vi.mocked(globalThis.fetch).mockResolvedValue(jsonResponse({}, 418));
				await fetchCodexResetCredits({ codexHome: TEST_ROOT });
				expect(captureMessageMock).toHaveBeenCalledWith(
					'codex reset-credit read failed',
					'warning',
					expect.objectContaining({ status: 418 })
				);
			});
			it('resolves rather than throwing when the network is down', async () => {
				await writeAuth();
				vi.mocked(globalThis.fetch).mockRejectedValue(new Error('ENOTFOUND'));
				const result = await fetchCodexResetCredits({ codexHome: TEST_ROOT });
				expect(result.ok).toBe(false);
				expect(result.error).toContain('Failed to reach');
			});
		});
		describe('consumeCodexResetCredit (WRITE)', () => {
			it('posts credit_id and redeem_request_id, and reports the reset', async () => {
				await writeAuth();
				vi.mocked(globalThis.fetch).mockResolvedValue(
					jsonResponse({ code: 'ok', credit: LIVE_CREDIT, windows_reset: 2 })
				);
				const result = await consumeCodexResetCredit({
					codexHome: TEST_ROOT,
					creditId: 'credit-abc',
					idempotencyKey: 'stable-key',
				});
				const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
				expect(url).toBe('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume');
				expect((init as RequestInit).method).toBe('POST');
				expect(JSON.parse((init as RequestInit).body as string)).toEqual({
					credit_id: 'credit-abc',
					redeem_request_id: 'stable-key',
				});
				expect(result).toMatchObject({ ok: true, windowsReset: 2 });
			});
			// The endpoint is REQUIRED to receive one and 400s without it, so a caller
			// that supplies none must still produce a valid request.
			it('mints an idempotency key when the caller supplies none', async () => {
				await writeAuth();
				vi.mocked(globalThis.fetch).mockResolvedValue(
					jsonResponse({ code: 'ok', windows_reset: 1 })
				);
				await consumeCodexResetCredit({ codexHome: TEST_ROOT, creditId: 'credit-abc' });
				const body = JSON.parse(
					(vi.mocked(globalThis.fetch).mock.calls[0][1] as RequestInit).body as string
				);
				expect(typeof body.redeem_request_id).toBe('string');
				expect(body.redeem_request_id.length).toBeGreaterThan(0);
			});
			// THE trap: the endpoint answers 200 for refusals, so `response.ok` alone
			// would report every failure as a success.
			it('treats a 200 with windows_reset 0 as a failure', async () => {
				await writeAuth();
				vi.mocked(globalThis.fetch).mockResolvedValue(
					jsonResponse({ code: 'no_credit', credit: null, windows_reset: 0 })
				);
				const result = await consumeCodexResetCredit({
					codexHome: TEST_ROOT,
					creditId: 'credit-gone',
				});
				expect(result.ok).toBe(false);
				expect(result.windowsReset).toBe(0);
				expect(result.code).toBe('no_credit');
				expect(result.message).toContain('no longer available');
			});
			it('refuses an empty credit id without calling the endpoint', async () => {
				await writeAuth();
				const result = await consumeCodexResetCredit({ codexHome: TEST_ROOT, creditId: '  ' });
				expect(result.ok).toBe(false);
				expect(globalThis.fetch).not.toHaveBeenCalled();
			});
			it('refuses an account with no auth without calling the endpoint', async () => {
				const result = await consumeCodexResetCredit({ codexHome: TEST_ROOT, creditId: 'c1' });
				expect(result.ok).toBe(false);
				expect(globalThis.fetch).not.toHaveBeenCalled();
			});
			// A thrown fetch leaves the spend UNDECIDED: the request may have landed,
			// so the message must not claim the credit was preserved.
			it('reports an undecided outcome when the request never completes', async () => {
				await writeAuth();
				vi.mocked(globalThis.fetch).mockRejectedValue(new Error('ECONNRESET'));
				const result = await consumeCodexResetCredit({ codexHome: TEST_ROOT, creditId: 'c1' });
				expect(result.ok).toBe(false);
				expect(result.message).toContain('may or may not have been spent');
			});
		});
	});
});
// Source: src/__tests__/main/agents/limitResetEstimator.test.ts
describe('', () => {
	/** Build a minimal usage snapshot with the two reset windows the estimator reads. */
	function snap(sessionResetsAt: string, weekResetsAt: string) {
		return {
			sampledAt: new Date().toISOString(),
			configDirKey: '/home/u/.claude',
			session: { percent: 100, resetsAt: sessionResetsAt },
			weekAllModels: { percent: 50, resetsAt: weekResetsAt },
			weekSonnetOnly: { percent: 0, resetsAt: weekResetsAt },
		};
	}
	describe('getLimitResetAt', () => {
		beforeEach(() => {
			mockGetSnapshot.mockReset();
		});
		it('returns the nearest FUTURE reset for Claude', () => {
			const now = Date.now();
			const soon = new Date(now + 60000).toISOString();
			const later = new Date(now + 3600000).toISOString();
			mockGetSnapshot.mockReturnValue(snap(soon, later));
			expect(getLimitResetAt('claude-code')).toBe(new Date(soon).getTime());
		});
		it('skips a past reset and returns the future one', () => {
			const now = Date.now();
			const past = new Date(now - 60000).toISOString();
			const future = new Date(now + 120000).toISOString();
			mockGetSnapshot.mockReturnValue(snap(past, future));
			expect(getLimitResetAt('claude-code')).toBe(new Date(future).getTime());
		});
		it('returns undefined when every reset window is already in the past (stale/expired)', () => {
			const now = Date.now();
			const past1 = new Date(now - 120000).toISOString();
			const past2 = new Date(now - 60000).toISOString();
			mockGetSnapshot.mockReturnValue(snap(past1, past2));
			expect(getLimitResetAt('claude-code')).toBeUndefined();
		});
		it('returns undefined when no snapshot is cached', () => {
			mockGetSnapshot.mockReturnValue(null);
			expect(getLimitResetAt('claude-code')).toBeUndefined();
		});
		it('returns undefined for non-Claude providers without touching the store', () => {
			expect(getLimitResetAt('codex')).toBeUndefined();
			expect(getLimitResetAt('opencode')).toBeUndefined();
			expect(mockGetSnapshot).not.toHaveBeenCalled();
		});
	});
});
// Source: src/__tests__/main/agents/remoteMaestroPCache.test.ts
describe('', () => {
	describe('remoteMaestroPCache', () => {
		beforeEach(() => {
			__clearRemoteMaestroPCache();
		});
		it('returns undefined for a never-probed remote', () => {
			expect(getRemoteMaestroPAvailable('remote-1')).toBeUndefined();
		});
		it('returns undefined for a missing/empty remote id', () => {
			expect(getRemoteMaestroPAvailable(undefined)).toBeUndefined();
			expect(getRemoteMaestroPAvailable(null)).toBeUndefined();
			expect(getRemoteMaestroPAvailable('')).toBeUndefined();
		});
		it('records and reads back availability keyed by remote id', () => {
			setRemoteMaestroPAvailable('remote-1', true);
			setRemoteMaestroPAvailable('remote-2', false);
			expect(getRemoteMaestroPAvailable('remote-1')).toBe(true);
			expect(getRemoteMaestroPAvailable('remote-2')).toBe(false);
		});
		it('ignores a set with an empty remote id', () => {
			setRemoteMaestroPAvailable('', true);
			expect(getRemoteMaestroPAvailable('')).toBeUndefined();
		});
		it('treats a never-probed (or empty) remote as stale', () => {
			expect(isRemoteMaestroPProbeStale('remote-1')).toBe(true);
			expect(isRemoteMaestroPProbeStale(undefined)).toBe(true);
		});
		it('treats a fresh result as not stale and an expired one as stale', () => {
			const t0 = 1000000;
			setRemoteMaestroPAvailable('remote-1', true, t0);
			expect(isRemoteMaestroPProbeStale('remote-1', t0 + REMOTE_MAESTRO_P_TTL_MS - 1)).toBe(false);
			expect(isRemoteMaestroPProbeStale('remote-1', t0 + REMOTE_MAESTRO_P_TTL_MS + 1)).toBe(true);
		});
	});
});
