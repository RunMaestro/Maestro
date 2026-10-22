/**
 * Tests for memory-location.ts - which store a Memory Viewer request resolves to.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let sessions: Array<Record<string, unknown>> = [];

vi.mock('../../main/stores/instances', () => ({ isInitialized: () => true }));
vi.mock('../../main/stores/getters', () => ({
	getSessionsStore: () => ({ get: () => sessions }),
	getSettingsStore: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
	getAgentConfigsStore: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
}));
vi.mock('../../main/utils/remote-git', () => ({
	execGitReadOnly: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: '' })),
}));

import { resolveMemoryLayout } from '../../main/memory-location';

let tempDir: string;

describe('resolveMemoryLayout', () => {
	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-memory-location-'));
		sessions = [];
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("reads a Codex agent's store under its own CODEX_HOME", async () => {
		const codexHome = path.join(tempDir, 'codex-b');
		const projectPath = path.join(tempDir, 'project');
		sessions = [
			{
				id: 'a1',
				toolType: 'codex',
				projectRoot: projectPath,
				customEnvVars: { CODEX_HOME: codexHome },
			},
		];
		const layout = await resolveMemoryLayout({ projectPath, toolType: 'codex', agentId: 'a1' });
		expect(layout.directoryPath).toBe(path.join(codexHome, 'memories'));
		expect(layout.scope).toBe('account');
	});

	it('prefers the translation-managed knowledge directory over the native store', async () => {
		const projectPath = path.join(tempDir, 'project');
		const managed = path.join(projectPath, '.maestro', 'knowledge');
		sessions = [
			{
				id: 'a1',
				toolType: 'codex',
				projectRoot: projectPath,
				providerTranslationKnowledgeDirectory: managed,
			},
		];
		const layout = await resolveMemoryLayout({ projectPath, toolType: 'codex', agentId: 'a1' });
		expect(layout.directoryPath).toBe(path.join(managed, 'memory'));
		expect(layout.nested).toBe(false);
	});

	it('refuses a project path that is not the agent root', async () => {
		sessions = [{ id: 'a1', toolType: 'claude-code', projectRoot: path.join(tempDir, 'one') }];
		await expect(
			resolveMemoryLayout({
				projectPath: path.join(tempDir, 'two'),
				toolType: 'claude-code',
				agentId: 'a1',
			})
		).rejects.toThrow('Memory scope does not match');
	});

	it('refuses an SSH agent instead of reading local memory', async () => {
		const projectPath = path.join(tempDir, 'project');
		sessions = [
			{
				id: 'a1',
				toolType: 'claude-code',
				projectRoot: projectPath,
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
			},
		];
		await expect(
			resolveMemoryLayout({ projectPath, toolType: 'claude-code', agentId: 'a1' })
		).rejects.toThrow('SSH remote');
	});

	it("honors the Claude account's autoMemoryDirectory setting", async () => {
		const projectPath = path.join(tempDir, 'project');
		const claudeDir = path.join(tempDir, 'claude-b');
		fs.mkdirSync(claudeDir, { recursive: true });
		fs.writeFileSync(
			path.join(claudeDir, 'settings.json'),
			JSON.stringify({ autoMemoryDirectory: 'notes/memory' })
		);
		sessions = [
			{
				id: 'a1',
				toolType: 'claude-code',
				projectRoot: projectPath,
				customEnvVars: { CLAUDE_CONFIG_DIR: claudeDir },
			},
		];
		const layout = await resolveMemoryLayout({
			projectPath,
			toolType: 'claude-code',
			agentId: 'a1',
		});
		expect(layout.directoryPath).toBe(path.join(projectPath, 'notes', 'memory'));
	});
});
