/**
 * IPC handlers for per-project memory (Claude Code).
 *
 * Surface consumed by the renderer Memory Viewer.
 */

import { ipcMain } from 'electron';
import {
	listMemoryEntries,
	readMemoryEntry,
	writeMemoryEntry,
	createMemoryEntry,
	deleteMemoryEntry,
	getMemoryDirectoryPath,
	searchMemoryEntries,
	findOrphanMemories,
} from '../../memory-manager';
import { logger } from '../../utils/logger';

import * as path from 'node:path';
import * as os from 'node:os';
import { buildAgentEnvironment } from '../../../shared/maestro-lib/launch/env';
import { resolveAgentAccountKey } from '../../../shared/providerProfiles';
import {
	discoverClaudeMemoryPath,
	resolveMemoryRepositoryRoot,
} from '../../../shared/maestro-lib/translation/memory';
import { assertTranslationTarget } from '../../../shared/maestro-lib/translation/resource-projections';
import { execGitReadOnly } from '../../utils/remote-git';
import type { ProviderTranslationDependencies } from '../../provider-translation-service';

const LOG_CONTEXT = '[IPC:Memory]';

export function registerMemoryHandlers(
	deps?: Pick<
		ProviderTranslationDependencies,
		'sessionsStore' | 'settingsStore' | 'agentConfigsStore' | 'getAgentDetector'
	>
): void {
	const directoryFor = async (
		projectPath: string,
		agentId: string
	): Promise<string | undefined> => {
		const session = deps?.sessionsStore.get('sessions', []).find((s) => s.id === agentId);
		if (!session) return undefined;
		if (
			session.sshRemoteId ||
			path.resolve(session.projectRoot || session.cwd) !== path.resolve(projectPath)
		)
			throw new Error('Memory scope does not match the selected local agent');
		const managed = session.providerTranslationKnowledgeDirectory as string | undefined;
		if (managed) {
			await assertTranslationTarget(path.join(managed, 'memory', 'MEMORY.md'), projectPath);
			return path.join(managed, 'memory');
		}
		if (session.toolType !== 'claude-code')
			throw new Error('Native project memory is unavailable for this provider');
		const config = deps!.agentConfigsStore.get('configs', {})['claude-code'];
		const detected = await deps!.getAgentDetector()?.getAgent('claude-code');
		const env = buildAgentEnvironment({
			surface: 'desktop',
			globalShellEnvVars: deps!.settingsStore.get('shellEnvVars', {}) as Record<string, string>,
			defaultEnvVars: detected?.defaultEnvVars,
			sessionCustomEnvVars: session.customEnvVars,
			agentCustomEnvVars: config?.customEnvVars,
		});
		const accountRoot = resolveAgentAccountKey(
			'claude-code',
			env as Record<string, string>,
			os.homedir()
		);
		if (!accountRoot) throw new Error('Claude account root unavailable');
		const memoryProjectRoot = await resolveMemoryRepositoryRoot(projectPath, async (cwd) => {
			const result = await execGitReadOnly(['rev-parse', '--git-common-dir'], cwd);
			return result.exitCode === 0 ? result.stdout : undefined;
		});
		return discoverClaudeMemoryPath(projectPath, accountRoot, memoryProjectRoot);
	};
	ipcMain.handle(
		'memory:list',
		async (_event, projectPath: string, agentId: string = 'claude-code') => {
			try {
				const result = await listMemoryEntries(
					projectPath,
					agentId,
					undefined,
					await directoryFor(projectPath, agentId)
				);
				return { success: true, ...result };
			} catch (error) {
				logger.error(`Failed to list memory entries: ${error}`, LOG_CONTEXT);
				return { success: false, error: String(error) };
			}
		}
	);

	ipcMain.handle(
		'memory:read',
		async (_event, projectPath: string, filename: string, agentId: string = 'claude-code') => {
			try {
				const content = await readMemoryEntry(
					projectPath,
					filename,
					agentId,
					undefined,
					await directoryFor(projectPath, agentId)
				);
				return { success: true, content };
			} catch (error) {
				logger.error(`Failed to read memory ${filename}: ${error}`, LOG_CONTEXT);
				return { success: false, error: String(error) };
			}
		}
	);

	ipcMain.handle(
		'memory:write',
		async (
			_event,
			projectPath: string,
			filename: string,
			content: string,
			agentId: string = 'claude-code'
		) => {
			try {
				await writeMemoryEntry(
					projectPath,
					filename,
					content,
					agentId,
					undefined,
					await directoryFor(projectPath, agentId)
				);
				return { success: true };
			} catch (error) {
				logger.error(`Failed to write memory ${filename}: ${error}`, LOG_CONTEXT);
				return { success: false, error: String(error) };
			}
		}
	);

	ipcMain.handle(
		'memory:create',
		async (
			_event,
			projectPath: string,
			filename: string,
			content: string,
			agentId: string = 'claude-code'
		) => {
			try {
				await createMemoryEntry(
					projectPath,
					filename,
					content,
					agentId,
					undefined,
					await directoryFor(projectPath, agentId)
				);
				return { success: true };
			} catch (error) {
				logger.error(`Failed to create memory ${filename}: ${error}`, LOG_CONTEXT);
				return { success: false, error: String(error) };
			}
		}
	);

	ipcMain.handle(
		'memory:delete',
		async (_event, projectPath: string, filename: string, agentId: string = 'claude-code') => {
			try {
				await deleteMemoryEntry(
					projectPath,
					filename,
					agentId,
					undefined,
					await directoryFor(projectPath, agentId)
				);
				return { success: true };
			} catch (error) {
				logger.error(`Failed to delete memory ${filename}: ${error}`, LOG_CONTEXT);
				return { success: false, error: String(error) };
			}
		}
	);

	ipcMain.handle(
		'memory:search',
		async (_event, projectPath: string, query: string, agentId: string = 'claude-code') => {
			try {
				const matches = await searchMemoryEntries(
					projectPath,
					query,
					agentId,
					undefined,
					await directoryFor(projectPath, agentId)
				);
				return { success: true, matches };
			} catch (error) {
				logger.error(`Failed to search memory: ${error}`, LOG_CONTEXT);
				return { success: false, error: String(error) };
			}
		}
	);

	ipcMain.handle(
		'memory:orphans',
		async (_event, projectPath: string, agentId: string = 'claude-code') => {
			try {
				const report = await findOrphanMemories(
					projectPath,
					agentId,
					undefined,
					await directoryFor(projectPath, agentId)
				);
				return { success: true, ...report };
			} catch (error) {
				logger.error(`Failed to find orphan memories: ${error}`, LOG_CONTEXT);
				return { success: false, error: String(error) };
			}
		}
	);

	ipcMain.handle(
		'memory:getPath',
		async (_event, projectPath: string, agentId: string = 'claude-code') => {
			try {
				return {
					success: true,
					path: getMemoryDirectoryPath(
						projectPath,
						agentId,
						undefined,
						await directoryFor(projectPath, agentId)
					),
				};
			} catch (error) {
				logger.error(`Failed to resolve memory path: ${error}`, LOG_CONTEXT);
				return { success: false, error: String(error) };
			}
		}
	);

	logger.info('Memory IPC handlers registered', LOG_CONTEXT);
}
