/**
 * Tests for src/main/vibes/vibes-session.ts
 * Validates the VIBES session manager: session lifecycle, annotation recording,
 * manifest entry recording, and session stats.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { VibesSessionManager } from '../../../main/vibes/vibes-session';
import type { VibesSessionState } from '../../../main/vibes/vibes-session';
import { readAnnotations, readVibesManifest, ensureAuditDir, flushAll, resetAllBuffers } from '../../../main/vibes/vibes-io';
import type {
	VibesLineAnnotation,
	VibesSessionRecord,
	VibesEnvironmentEntry,
	VibesCommandEntry,
} from '../../../shared/vibes-types';

// ============================================================================
// Test Suite
// ============================================================================

describe('vibes-session', () => {
	const FIXED_ISO = '2026-02-10T12:00:00.000Z';
	let tmpDir: string;
	let manager: VibesSessionManager;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FIXED_ISO));
		tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibes-session-test-'));
		await ensureAuditDir(tmpDir);
		manager = new VibesSessionManager();
	});

	afterEach(async () => {
		resetAllBuffers();
		vi.useRealTimers();
		await rm(tmpDir, { recursive: true, force: true });
	});

	// ========================================================================
	// startSession
	// ========================================================================
	describe('startSession', () => {
		it('should create a session state with correct fields', async () => {
			const state = await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');

			expect(state.sessionId).toBe('sess-1');
			expect(state.vibesSessionId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
			);
			expect(state.projectPath).toBe(tmpDir);
			expect(state.agentType).toBe('claude-code');
			expect(state.assuranceLevel).toBe('medium');
			expect(state.environmentHash).toBeNull();
			expect(state.annotationCount).toBe(1); // session start annotation
			expect(state.startedAt).toBe(FIXED_ISO);
			expect(state.isActive).toBe(true);
		});

		it('should write a session start annotation to annotations.jsonl', async () => {
			const state = await manager.startSession('sess-1', tmpDir, 'claude-code', 'high');

			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toHaveLength(1);

			const record = annotations[0] as VibesSessionRecord;
			expect(record.type).toBe('session');
			expect(record.event).toBe('start');
			expect(record.session_id).toBe(state.vibesSessionId);
			expect(record.assurance_level).toBe('high');
			expect(record.description).toBe('claude-code agent session');
			expect(record.timestamp).toBe(FIXED_ISO);
		});

		it('should support multiple concurrent sessions', async () => {
			const state1 = await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			const state2 = await manager.startSession('sess-2', tmpDir, 'codex', 'low');

			expect(state1.sessionId).toBe('sess-1');
			expect(state2.sessionId).toBe('sess-2');
			expect(state1.vibesSessionId).not.toBe(state2.vibesSessionId);
			expect(manager.getActiveSessionCount()).toBe(2);
		});

		it('should support all assurance levels', async () => {
			const levels: Array<'low' | 'medium' | 'high'> = ['low', 'medium', 'high'];
			for (let i = 0; i < levels.length; i++) {
				const state = await manager.startSession(`sess-${i}`, tmpDir, 'claude-code', levels[i]);
				expect(state.assuranceLevel).toBe(levels[i]);
			}
		});

		it('should include environment_hash in session start annotation when provided', async () => {
			const envHash = 'a'.repeat(64);
			const state = await manager.startSession('sess-env', tmpDir, 'claude-code', 'medium', envHash);

			expect(state.environmentHash).toBe(envHash);

			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toHaveLength(1);

			const record = annotations[0] as VibesSessionRecord;
			expect(record.type).toBe('session');
			expect(record.event).toBe('start');
			expect(record.environment_hash).toBe(envHash);
		});

		it('should omit environment_hash from session start annotation when not provided', async () => {
			await manager.startSession('sess-no-env', tmpDir, 'claude-code', 'medium');

			const annotations = await readAnnotations(tmpDir);
			const record = annotations[0] as VibesSessionRecord;
			expect(record.environment_hash).toBeUndefined();
		});
	});

	// ========================================================================
	// endSession
	// ========================================================================
	describe('endSession', () => {
		it('should write a session end annotation', async () => {
			const state = await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			await manager.endSession('sess-1');

			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toHaveLength(2);

			const endRecord = annotations[1] as VibesSessionRecord;
			expect(endRecord.type).toBe('session');
			expect(endRecord.event).toBe('end');
			expect(endRecord.session_id).toBe(state.vibesSessionId);
			expect(endRecord.assurance_level).toBe('medium');
			expect(endRecord.description).toBe('claude-code agent session ended');
		});

		it('should mark the session as inactive', async () => {
			await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			expect(manager.isSessionActive('sess-1')).toBe(true);

			await manager.endSession('sess-1');
			expect(manager.isSessionActive('sess-1')).toBe(false);
		});

		it('should include environmentHash in end annotation when set', async () => {
			const state = await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			// Simulate setting environment hash externally
			state.environmentHash = 'e'.repeat(64);

			await manager.endSession('sess-1');

			const annotations = await readAnnotations(tmpDir);
			const endRecord = annotations[1] as VibesSessionRecord;
			expect(endRecord.environment_hash).toBe('e'.repeat(64));
		});

		it('should be a no-op for unknown session IDs', async () => {
			// Should not throw
			await manager.endSession('nonexistent');

			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toHaveLength(0);
		});

		it('should be a no-op for already-ended sessions', async () => {
			await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			await manager.endSession('sess-1');
			await manager.endSession('sess-1'); // second end call

			const annotations = await readAnnotations(tmpDir);
			// Only start + one end, not two ends
			expect(annotations).toHaveLength(2);
		});

		it('should increment annotation count for end record', async () => {
			await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			await manager.endSession('sess-1');

			const state = manager.getSession('sess-1');
			expect(state).not.toBeNull();
			expect(state!.annotationCount).toBe(2); // start + end
		});
	});

	// ========================================================================
	// getSession
	// ========================================================================
	describe('getSession', () => {
		it('should return the session state for an existing session', async () => {
			await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			const state = manager.getSession('sess-1');

			expect(state).not.toBeNull();
			expect(state!.sessionId).toBe('sess-1');
		});

		it('should return null for a non-existent session', () => {
			const state = manager.getSession('nonexistent');
			expect(state).toBeNull();
		});
	});

	// ========================================================================
	// isSessionActive
	// ========================================================================
	describe('isSessionActive', () => {
		it('should return true for active sessions', async () => {
			await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			expect(manager.isSessionActive('sess-1')).toBe(true);
		});

		it('should return false for ended sessions', async () => {
			await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			await manager.endSession('sess-1');
			expect(manager.isSessionActive('sess-1')).toBe(false);
		});

		it('should return false for unknown session IDs', () => {
			expect(manager.isSessionActive('nonexistent')).toBe(false);
		});
	});

	// ========================================================================
	// recordAnnotation
	// ========================================================================
	describe('recordAnnotation', () => {
		it('should append an annotation to annotations.jsonl', async () => {
			await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');

			const lineAnnotation: VibesLineAnnotation = {
				type: 'line',
				file_path: 'src/index.ts',
				line_start: 1,
				line_end: 10,
				environment_hash: 'e'.repeat(64),
				action: 'create',
				timestamp: FIXED_ISO,
				assurance_level: 'medium',
			};

			await manager.recordAnnotation('sess-1', lineAnnotation);

			const annotations = await readAnnotations(tmpDir);
			// session start + line annotation
			expect(annotations).toHaveLength(2);
			expect(annotations[1]).toEqual(lineAnnotation);
		});

		it('should increment the annotation count', async () => {
			await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');

			const lineAnnotation: VibesLineAnnotation = {
				type: 'line',
				file_path: 'src/main.ts',
				line_start: 5,
				line_end: 15,
				environment_hash: 'e'.repeat(64),
				action: 'modify',
				timestamp: FIXED_ISO,
				assurance_level: 'medium',
			};

			await manager.recordAnnotation('sess-1', lineAnnotation);
			await manager.recordAnnotation('sess-1', lineAnnotation);

			const state = manager.getSession('sess-1');
			expect(state!.annotationCount).toBe(3); // start + 2 line annotations
		});

		it('should be a no-op for inactive sessions', async () => {
			await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			await manager.endSession('sess-1');

			const lineAnnotation: VibesLineAnnotation = {
				type: 'line',
				file_path: 'src/main.ts',
				line_start: 1,
				line_end: 1,
				environment_hash: 'e'.repeat(64),
				action: 'create',
				timestamp: FIXED_ISO,
				assurance_level: 'medium',
			};

			await manager.recordAnnotation('sess-1', lineAnnotation);

			const annotations = await readAnnotations(tmpDir);
			// Only start + end, no extra annotation
			expect(annotations).toHaveLength(2);
		});

		it('should be a no-op for unknown session IDs', async () => {
			const lineAnnotation: VibesLineAnnotation = {
				type: 'line',
				file_path: 'src/main.ts',
				line_start: 1,
				line_end: 1,
				environment_hash: 'e'.repeat(64),
				action: 'create',
				timestamp: FIXED_ISO,
				assurance_level: 'medium',
			};

			await manager.recordAnnotation('nonexistent', lineAnnotation);

			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toHaveLength(0);
		});
	});

	// ========================================================================
	// recordManifestEntry
	// ========================================================================
	describe('recordManifestEntry', () => {
		it('should add an entry to the manifest', async () => {
			await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');

			const envEntry: VibesEnvironmentEntry = {
				type: 'environment',
				tool_name: 'Claude Code',
				tool_version: '1.0',
				model_name: 'claude-4',
				model_version: 'opus',
				created_at: FIXED_ISO,
			};
			const hash = 'e'.repeat(64);

			await manager.recordManifestEntry('sess-1', hash, envEntry);
			await flushAll();

			const manifest = await readVibesManifest(tmpDir);
			expect(manifest.entries[hash]).toEqual(envEntry);
		});

		it('should be a no-op for inactive sessions', async () => {
			await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			await manager.endSession('sess-1');

			const cmdEntry: VibesCommandEntry = {
				type: 'command',
				command_text: 'npm test',
				command_type: 'shell',
				created_at: FIXED_ISO,
			};

			await manager.recordManifestEntry('sess-1', 'c'.repeat(64), cmdEntry);
			await flushAll();

			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(0);
		});

		it('should be a no-op for unknown session IDs', async () => {
			const envEntry: VibesEnvironmentEntry = {
				type: 'environment',
				tool_name: 'Test',
				tool_version: '1.0',
				model_name: 'test',
				model_version: '1.0',
				created_at: FIXED_ISO,
			};

			await manager.recordManifestEntry('nonexistent', 'e'.repeat(64), envEntry);
			await flushAll();

			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(0);
		});

		it('should support adding multiple entries', async () => {
			await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');

			const envEntry: VibesEnvironmentEntry = {
				type: 'environment',
				tool_name: 'Claude Code',
				tool_version: '1.0',
				model_name: 'claude-4',
				model_version: 'opus',
				created_at: FIXED_ISO,
			};

			const cmdEntry: VibesCommandEntry = {
				type: 'command',
				command_text: 'npm test',
				command_type: 'shell',
				created_at: FIXED_ISO,
			};

			await manager.recordManifestEntry('sess-1', 'e'.repeat(64), envEntry);
			await manager.recordManifestEntry('sess-1', 'c'.repeat(64), cmdEntry);
			await flushAll();

			const manifest = await readVibesManifest(tmpDir);
			expect(Object.keys(manifest.entries)).toHaveLength(2);
			expect(manifest.entries['e'.repeat(64)]).toEqual(envEntry);
			expect(manifest.entries['c'.repeat(64)]).toEqual(cmdEntry);
		});
	});

	// ========================================================================
	// updateEnvironmentHash
	// ========================================================================
	describe('updateEnvironmentHash', () => {
		it('should update the environment hash on an active session', async () => {
			const state = await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			expect(state.environmentHash).toBeNull();

			manager.updateEnvironmentHash('sess-1', 'a'.repeat(64));

			const updated = manager.getSession('sess-1');
			expect(updated!.environmentHash).toBe('a'.repeat(64));
		});

		it('should allow replacing an existing environment hash', async () => {
			const state = await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			state.environmentHash = 'b'.repeat(64);

			manager.updateEnvironmentHash('sess-1', 'c'.repeat(64));

			expect(state.environmentHash).toBe('c'.repeat(64));
		});

		it('should be a no-op for inactive sessions', async () => {
			const state = await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			state.environmentHash = 'b'.repeat(64);
			await manager.endSession('sess-1');

			manager.updateEnvironmentHash('sess-1', 'd'.repeat(64));

			// Should not have changed because session is inactive
			expect(state.environmentHash).toBe('b'.repeat(64));
		});

		it('should be a no-op for unknown sessions', () => {
			// Should not throw
			manager.updateEnvironmentHash('nonexistent', 'a'.repeat(64));
		});
	});

	// ========================================================================
	// getActiveSessionCount
	// ========================================================================
	describe('getActiveSessionCount', () => {
		it('should return 0 when no sessions exist', () => {
			expect(manager.getActiveSessionCount()).toBe(0);
		});

		it('should count active sessions correctly', async () => {
			await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			expect(manager.getActiveSessionCount()).toBe(1);

			await manager.startSession('sess-2', tmpDir, 'codex', 'low');
			expect(manager.getActiveSessionCount()).toBe(2);
		});

		it('should not count ended sessions', async () => {
			await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			await manager.startSession('sess-2', tmpDir, 'codex', 'low');
			expect(manager.getActiveSessionCount()).toBe(2);

			await manager.endSession('sess-1');
			expect(manager.getActiveSessionCount()).toBe(1);

			await manager.endSession('sess-2');
			expect(manager.getActiveSessionCount()).toBe(0);
		});
	});

	// ========================================================================
	// getSessionStats
	// ========================================================================
	describe('getSessionStats', () => {
		it('should return null for non-existent sessions', () => {
			const stats = manager.getSessionStats('nonexistent');
			expect(stats).toBeNull();
		});

		it('should return correct stats for an active session', async () => {
			await manager.startSession('sess-1', tmpDir, 'claude-code', 'high');

			// Advance time by 5 seconds
			vi.setSystemTime(new Date('2026-02-10T12:00:05.000Z'));

			const stats = manager.getSessionStats('sess-1');
			expect(stats).not.toBeNull();
			expect(stats!.annotationCount).toBe(1); // session start
			expect(stats!.duration).toBe(5000);
			expect(stats!.assuranceLevel).toBe('high');
		});

		it('should reflect accumulated annotations in stats', async () => {
			await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');

			const lineAnnotation: VibesLineAnnotation = {
				type: 'line',
				file_path: 'src/index.ts',
				line_start: 1,
				line_end: 10,
				environment_hash: 'e'.repeat(64),
				action: 'create',
				timestamp: FIXED_ISO,
				assurance_level: 'medium',
			};

			await manager.recordAnnotation('sess-1', lineAnnotation);
			await manager.recordAnnotation('sess-1', lineAnnotation);

			const stats = manager.getSessionStats('sess-1');
			expect(stats!.annotationCount).toBe(3); // start + 2 line annotations
		});

		it('should return stats for ended sessions', async () => {
			await manager.startSession('sess-1', tmpDir, 'claude-code', 'low');
			await manager.endSession('sess-1');

			const stats = manager.getSessionStats('sess-1');
			expect(stats).not.toBeNull();
			expect(stats!.annotationCount).toBe(2); // start + end
			expect(stats!.assuranceLevel).toBe('low');
		});
	});

	// ========================================================================
	// onAnnotationRecorded callback
	// ========================================================================
	describe('onAnnotationRecorded callback', () => {
		it('should invoke callback on session start', async () => {
			const callback = vi.fn();
			const mgr = new VibesSessionManager({ onAnnotationRecorded: callback });

			await mgr.startSession('sess-1', tmpDir, 'claude-code', 'medium');

			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith('sess-1', {
				annotationCount: 1,
				lastAnnotation: expect.objectContaining({
					type: 'session',
					event: 'start',
				}),
			});
		});

		it('should invoke callback on session end', async () => {
			const callback = vi.fn();
			const mgr = new VibesSessionManager({ onAnnotationRecorded: callback });

			await mgr.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			callback.mockClear();

			await mgr.endSession('sess-1');

			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith('sess-1', {
				annotationCount: 2,
				lastAnnotation: expect.objectContaining({
					type: 'session',
					event: 'end',
				}),
			});
		});

		it('should invoke callback on recordAnnotation', async () => {
			const callback = vi.fn();
			const mgr = new VibesSessionManager({ onAnnotationRecorded: callback });

			await mgr.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			callback.mockClear();

			const lineAnnotation: VibesLineAnnotation = {
				type: 'line',
				file_path: 'src/index.ts',
				line_start: 1,
				line_end: 10,
				environment_hash: 'e'.repeat(64),
				action: 'create',
				timestamp: FIXED_ISO,
				assurance_level: 'medium',
			};

			await mgr.recordAnnotation('sess-1', lineAnnotation);

			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith('sess-1', {
				annotationCount: 2, // start + line
				lastAnnotation: lineAnnotation,
			});
		});

		it('should not invoke callback for inactive or unknown sessions', async () => {
			const callback = vi.fn();
			const mgr = new VibesSessionManager({ onAnnotationRecorded: callback });

			const lineAnnotation: VibesLineAnnotation = {
				type: 'line',
				file_path: 'src/index.ts',
				line_start: 1,
				line_end: 10,
				environment_hash: 'e'.repeat(64),
				action: 'create',
				timestamp: FIXED_ISO,
				assurance_level: 'medium',
			};

			// Unknown session
			await mgr.recordAnnotation('nonexistent', lineAnnotation);
			expect(callback).not.toHaveBeenCalled();
		});

		it('should work without callback (backward compatibility)', async () => {
			// No callback - should not throw
			const mgr = new VibesSessionManager();
			await mgr.startSession('sess-1', tmpDir, 'claude-code', 'medium');

			const state = mgr.getSession('sess-1');
			expect(state).not.toBeNull();
			expect(state!.annotationCount).toBe(1);
		});
	});

	// ========================================================================
	// Integration: Full Session Lifecycle
	// ========================================================================
	describe('integration', () => {
		it('should support a full session lifecycle with annotations and manifest entries', async () => {
			// 1. Start session
			const state = await manager.startSession('sess-1', tmpDir, 'claude-code', 'medium');
			expect(state.isActive).toBe(true);

			// 2. Record environment manifest entry
			const envEntry: VibesEnvironmentEntry = {
				type: 'environment',
				tool_name: 'Claude Code',
				tool_version: '1.0',
				model_name: 'claude-4',
				model_version: 'opus',
				created_at: FIXED_ISO,
			};
			const envHash = 'e'.repeat(64);
			await manager.recordManifestEntry('sess-1', envHash, envEntry);
			state.environmentHash = envHash;

			// 3. Record a line annotation
			const lineAnnotation: VibesLineAnnotation = {
				type: 'line',
				file_path: 'src/index.ts',
				line_start: 1,
				line_end: 25,
				environment_hash: envHash,
				action: 'create',
				timestamp: FIXED_ISO,
				session_id: state.vibesSessionId,
				assurance_level: 'medium',
			};
			await manager.recordAnnotation('sess-1', lineAnnotation);

			// 4. End session
			await manager.endSession('sess-1');

			// 5. Verify annotations
			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toHaveLength(3); // start + line + end

			const startRecord = annotations[0] as VibesSessionRecord;
			expect(startRecord.type).toBe('session');
			expect(startRecord.event).toBe('start');

			expect(annotations[1]).toEqual(lineAnnotation);

			const endRecord = annotations[2] as VibesSessionRecord;
			expect(endRecord.type).toBe('session');
			expect(endRecord.event).toBe('end');
			expect(endRecord.environment_hash).toBe(envHash);

			// 6. Verify manifest
			await flushAll();
			const manifest = await readVibesManifest(tmpDir);
			expect(manifest.entries[envHash]).toEqual(envEntry);

			// 7. Verify stats
			const stats = manager.getSessionStats('sess-1');
			expect(stats!.annotationCount).toBe(3);
			expect(stats!.assuranceLevel).toBe('medium');

			// 8. Session is no longer active
			expect(manager.isSessionActive('sess-1')).toBe(false);
			expect(manager.getActiveSessionCount()).toBe(0);
		});

		it('should support multiple concurrent sessions to different projects', async () => {
			const tmpDir2 = await mkdtemp(path.join(os.tmpdir(), 'vibes-session-test2-'));
			await ensureAuditDir(tmpDir2);

			try {
				await manager.startSession('sess-1', tmpDir, 'claude-code', 'high');
				await manager.startSession('sess-2', tmpDir2, 'codex', 'low');

				expect(manager.getActiveSessionCount()).toBe(2);

				// Record annotation to each project
				const annotation1: VibesLineAnnotation = {
					type: 'line',
					file_path: 'src/a.ts',
					line_start: 1,
					line_end: 5,
					environment_hash: 'e'.repeat(64),
					action: 'create',
					timestamp: FIXED_ISO,
					assurance_level: 'high',
				};
				const annotation2: VibesLineAnnotation = {
					type: 'line',
					file_path: 'src/b.ts',
					line_start: 10,
					line_end: 20,
					environment_hash: 'f'.repeat(64),
					action: 'modify',
					timestamp: FIXED_ISO,
					assurance_level: 'low',
				};

				await manager.recordAnnotation('sess-1', annotation1);
				await manager.recordAnnotation('sess-2', annotation2);

				// Each project should have its own annotations
				const ann1 = await readAnnotations(tmpDir);
				const ann2 = await readAnnotations(tmpDir2);
				// sess-1: start + line annotation
				expect(ann1).toHaveLength(2);
				// sess-2: start + line annotation
				expect(ann2).toHaveLength(2);

				await manager.endSession('sess-1');
				await manager.endSession('sess-2');

				expect(manager.getActiveSessionCount()).toBe(0);
			} finally {
				await rm(tmpDir2, { recursive: true, force: true });
			}
		});
	});
});
