/**
 * Tests for src/main/vibes/vibes-coordinator.ts
 * Validates the VIBES coordinator: ProcessManager event routing, session lifecycle,
 * agent-type-based routing, settings-driven enable/disable, and prompt forwarding.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtemp, rm } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { VibesCoordinator } from '../../../main/vibes/vibes-coordinator';
import type { VibesSettingsStore } from '../../../main/vibes/vibes-coordinator';
import { readAnnotations, readVibesManifest, ensureAuditDir } from '../../../main/vibes/vibes-io';
import { VIBES_SETTINGS_DEFAULTS } from '../../../shared/vibes-settings';
import type {
	VibesSessionRecord,
	VibesCommandEntry,
	VibesEnvironmentEntry,
	VibesPromptEntry,
} from '../../../shared/vibes-types';
import type { ProcessConfig } from '../../../main/process-manager/types';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Create a mock settings store with configurable overrides.
 */
function createMockSettingsStore(
	overrides: Record<string, unknown> = {},
): VibesSettingsStore {
	const settings: Record<string, unknown> = {
		vibesEnabled: true,
		vibesAssuranceLevel: 'medium',
		vibesPerAgentConfig: {
			'claude-code': { enabled: true },
			'codex': { enabled: true },
		},
		vibesMaestroOrchestrationEnabled: true,
		...overrides,
	};

	return {
		get<T>(key: string, defaultValue?: T): T {
			const value = settings[key];
			return (value !== undefined ? value : defaultValue) as T;
		},
	};
}

/**
 * Create a minimal ProcessConfig for testing.
 */
function createProcessConfig(
	overrides: Partial<ProcessConfig> = {},
): ProcessConfig {
	return {
		sessionId: 'sess-1',
		toolType: 'claude-code',
		cwd: '/tmp/test-project',
		command: 'claude',
		args: ['--print'],
		projectPath: '/tmp/test-project',
		...overrides,
	};
}

// ============================================================================
// Test Suite
// ============================================================================

describe('vibes-coordinator', () => {
	const FIXED_ISO = '2026-02-10T12:00:00.000Z';
	let tmpDir: string;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(FIXED_ISO));
		tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibes-coordinator-test-'));
		await ensureAuditDir(tmpDir);
	});

	afterEach(async () => {
		vi.useRealTimers();
		await rm(tmpDir, { recursive: true, force: true });
	});

	// ========================================================================
	// isEnabled
	// ========================================================================
	describe('isEnabled', () => {
		it('should return true when vibesEnabled is true in settings', () => {
			const store = createMockSettingsStore({ vibesEnabled: true });
			const coordinator = new VibesCoordinator({ settingsStore: store });
			expect(coordinator.isEnabled()).toBe(true);
		});

		it('should return false when vibesEnabled is false in settings', () => {
			const store = createMockSettingsStore({ vibesEnabled: false });
			const coordinator = new VibesCoordinator({ settingsStore: store });
			expect(coordinator.isEnabled()).toBe(false);
		});

		it('should default to false when vibesEnabled is not set', () => {
			const store: VibesSettingsStore = {
				get<T>(_key: string, defaultValue?: T): T {
					return defaultValue as T;
				},
			};
			const coordinator = new VibesCoordinator({ settingsStore: store });
			expect(coordinator.isEnabled()).toBe(false);
		});
	});

	// ========================================================================
	// isEnabledForAgent
	// ========================================================================
	describe('isEnabledForAgent', () => {
		it('should return true for claude-code when enabled in per-agent config', () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });
			expect(coordinator.isEnabledForAgent('claude-code')).toBe(true);
		});

		it('should return true for codex when enabled in per-agent config', () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });
			expect(coordinator.isEnabledForAgent('codex')).toBe(true);
		});

		it('should return false when master toggle is disabled', () => {
			const store = createMockSettingsStore({ vibesEnabled: false });
			const coordinator = new VibesCoordinator({ settingsStore: store });
			expect(coordinator.isEnabledForAgent('claude-code')).toBe(false);
		});

		it('should return false when agent is disabled in per-agent config', () => {
			const store = createMockSettingsStore({
				vibesPerAgentConfig: {
					'claude-code': { enabled: false },
					'codex': { enabled: true },
				},
			});
			const coordinator = new VibesCoordinator({ settingsStore: store });
			expect(coordinator.isEnabledForAgent('claude-code')).toBe(false);
			expect(coordinator.isEnabledForAgent('codex')).toBe(true);
		});

		it('should return false for unknown agent types without explicit config', () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });
			expect(coordinator.isEnabledForAgent('terminal')).toBe(false);
		});
	});

	// ========================================================================
	// handleProcessSpawn
	// ========================================================================
	describe('handleProcessSpawn', () => {
		it('should start a VIBES session for enabled agent types', async () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });

			const config = createProcessConfig({
				sessionId: 'sess-1',
				toolType: 'claude-code',
				projectPath: tmpDir,
			});

			await coordinator.handleProcessSpawn('sess-1', config);

			const stats = coordinator.getSessionStats('sess-1');
			expect(stats).not.toBeNull();
			expect(stats!.assuranceLevel).toBe('medium');
			expect(stats!.annotationCount).toBeGreaterThanOrEqual(1);
		});

		it('should write session start annotation', async () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });

			const config = createProcessConfig({
				sessionId: 'sess-1',
				toolType: 'claude-code',
				projectPath: tmpDir,
			});

			await coordinator.handleProcessSpawn('sess-1', config);

			const annotations = await readAnnotations(tmpDir);
			expect(annotations.length).toBeGreaterThanOrEqual(1);

			const startRecord = annotations[0] as VibesSessionRecord;
			expect(startRecord.type).toBe('session');
			expect(startRecord.event).toBe('start');
		});

		it('should create an environment manifest entry', async () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });

			const config = createProcessConfig({
				sessionId: 'sess-1',
				toolType: 'claude-code',
				projectPath: tmpDir,
			});

			await coordinator.handleProcessSpawn('sess-1', config);

			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const envEntries = entries.filter((e) => e.type === 'environment') as VibesEnvironmentEntry[];
			expect(envEntries).toHaveLength(1);
			expect(envEntries[0].tool_name).toBe('Claude Code');
		});

		it('should not start a session when VIBES is disabled', async () => {
			const store = createMockSettingsStore({ vibesEnabled: false });
			const coordinator = new VibesCoordinator({ settingsStore: store });

			const config = createProcessConfig({
				sessionId: 'sess-1',
				toolType: 'claude-code',
				projectPath: tmpDir,
			});

			await coordinator.handleProcessSpawn('sess-1', config);

			const stats = coordinator.getSessionStats('sess-1');
			expect(stats).toBeNull();
		});

		it('should not start a session for disabled agent types', async () => {
			const store = createMockSettingsStore({
				vibesPerAgentConfig: {
					'claude-code': { enabled: false },
				},
			});
			const coordinator = new VibesCoordinator({ settingsStore: store });

			const config = createProcessConfig({
				sessionId: 'sess-1',
				toolType: 'claude-code',
				projectPath: tmpDir,
			});

			await coordinator.handleProcessSpawn('sess-1', config);

			const stats = coordinator.getSessionStats('sess-1');
			expect(stats).toBeNull();
		});

		it('should not start a session without a project path', async () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });

			const config = createProcessConfig({
				sessionId: 'sess-1',
				toolType: 'claude-code',
				projectPath: undefined,
				cwd: '',
			});

			await coordinator.handleProcessSpawn('sess-1', config);

			const stats = coordinator.getSessionStats('sess-1');
			expect(stats).toBeNull();
		});

		it('should fall back to cwd when projectPath is not set', async () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });

			const config = createProcessConfig({
				sessionId: 'sess-1',
				toolType: 'claude-code',
				projectPath: undefined,
				cwd: tmpDir,
			});

			await coordinator.handleProcessSpawn('sess-1', config);

			const stats = coordinator.getSessionStats('sess-1');
			expect(stats).not.toBeNull();
		});

		it('should set Codex tool name for codex agents', async () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });

			const config = createProcessConfig({
				sessionId: 'sess-1',
				toolType: 'codex',
				projectPath: tmpDir,
			});

			await coordinator.handleProcessSpawn('sess-1', config);

			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const envEntries = entries.filter((e) => e.type === 'environment') as VibesEnvironmentEntry[];
			expect(envEntries).toHaveLength(1);
			expect(envEntries[0].tool_name).toBe('Codex');
		});
	});

	// ========================================================================
	// handleProcessExit
	// ========================================================================
	describe('handleProcessExit', () => {
		it('should end the VIBES session', async () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });

			const config = createProcessConfig({
				sessionId: 'sess-1',
				toolType: 'claude-code',
				projectPath: tmpDir,
			});

			await coordinator.handleProcessSpawn('sess-1', config);
			await coordinator.handleProcessExit('sess-1', 0);

			const annotations = await readAnnotations(tmpDir);
			const endRecords = annotations.filter(
				(a) => (a as VibesSessionRecord).event === 'end',
			);
			expect(endRecords).toHaveLength(1);
		});

		it('should be a no-op for unknown sessions', async () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });

			// Should not throw
			await coordinator.handleProcessExit('nonexistent', 0);
		});

		it('should be a no-op for already-ended sessions', async () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });

			const config = createProcessConfig({
				sessionId: 'sess-1',
				toolType: 'claude-code',
				projectPath: tmpDir,
			});

			await coordinator.handleProcessSpawn('sess-1', config);
			await coordinator.handleProcessExit('sess-1', 0);
			await coordinator.handleProcessExit('sess-1', 0); // second call

			const annotations = await readAnnotations(tmpDir);
			const endRecords = annotations.filter(
				(a) => (a as VibesSessionRecord).event === 'end',
			);
			expect(endRecords).toHaveLength(1);
		});
	});

	// ========================================================================
	// attachToProcessManager (Event Routing)
	// ========================================================================
	describe('attachToProcessManager', () => {
		it('should subscribe to ProcessManager events when enabled', () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });
			const emitter = new EventEmitter();

			coordinator.attachToProcessManager(emitter);

			expect(emitter.listenerCount('tool-execution')).toBe(1);
			expect(emitter.listenerCount('thinking-chunk')).toBe(1);
			expect(emitter.listenerCount('usage')).toBe(1);
		});

		it('should not subscribe when VIBES is disabled', () => {
			const store = createMockSettingsStore({ vibesEnabled: false });
			const coordinator = new VibesCoordinator({ settingsStore: store });
			const emitter = new EventEmitter();

			coordinator.attachToProcessManager(emitter);

			expect(emitter.listenerCount('tool-execution')).toBe(0);
			expect(emitter.listenerCount('thinking-chunk')).toBe(0);
			expect(emitter.listenerCount('usage')).toBe(0);
		});

		it('should route tool-execution events to Claude Code instrumenter', async () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });

			// Start a session first
			const config = createProcessConfig({
				sessionId: 'sess-1',
				toolType: 'claude-code',
				projectPath: tmpDir,
			});
			await coordinator.handleProcessSpawn('sess-1', config);

			// Call handleToolExecution directly (the EventEmitter listener routes to this)
			await coordinator.handleToolExecution('sess-1', {
				toolName: 'Read',
				state: { status: 'running', input: { file_path: 'src/main.ts' } },
				timestamp: Date.now(),
			});

			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries.length).toBeGreaterThanOrEqual(1);
		});

		it('should route tool-execution events to Codex instrumenter', async () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });

			const config = createProcessConfig({
				sessionId: 'sess-1',
				toolType: 'codex',
				projectPath: tmpDir,
			});
			await coordinator.handleProcessSpawn('sess-1', config);

			await coordinator.handleToolExecution('sess-1', {
				toolName: 'read_file',
				state: { status: 'running', input: { file_path: 'src/main.ts' } },
				timestamp: Date.now(),
			});

			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const cmdEntries = entries.filter((e) => e.type === 'command') as VibesCommandEntry[];
			expect(cmdEntries.length).toBeGreaterThanOrEqual(1);
		});

		it('should ignore events for sessions without active VIBES sessions', async () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });
			const emitter = new EventEmitter();

			coordinator.attachToProcessManager(emitter);

			// Emit events without starting a session — should not throw
			emitter.emit('tool-execution', 'unknown-sess', {
				toolName: 'Read',
				state: {},
				timestamp: Date.now(),
			});
			emitter.emit('thinking-chunk', 'unknown-sess', 'some thinking');
			emitter.emit('usage', 'unknown-sess', {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0.01,
				contextWindow: 200000,
			});

			// No errors expected
		});
	});

	// ========================================================================
	// handlePromptSent
	// ========================================================================
	describe('handlePromptSent', () => {
		it('should forward prompts to the instrumenter at medium assurance', async () => {
			const store = createMockSettingsStore({ vibesAssuranceLevel: 'medium' });
			const coordinator = new VibesCoordinator({ settingsStore: store });

			const config = createProcessConfig({
				sessionId: 'sess-1',
				toolType: 'claude-code',
				projectPath: tmpDir,
			});
			await coordinator.handleProcessSpawn('sess-1', config);

			await coordinator.handlePromptSent('sess-1', 'Fix the login bug');

			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const promptEntries = entries.filter((e) => e.type === 'prompt') as VibesPromptEntry[];
			expect(promptEntries).toHaveLength(1);
			expect(promptEntries[0].prompt_text).toBe('Fix the login bug');
		});

		it('should not record prompts at low assurance', async () => {
			const store = createMockSettingsStore({ vibesAssuranceLevel: 'low' });
			const coordinator = new VibesCoordinator({ settingsStore: store });

			const config = createProcessConfig({
				sessionId: 'sess-1',
				toolType: 'claude-code',
				projectPath: tmpDir,
			});
			await coordinator.handleProcessSpawn('sess-1', config);

			await coordinator.handlePromptSent('sess-1', 'Fix the login bug');

			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const promptEntries = entries.filter((e) => e.type === 'prompt');
			expect(promptEntries).toHaveLength(0);
		});

		it('should be a no-op for inactive sessions', async () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });

			// No session started
			await coordinator.handlePromptSent('nonexistent', 'Hello');

			const annotations = await readAnnotations(tmpDir);
			expect(annotations).toHaveLength(0);
		});

		it('should include context files when provided', async () => {
			const store = createMockSettingsStore({ vibesAssuranceLevel: 'high' });
			const coordinator = new VibesCoordinator({ settingsStore: store });

			const config = createProcessConfig({
				sessionId: 'sess-1',
				toolType: 'claude-code',
				projectPath: tmpDir,
			});
			await coordinator.handleProcessSpawn('sess-1', config);

			await coordinator.handlePromptSent('sess-1', 'Fix this', ['src/main.ts', 'src/utils.ts']);

			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			const promptEntries = entries.filter((e) => e.type === 'prompt') as VibesPromptEntry[];
			expect(promptEntries).toHaveLength(1);
			expect(promptEntries[0].prompt_context_files).toEqual(['src/main.ts', 'src/utils.ts']);
		});
	});

	// ========================================================================
	// getSessionStats
	// ========================================================================
	describe('getSessionStats', () => {
		it('should return null for unknown sessions', () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });
			expect(coordinator.getSessionStats('nonexistent')).toBeNull();
		});

		it('should return stats for active sessions', async () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });

			const config = createProcessConfig({
				sessionId: 'sess-1',
				toolType: 'claude-code',
				projectPath: tmpDir,
			});
			await coordinator.handleProcessSpawn('sess-1', config);

			vi.setSystemTime(new Date('2026-02-10T12:00:10.000Z'));

			const stats = coordinator.getSessionStats('sess-1');
			expect(stats).not.toBeNull();
			expect(stats!.duration).toBe(10000);
			expect(stats!.assuranceLevel).toBe('medium');
			expect(stats!.annotationCount).toBeGreaterThanOrEqual(1);
		});
	});

	// ========================================================================
	// getMaestroInstrumenter
	// ========================================================================
	describe('getMaestroInstrumenter', () => {
		it('should return the Maestro instrumenter instance', () => {
			const store = createMockSettingsStore();
			const coordinator = new VibesCoordinator({ settingsStore: store });
			const instrumenter = coordinator.getMaestroInstrumenter();
			expect(instrumenter).toBeDefined();
		});
	});

	// ========================================================================
	// Integration: Full Session Lifecycle with Events
	// ========================================================================
	describe('integration', () => {
		it('should handle a complete session lifecycle with tool events', async () => {
			const store = createMockSettingsStore({ vibesAssuranceLevel: 'medium' });
			const coordinator = new VibesCoordinator({ settingsStore: store });

			// 1. Spawn process
			const config = createProcessConfig({
				sessionId: 'sess-1',
				toolType: 'claude-code',
				projectPath: tmpDir,
			});
			await coordinator.handleProcessSpawn('sess-1', config);

			// 2. Send prompt
			await coordinator.handlePromptSent('sess-1', 'Add a logout button');

			// 3. Execute tool events directly
			await coordinator.handleToolExecution('sess-1', {
				toolName: 'Read',
				state: { status: 'running', input: { file_path: 'src/App.tsx' } },
				timestamp: Date.now(),
			});

			await coordinator.handleToolExecution('sess-1', {
				toolName: 'Write',
				state: { status: 'running', input: { file_path: 'src/App.tsx' } },
				timestamp: Date.now(),
			});

			// 4. Exit process
			await coordinator.handleProcessExit('sess-1', 0);

			// 5. Verify annotations
			const annotations = await readAnnotations(tmpDir);
			const sessionStarts = annotations.filter(
				(a) => (a as VibesSessionRecord).event === 'start',
			);
			const sessionEnds = annotations.filter(
				(a) => (a as VibesSessionRecord).event === 'end',
			);
			expect(sessionStarts).toHaveLength(1);
			expect(sessionEnds).toHaveLength(1);

			// 6. Verify manifest has entries
			const manifest = await readVibesManifest(tmpDir);
			const entries = Object.values(manifest.entries);
			expect(entries.length).toBeGreaterThanOrEqual(1);

			// Should have environment + command + prompt entries
			const envEntries = entries.filter((e) => e.type === 'environment');
			const cmdEntries = entries.filter((e) => e.type === 'command');
			const promptEntries = entries.filter((e) => e.type === 'prompt');
			expect(envEntries).toHaveLength(1);
			expect(cmdEntries.length).toBeGreaterThanOrEqual(2);
			expect(promptEntries).toHaveLength(1);
		});

		it('should handle multiple concurrent sessions', async () => {
			const tmpDir2 = await mkdtemp(path.join(os.tmpdir(), 'vibes-coordinator-test2-'));
			await ensureAuditDir(tmpDir2);

			try {
				const store = createMockSettingsStore();
				const coordinator = new VibesCoordinator({ settingsStore: store });

				// Start two sessions
				const config1 = createProcessConfig({
					sessionId: 'sess-1',
					toolType: 'claude-code',
					projectPath: tmpDir,
				});
				const config2 = createProcessConfig({
					sessionId: 'sess-2',
					toolType: 'codex',
					projectPath: tmpDir2,
				});

				await coordinator.handleProcessSpawn('sess-1', config1);
				await coordinator.handleProcessSpawn('sess-2', config2);

				expect(coordinator.getSessionStats('sess-1')).not.toBeNull();
				expect(coordinator.getSessionStats('sess-2')).not.toBeNull();

				// End both
				await coordinator.handleProcessExit('sess-1', 0);
				await coordinator.handleProcessExit('sess-2', 0);

				// Both projects should have annotations
				const ann1 = await readAnnotations(tmpDir);
				const ann2 = await readAnnotations(tmpDir2);
				expect(ann1.length).toBeGreaterThanOrEqual(2); // start + end
				expect(ann2.length).toBeGreaterThanOrEqual(2); // start + end
			} finally {
				await rm(tmpDir2, { recursive: true, force: true });
			}
		});
	});
});
