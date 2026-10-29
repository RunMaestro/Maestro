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

import { createCodexMemorySourceResolver, readCodexMemory } from '../../main/agents/codex-memory';
import type { SessionInfo } from '../../shared/types';
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

	it.each(['direct', 'alias'])(
		"reads a Codex agent's store under its own CODEX_HOME (%s)",
		async (mode) => {
			const codexHome = path.join(tempDir, 'codex-b');
			if (mode === 'alias') {
				const realHome = path.join(tempDir, 'Codex Account');
				fs.mkdirSync(realHome);
				fs.symlinkSync(realHome, codexHome, 'junction');
			}
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
			const resolveSource = createCodexMemorySourceResolver(
				(id) => sessions.find((s) => s.id === id) as unknown as SessionInfo,
				resolveMemoryLayout
			);
			const source = await resolveSource('a1');
			expect(source.codexHome).toBe(codexHome);
			fs.mkdirSync(layout.directoryPath, { recursive: true });
			fs.writeFileSync(path.join(layout.directoryPath, 'memory_summary.md'), 'Account B memory');
			expect(await readCodexMemory(source, 'memory_summary.md')).toMatchObject({
				content: 'Account B memory',
				sourceRef: {
					sourceAgentId: 'a1',
					codexHome,
					// The configured home can be an alias (including Windows short paths).
					memoryRoot: await fs.promises.realpath(layout.directoryPath),
				},
			});
		}
	);

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
		const resolveSource = createCodexMemorySourceResolver(
			(id) => sessions.find((s) => s.id === id) as unknown as SessionInfo,
			resolveMemoryLayout
		);
		await expect(resolveSource('a1')).rejects.toThrow('Codex account memory required');
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
