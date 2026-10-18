// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createMockSession } from '../helpers/mockSession';
import { createMockAITab } from '../helpers/mockTab';
import { extractNativeConversation } from '../../shared/maestro-lib/translation/native-records';
import { execFileNoThrow } from '../../main/utils/execFile';
import { execGitReadOnly } from '../../main/utils/remote-git';
import { encodeClaudeProjectPath } from '../../shared/pathUtils';
import { translationArtifact } from '../../shared/maestro-lib/translation/identity';
import { getHistoryManager } from '../../main/history-manager';
import {
	ProviderTranslationService,
	type ProviderTranslationDependencies,
} from '../../main/provider-translation-service';
import {
	TranslationArchive,
	type TranslationJournal,
} from '../../shared/maestro-lib/translation/archive';
import { openCodexTranslationConnection } from '../../shared/maestro-lib/codex/connection';
import { applyTranslation } from '../../shared/maestro-lib/translation/transaction';

vi.mock('node:fs/promises', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:fs/promises')>()),
}));
vi.mock('electron', () => ({ app: { getPath: () => '/isolated/private' } }));
vi.mock('../../main/ipc/handlers/persistence', () => ({ broadcastSessionLifecycle: vi.fn() }));
vi.mock('../../main/history-manager', () => ({ getHistoryManager: vi.fn() }));
vi.mock('../../main/agents/capability-snapshot', () => ({ capabilitySnapshots: { get: vi.fn() } }));
vi.mock('../../main/storage/codex-session-storage', () => ({ CodexSessionStorage: vi.fn() }));
vi.mock('../../main/utils/remote-git', () => ({ execGitReadOnly: vi.fn() }));
vi.mock('../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../shared/maestro-lib/codex/connection', () => ({
	openCodexTranslationConnection: vi.fn(),
}));
vi.mock('../../shared/maestro-lib/translation/transaction', () => ({
	applyTranslation: vi.fn(),
	recoverTranslation: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

describe('provider translation read scope', () => {
	it('pins a profile shared projects directory while refusing nested transcript escapes', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-profile-link-'));
		try {
			const accountRoot = path.join(root, 'profile');
			const projectRoot = path.join(root, 'project');
			const shared = path.join(root, 'shared-projects');
			await fs.mkdir(accountRoot);
			await fs.mkdir(projectRoot);
			await fs.mkdir(shared);
			await fs.symlink(shared, path.join(accountRoot, 'projects'), 'dir');
			vi.mocked(execFileNoThrow).mockResolvedValue({ exitCode: 0, stdout: '2.1.302', stderr: '' });
			vi.mocked(execGitReadOnly).mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
			const session = createMockSession({
				cwd: projectRoot,
				projectRoot,
				customEnvVars: { CLAUDE_CONFIG_DIR: accountRoot },
			});
			const service = new ProviderTranslationService({
				sessionsStore: { get: vi.fn(() => [session]) },
				settingsStore: { get: vi.fn(() => ({})) },
				agentConfigsStore: { get: vi.fn(() => ({})) },
				getAgentDetector: () => ({ getAgent: async () => ({ path: '/mock/claude' }) }),
				getProcessManager: () => ({ get: () => undefined }),
			} as unknown as ProviderTranslationDependencies);
			const identity = await (service as any).identity(session, 'claude-code', true);
			expect(identity.accountRoot).toBe(await fs.realpath(accountRoot));
			expect(identity.nativeSessionRoot).toBe(await fs.realpath(shared));
			const directory = path.join(shared, encodeClaudeProjectPath(identity.projectRoot));
			await fs.mkdir(directory);
			const file = path.join(directory, 'native.jsonl');
			await fs.writeFile(
				file,
				JSON.stringify({
					type: 'user',
					uuid: 'one',
					message: { role: 'user', content: 'selected marker' },
				})
			);
			expect(
				(await (service as any).conversation(identity, 'tab', 'native')).records[0].blocks[0].text
			).toBe('selected marker');
			await fs.unlink(file);
			await fs.writeFile(path.join(root, 'unselected.jsonl'), 'outside');
			await fs.symlink(path.join(root, 'unselected.jsonl'), file);
			await expect((service as any).conversation(identity, 'tab', 'native')).rejects.toThrow(
				'escapes its selected root'
			);
			const journal = {
				plan: {
					agentId: session.id,
					source: identity,
					destination: { ...identity, provider: 'codex' },
				},
			} as unknown as TranslationJournal;
			await fs.unlink(path.join(accountRoot, 'projects'));
			const retargeted = path.join(root, 'different-projects');
			await fs.mkdir(retargeted);
			await fs.symlink(retargeted, path.join(accountRoot, 'projects'), 'dir');
			await expect((service as any).host(journal).assertSourceUnchanged(journal)).rejects.toThrow(
				'Source account, project root or provider version changed'
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it.each([false, true])(
		'counts projected context rather than archived diagnostics (oversized=%s)',
		async (oversized) => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-capacity-'));
			try {
				const source = {
					provider: 'claude-code' as const,
					version: '2.1.302',
					accountRoot: root,
					projectRoot: root,
				};
				const session = createMockSession({
					id: 'agent',
					toolType: 'claude-code',
					cwd: root,
					projectRoot: root,
					aiTabs: [createMockAITab({ id: 'tab', agentSessionId: 'native' })],
				});
				const conversation = extractNativeConversation(
					source,
					'tab',
					'native',
					Buffer.from(
						[
							{ type: 'api-request-blob', message: 'x'.repeat(1_000_000) },
							{
								type: 'user',
								uuid: 'one',
								message: {
									role: 'user',
									content: oversized ? 'x'.repeat(1_000_000) : 'small conversation',
								},
							},
						]
							.map((row) => JSON.stringify(row))
							.join('\n')
					)
				);
				vi.spyOn(TranslationArchive.prototype, 'checkpoint').mockResolvedValue(undefined);
				vi.mocked(getHistoryManager).mockReturnValue({ getEntries: vi.fn(async () => []) } as any);
				const service = new ProviderTranslationService({
					sessionsStore: { get: vi.fn(() => [session]) },
					getProcessManager: () => ({ get: () => undefined }),
				} as unknown as ProviderTranslationDependencies);
				vi.spyOn(service as any, 'identity').mockImplementation(
					async (_session: unknown, provider: unknown) => ({
						...source,
						provider,
						version: provider === 'codex' ? '0.163.0' : source.version,
					})
				);
				vi.spyOn(service as any, 'conversation').mockResolvedValue(conversation);
				const journal = await (service as any).prepare({
					agentId: 'agent',
					destination: 'codex',
					action: 'plan',
				});
				expect(
					journal.plan.limitations.some(
						(item: { code: string }) => item.code === 'context-capacity'
					)
				).toBe(oversized);
				expect(journal.plan.status).toBe(oversized ? 'blocked' : 'ready');
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		}
	);
	it.each(['file', 'parent'] as const)(
		'refuses a native source %s link outside the selected account before reading its bytes',
		async (link) => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-source-scope-'));
			try {
				const accountRoot = path.join(root, 'account');
				const projectRoot = path.join(root, 'project');
				const directory = path.join(accountRoot, 'projects', encodeClaudeProjectPath(projectRoot));
				const external = path.join(root, 'unselected');
				await fs.mkdir(path.dirname(directory), { recursive: true });
				await fs.mkdir(external);
				await fs.writeFile(path.join(external, 'native.jsonl'), 'unselected private transcript');
				if (link === 'parent') await fs.symlink(external, directory, 'dir');
				else {
					await fs.mkdir(directory);
					await fs.symlink(
						path.join(external, 'native.jsonl'),
						path.join(directory, 'native.jsonl')
					);
				}
				const read = vi.spyOn(fs, 'readFile');
				const service = new ProviderTranslationService({} as ProviderTranslationDependencies);
				await expect(
					(service as any).conversation(
						{ provider: 'claude-code', version: '2.1.296', accountRoot, projectRoot },
						'tab',
						'native'
					)
				).rejects.toThrow('escapes its selected root');
				expect(read).not.toHaveBeenCalled();
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		}
	);
	it.each(['transcript', 'memory', 'knowledge-directory'] as const)(
		'rejects a source %s link retargeted after preflight even when its bytes match',
		async (variant) => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-source-retarget-'));
			try {
				const source = {
					provider: 'claude-code',
					version: '2.1.296',
					accountRoot: path.join(root, 'account'),
					projectRoot: path.join(root, 'project'),
				};
				const kind = variant === 'transcript' ? 'transcript' : 'memory';
				const knowledge = path.join(source.projectRoot, '.maestro/knowledge');
				const file =
					kind === 'transcript'
						? path.join(source.accountRoot, 'native.jsonl')
						: path.join(knowledge, 'memory/topic.md');
				await fs.mkdir(path.dirname(file), { recursive: true });
				const bytes = Buffer.from('synthetic native transcript');
				await fs.writeFile(file, bytes);
				const artifact = translationArtifact(kind, file, 'native.jsonl', bytes);
				const journal = {
					plan: { agentId: 'agent', source, destination: { ...source, provider: 'codex' } },
					resources: kind === 'memory' ? [artifact] : [],
					conversations: kind === 'transcript' ? [{ artifacts: [artifact] }] : [],
				} as unknown as TranslationJournal;
				const session = createMockSession({
					id: 'agent',
					providerTranslationKnowledgeDirectory: kind === 'memory' ? knowledge : undefined,
				});
				const service = new ProviderTranslationService({
					sessionsStore: { get: vi.fn(() => [session]) },
					getProcessManager: () => ({ get: () => undefined }),
				} as unknown as ProviderTranslationDependencies);
				vi.spyOn(service as any, 'identity').mockImplementation(
					async (_session: unknown, provider: unknown) => ({ ...source, provider })
				);
				const host = (service as any).host(journal);
				await host.assertSourceUnchanged(journal);
				const external = path.join(root, 'unselected.jsonl');
				if (variant === 'knowledge-directory') {
					await fs.mkdir(path.join(external, 'memory'), { recursive: true });
					await fs.writeFile(path.join(external, 'memory/topic.md'), bytes);
					await fs.rm(knowledge, { recursive: true });
					await fs.symlink(external, knowledge, 'dir');
				} else {
					await fs.writeFile(external, bytes);
					await fs.unlink(file);
					await fs.symlink(external, file);
				}
				await expect(host.assertSourceUnchanged(journal)).rejects.toThrow(
					'escapes its selected root'
				);
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		}
	);
	it.each(['memory', 'owned-projection'] as const)(
		'refuses return-trip %s reads through links outside project knowledge',
		async (variant) => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-knowledge-scope-'));
			try {
				const source = {
					provider: 'codex',
					version: '0.162.1',
					accountRoot: path.join(root, 'account'),
					projectRoot: path.join(root, 'project'),
				};
				const knowledge = path.join(source.projectRoot, '.maestro/knowledge');
				await fs.mkdir(path.join(knowledge, 'memory'), { recursive: true });
				const file = path.join(knowledge, 'memory/topic.md');
				const bytes = Buffer.from('selected project memory');
				await fs.writeFile(file, bytes);
				const base = translationArtifact('memory', file, 'memory/topic.md', bytes);
				const external = path.join(root, 'unselected.md');
				await fs.writeFile(external, 'unselected account knowledge');
				const ownedPath = path.join(source.projectRoot, 'native-topic.md');
				if (variant === 'memory') {
					await fs.unlink(file);
					await fs.symlink(external, file);
				} else await fs.symlink(external, ownedPath);
				vi.spyOn(TranslationArchive.prototype, 'checkpoint').mockResolvedValue({
					observed: {},
					lineage: {},
					conversations: [],
					resources: [base],
					resourceBases: {},
					providerRoots: {},
					ownedResources:
						variant === 'owned-projection'
							? {
									[ownedPath]: {
										sha256: base.sha256,
										resourceKey: base.relativePath,
										format: 'markdown',
									},
								}
							: {},
				});
				const session = createMockSession({
					id: 'agent',
					toolType: 'codex',
					providerTranslationKnowledgeDirectory: knowledge,
				});
				const service = new ProviderTranslationService({
					sessionsStore: { get: vi.fn(() => [session]) },
					getProcessManager: () => ({ get: () => undefined }),
				} as unknown as ProviderTranslationDependencies);
				vi.spyOn(service as any, 'identity').mockImplementation(
					async (_session: unknown, provider: unknown) => ({
						...source,
						provider,
						version: provider === 'codex' ? '0.162.1' : '2.1.296',
					})
				);
				vi.mocked(getHistoryManager).mockReturnValue({ getEntries: vi.fn(async () => []) } as any);
				await expect(
					(service as any).prepare({
						agentId: 'agent',
						destination: 'claude-code',
						action: 'plan',
					})
				).rejects.toThrow('escapes its selected root');
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		}
	);
	it('keeps managed resource limitations in the return-trip preflight', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-managed-limitations-'));
		try {
			const source = {
				provider: 'codex',
				version: '0.162.1',
				accountRoot: path.join(root, 'account'),
				projectRoot: path.join(root, 'project'),
			};
			const knowledge = path.join(source.projectRoot, '.maestro/knowledge');
			await fs.mkdir(path.join(knowledge, '.codex/agents'), { recursive: true });
			await fs.writeFile(path.join(knowledge, '.codex/agents/reviewer.toml'), 'name = "reviewer"');
			vi.spyOn(TranslationArchive.prototype, 'checkpoint').mockResolvedValue({
				observed: {},
				lineage: {},
				conversations: [],
				resources: [],
				resourceBases: {},
				providerRoots: {},
			});
			vi.mocked(getHistoryManager).mockReturnValue({ getEntries: vi.fn(async () => []) } as any);
			const session = createMockSession({
				id: 'agent',
				toolType: 'codex',
				providerTranslationKnowledgeDirectory: knowledge,
			});
			const service = new ProviderTranslationService({
				sessionsStore: { get: vi.fn(() => [session]) },
				getProcessManager: () => ({ get: () => undefined }),
			} as unknown as ProviderTranslationDependencies);
			vi.spyOn(service as any, 'identity').mockImplementation(
				async (_session: unknown, provider: unknown) => ({
					...source,
					provider,
					version: provider === 'codex' ? '0.162.1' : '2.1.296',
				})
			);
			const journal = await (service as any).prepare({
				agentId: 'agent',
				destination: 'claude-code',
				action: 'plan',
			});
			expect(journal.plan.status).toBe('blocked');
			expect(journal.plan.limitations).toContainEqual(
				expect.objectContaining({ code: 'missing-subagent-instructions', severity: 'block' })
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe('provider translation operation ownership', () => {
	it.each(['ready', 'deferred'] as const)(
		'retains a saved %s preflight operation ID when applying the refreshed plan',
		async (status) => {
			const session = createMockSession({ id: 'agent', toolType: 'codex' });
			const previous = {
				plan: {
					id: 'reviewed',
					agentId: 'agent',
					fingerprint: 'unchanged',
					status,
					destination: { provider: 'claude-code' },
				},
				state: 'planned',
				mappings: [],
				resourceWrites: [],
			} as unknown as TranslationJournal;
			const refreshed = {
				...previous,
				plan: { ...previous.plan, id: 'fresh', status: 'ready' as const },
			};
			vi.spyOn(TranslationArchive.prototype, 'read').mockResolvedValue(previous);
			vi.mocked(applyTranslation).mockReset().mockResolvedValue({
				success: false,
				state: 'failed',
				plan: refreshed.plan,
				mappings: [],
			});
			const service = new ProviderTranslationService({
				sessionsStore: { get: vi.fn(() => [session]) },
			} as unknown as ProviderTranslationDependencies);
			vi.spyOn(service as any, 'prepare').mockResolvedValue(refreshed);
			const report = await service.run({
				agentId: 'agent',
				destination: 'claude-code',
				action: 'apply',
				planId: 'reviewed',
			});
			expect(report.plan?.id).toBe('reviewed');
			expect(vi.mocked(applyTranslation).mock.calls[0][2].plan.id).toBe('reviewed');
		}
	);
	it.each(['current', 'historical', 'different-destination', 'current-unsettled'] as const)(
		'handles a %s committed apply retry without native staging',
		async (variant) => {
			const session = createMockSession({
				id: 'agent',
				toolType: 'codex',
				providerMigration: {
					operationId: variant === 'historical' ? 'later' : 'reviewed',
					destination: 'codex',
					state: variant === 'current-unsettled' ? 'recovery-required' : 'committed',
					verification: 'unverified',
				},
			});
			const journal = {
				plan: { id: 'reviewed', agentId: 'agent', destination: { provider: 'codex' } },
				state: 'committed',
			} as unknown as TranslationJournal;
			journal.result = { success: true, state: 'committed', plan: journal.plan, mappings: [] };
			vi.spyOn(TranslationArchive.prototype, 'read').mockResolvedValue(journal);
			vi.mocked(applyTranslation).mockReset();
			vi.mocked(openCodexTranslationConnection).mockReset();
			const service = new ProviderTranslationService({
				sessionsStore: { get: vi.fn(() => [session]) },
			} as unknown as ProviderTranslationDependencies);
			const prepare = vi.spyOn(service as any, 'prepare');
			const report = await service.run({
				agentId: 'agent',
				destination: variant === 'different-destination' ? 'claude-code' : 'codex',
				action: 'apply',
				planId: 'reviewed',
			});
			expect(report.success).toBe(variant === 'current');
			if (variant === 'current') expect(report.result).toBe(journal.result);
			expect(prepare).not.toHaveBeenCalled();
			expect(applyTranslation).not.toHaveBeenCalled();
			expect(openCodexTranslationConnection).not.toHaveBeenCalled();
		}
	);
	it.each(['failed', 'mapping-intent', 'write-intent', 'rolled-back'] as const)(
		'refuses saved %s evidence even when no active migration is persisted',
		async (variant) => {
			const session = createMockSession({ id: 'agent' });
			const journal = {
				plan: { id: 'reviewed', agentId: 'agent', destination: { provider: 'codex' } },
				state: variant === 'failed' || variant === 'rolled-back' ? variant : 'planned',
				mappings: variant === 'mapping-intent' ? [{ tabId: 'tab' }] : [],
				resourceWrites: variant === 'write-intent' ? [{ created: false }] : [],
			} as unknown as TranslationJournal;
			vi.spyOn(TranslationArchive.prototype, 'read').mockResolvedValue(journal);
			vi.mocked(applyTranslation).mockReset();
			vi.mocked(openCodexTranslationConnection).mockReset();
			const service = new ProviderTranslationService({
				sessionsStore: { get: vi.fn(() => [session]) },
			} as unknown as ProviderTranslationDependencies);
			const prepare = vi.spyOn(service as any, 'prepare');
			const report = await service.run({
				agentId: 'agent',
				destination: 'codex',
				action: 'apply',
				planId: 'reviewed',
			});
			expect(report.success).toBe(false);
			expect(report.error).toContain('staging is not replayed');
			expect(prepare).not.toHaveBeenCalled();
			expect(applyTranslation).not.toHaveBeenCalled();
			expect(openCodexTranslationConnection).not.toHaveBeenCalled();
		}
	);
	it.each([
		{ name: 'accepted warnings', status: 'ready', warnings: true, accept: true, opens: true },
		{ name: 'complete plan', status: 'ready', warnings: false, accept: undefined, opens: true },
		{ name: 'unaccepted warnings', status: 'ready', warnings: true, accept: false, opens: false },
		{ name: 'deferred source', status: 'deferred', warnings: true, accept: true, opens: false },
		{ name: 'blocked preflight', status: 'blocked', warnings: true, accept: true, opens: false },
		{ name: 'unchanged provider', status: 'noop', warnings: false, accept: true, opens: false },
	])('gates the selected-account destination import channel for $name', async (scenario) => {
		const session = createMockSession({
			id: 'agent',
			customEnvVars: { OPENAI_API_KEY: 'synthetic-source-key' },
		});
		const journal = {
			plan: {
				id: 'operation',
				agentId: 'agent',
				status: scenario.status,
				limitations: scenario.warnings
					? [
							{
								code: 'synthetic-limit',
								severity: scenario.status === 'blocked' ? 'block' : 'warning',
								message: 'Synthetic limitation',
							},
						]
					: [],
				verification: scenario.warnings ? 'unverified' : 'verified',
				destination: {
					provider: 'codex',
					accountRoot: '/isolated/selected-account',
					projectRoot: '/isolated/project',
				},
			},
		} as unknown as TranslationJournal;
		const close = vi.fn();
		const connection = {
			request: vi.fn(),
			onNotification: vi.fn(),
			close,
		};
		vi.mocked(openCodexTranslationConnection).mockReset().mockResolvedValue(connection);
		vi.mocked(applyTranslation).mockReset().mockResolvedValue({
			success: false,
			state: 'failed',
			plan: journal.plan,
			mappings: [],
			error: 'Synthetic staging failure',
		});
		const service = new ProviderTranslationService({
			sessionsStore: { get: vi.fn(() => [session]) },
			settingsStore: { get: vi.fn(() => ({ TRANSLATION_GLOBAL: 'synthetic-global' })) },
			agentConfigsStore: {
				get: vi.fn(() => ({
					codex: {
						customEnvVars: {
							OPENAI_API_KEY: 'synthetic-destination-key',
							CODEX_HOME: '/isolated/configured-account',
						},
					},
				})),
			},
			getAgentDetector: () => ({
				getAgent: vi.fn(async () => ({
					path: '/isolated/bin/codex',
					defaultEnvVars: { TRANSLATION_DEFAULT: 'synthetic-default' },
				})),
			}),
		} as unknown as ProviderTranslationDependencies);
		vi.spyOn(service as any, 'prepare').mockResolvedValue(journal);
		await service.run({
			agentId: 'agent',
			destination: 'codex',
			action: 'apply',
			acceptLimitations: scenario.accept,
		});
		expect(applyTranslation).toHaveBeenCalledWith(
			expect.any(TranslationArchive),
			expect.anything(),
			journal,
			expect.anything(),
			scenario.accept
		);
		expect(vi.mocked(applyTranslation).mock.calls[0][3].codex).toBe(
			scenario.opens ? connection : undefined
		);
		if (!scenario.opens) {
			expect(openCodexTranslationConnection).not.toHaveBeenCalled();
			expect(close).not.toHaveBeenCalled();
			return;
		}
		expect(openCodexTranslationConnection).toHaveBeenCalledWith({
			binary: '/isolated/bin/codex',
			cwd: '/isolated/project',
			env: expect.objectContaining({
				CODEX_HOME: '/isolated/selected-account',
				OPENAI_API_KEY: 'synthetic-destination-key',
				TRANSLATION_GLOBAL: 'synthetic-global',
				TRANSLATION_DEFAULT: 'synthetic-default',
			}),
		});
		expect(close).toHaveBeenCalledOnce();
	});
	it.each(['staging', 'staged', 'committing', 'recovery-required', 'failed'] as const)(
		'requires recovery of a %s operation before replanning or applying',
		async (state) => {
			const session = createMockSession({
				id: 'agent',
				providerMigration: {
					operationId: 'original',
					destination: 'codex',
					state,
					verification: 'unverified',
				},
			});
			const getAgentDetector = vi.fn();
			const service = new ProviderTranslationService({
				sessionsStore: { get: vi.fn(() => [session]), set: vi.fn() },
				getAgentDetector,
			} as unknown as ProviderTranslationDependencies);
			for (const action of ['plan', 'apply'] as const) {
				expect(
					await service.run({
						agentId: 'agent',
						destination: 'codex',
						action,
						acceptLimitations: true,
					})
				).toEqual({
					success: false,
					error:
						'The previous provider migration requires recovery or rollback before another plan or apply.',
				});
			}
			expect(getAgentDetector).not.toHaveBeenCalled();
		}
	);
	it.each(['recover', 'rollback'] as const)(
		'refuses %s of a historical operation without replacing the current migration',
		async (action) => {
			const session = createMockSession({
				id: 'agent',
				providerMigration: {
					operationId: 'current',
					destination: 'codex',
					state: 'staging',
					verification: 'unverified',
				},
			});
			const read = vi.spyOn(TranslationArchive.prototype, 'read');
			const set = vi.fn();
			const service = new ProviderTranslationService({
				sessionsStore: { get: vi.fn(() => [session]), set },
			} as unknown as ProviderTranslationDependencies);
			expect(
				await service.run({ agentId: 'agent', destination: 'codex', action, planId: 'older' })
			).toEqual({
				success: false,
				error:
					'Only the current provider migration can be recovered or rolled back. Inspect historical operations with status.',
			});
			expect(read).not.toHaveBeenCalled();
			expect(set).not.toHaveBeenCalled();
		}
	);
	it('reports the persisted operation rather than a later dry-run journal', async () => {
		const session = createMockSession({
			id: 'agent',
			providerMigration: {
				operationId: 'original',
				destination: 'codex',
				state: 'recovery-required',
				verification: 'unverified',
			},
		});
		const journal = {
			plan: { id: 'original' },
			state: 'recovery-required',
			mappings: [],
		} as unknown as TranslationJournal;
		const read = vi.spyOn(TranslationArchive.prototype, 'read').mockResolvedValue(journal);
		const latest = vi
			.spyOn(TranslationArchive.prototype, 'lastOperation')
			.mockResolvedValue('dry-run');
		const service = new ProviderTranslationService({
			sessionsStore: { get: vi.fn(() => [session]) },
		} as unknown as ProviderTranslationDependencies);
		expect(
			(await service.run({ agentId: 'agent', destination: 'codex', action: 'status' })).plan?.id
		).toBe('original');
		expect(read).toHaveBeenCalledWith('agent', 'original');
		expect(latest).not.toHaveBeenCalled();
		await service.run({
			agentId: 'agent',
			destination: 'codex',
			action: 'status',
			planId: 'explicit',
		});
		expect(read).toHaveBeenLastCalledWith('agent', 'explicit');
	});
});
