// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { app } from 'electron';
import { createMockSession } from '../helpers/mockSession';
import { createMockAITab } from '../helpers/mockTab';
import { execFileNoThrow } from '../../main/utils/execFile';
import { execGitReadOnly } from '../../main/utils/remote-git';
import { encodeClaudeProjectPath } from '../../shared/pathUtils';
import {
	translationArtifact,
	translationHash,
} from '../../shared/maestro-lib/translation/identity';
import { generateUUID } from '../../shared/uuid';
import {
	TRANSLATION_KNOWLEDGE_ENV_VAR,
	TRANSLATION_KNOWLEDGE_REMOTE_ENV_VAR,
} from '../../shared/maestro-lib/translation/knowledge-binding';
import {
	NativeTranslationService,
	type TranslationNativeHost,
} from '../../shared/maestro-lib/translation/service';
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
import {
	applyTranslation,
	recoverTranslation,
} from '../../shared/maestro-lib/translation/transaction';
import * as translationResources from '../../shared/maestro-lib/translation/resources';
import { captureMessage } from '../../main/utils/sentry';
import { capabilitySnapshots } from '../../main/agents/capability-snapshot';
import { extractNativeConversation } from '../../shared/maestro-lib/translation/native-records';
import { projectConversation } from '../../shared/maestro-lib/translation/adapters';
import { canonicalJson } from '../../shared/canonicalJson';
import { estimateTokenCount } from '../../shared/formatters';
import { resolveSshTranslationHost } from '../../main/provider-translation-ssh';
import { remapTranslationFs } from '../helpers/translationFs';
import { createSshTranslationFs } from '../../main/provider-translation-fs';
import * as remoteFs from '../../main/utils/remote-fs';
import { localTranslationFs } from '../../shared/maestro-lib/translation/local-fs';
import type { TranslationRpc } from '../../shared/maestro-lib/translation/types';
import type { SshRemoteConfig } from '../../shared/types';

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
vi.mock('../../main/provider-translation-ssh', () => ({ resolveSshTranslationHost: vi.fn() }));
vi.mock('../../main/utils/sentry', () => ({
	captureMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../shared/maestro-lib/codex/connection', () => ({
	openCodexTranslationConnection: vi.fn(),
}));
vi.mock('../../shared/maestro-lib/translation/transaction', () => ({
	applyTranslation: vi.fn(),
	recoverTranslation: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

describe('SSH provider translation transactions', () => {
	it.each(['commit', 'recover', 'rollback'] as const)(
		'round-trips Claude and Codex through the SSH port with %s and a local archive',
		async (outcome) => {
			const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-ssh-transaction-'));
			try {
				// Keep the real service, adapters, resource discovery and transaction engine.
				const transaction = await vi.importActual<
					typeof import('../../shared/maestro-lib/translation/transaction')
				>('../../shared/maestro-lib/translation/transaction');
				vi.mocked(applyTranslation).mockReset().mockImplementation(transaction.applyTranslation);
				vi.mocked(recoverTranslation)
					.mockReset()
					.mockImplementation(transaction.recoverTranslation);
				vi.mocked(openCodexTranslationConnection).mockClear();
				vi.mocked(getHistoryManager).mockReturnValue({ getEntries: async () => [] } as any);
				const root = await fs.realpath(temporary);
				const data = path.join(root, 'local-data');
				const virtualRoot = `/fake-ssh/${generateUUID()}`;
				const backingRoot = path.join(root, 'remote');
				const disk = remapTranslationFs(virtualRoot, backingRoot, path.posix);
				const remote: SshRemoteConfig = {
					id: 'fake-remote',
					name: 'Isolated translation remote',
					host: 'translation.invalid',
					port: 22,
					username: 'tester',
					privateKeyPath: '',
					enabled: true,
				};
				// Replace only the transport primitives. The production SSH adapter still
				// handles binary decoding, metadata, ownership callbacks and native paths.
				vi.spyOn(remoteFs, 'readBinaryFileRemoteAsBase64').mockImplementation(async (file) => ({
					success: true,
					data: (await disk.nativeFs.readFile(file)).toString('base64'),
				}));
				vi.spyOn(remoteFs, 'readDirNamesRemote').mockImplementation(
					async (file, _remote, options) => ({
						success: true,
						data: await disk.nativeFs.readdir(file, options),
					})
				);
				vi.spyOn(remoteFs, 'lstatRemote').mockImplementation(async (file) => {
					const stat = await disk.nativeFs.lstat(file);
					return {
						success: true,
						data: {
							type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
							isDirectory: stat.isDirectory(),
							size: stat.size,
							mtime: stat.mtimeMs,
							mode: stat.mode,
						},
					};
				});
				vi.spyOn(remoteFs, 'realpathRemote').mockImplementation(async (file) => ({
					success: true,
					data: await disk.nativeFs.realpath(file),
				}));
				vi.spyOn(remoteFs, 'mkdirRemote').mockImplementation(
					async (file, _remote, _recursive, _deps, options) => {
						await disk.nativeFs.mkdir(file, { recursive: true, ...options });
						return { success: true };
					}
				);
				vi.spyOn(remoteFs, 'createExclusiveRemote').mockImplementation(
					async (file, bytes, _remote, _deps, options) => {
						await disk.nativeFs.createExclusive(file, bytes, {
							mode: options?.mode,
							durable: options?.sync,
						});
						return { success: true };
					}
				);
				vi.spyOn(remoteFs, 'writeFileAtomicRemote').mockImplementation(
					async (file, bytes, _remote, options) => {
						await disk.nativeFs.atomicWrite(file, bytes, {
							mode: options?.mode,
							durable: options?.sync,
						});
						return { success: true };
					}
				);
				vi.spyOn(remoteFs, 'deleteRemote').mockImplementation(async (file) => {
					await disk.nativeFs.unlink(file);
					return { success: true };
				});
				vi.spyOn(remoteFs, 'readlinkRemote').mockImplementation(async (file) => ({
					success: true,
					data: await disk.nativeFs.readlink(file),
				}));
				vi.spyOn(remoteFs, 'symlinkRemote').mockImplementation(async (target, file) => {
					await disk.nativeFs.symlink(target, file);
					return { success: true };
				});
				const nativeFs = createSshTranslationFs(remote);
				const project = `${virtualRoot}/project`;
				const claudeRoot = `${virtualRoot}/.claude`;
				const codexRoot = `${virtualRoot}/.codex`;
				const claudeProject = `${claudeRoot}/projects/${encodeClaudeProjectPath(project)}`;
				const sourceFile = `${claudeProject}/original.jsonl`;
				const originalText = 'Keep the SSH fact: café, π, and two  spaces.';
				const newText = 'A new Codex turn must survive the return hop.';
				const sourceBytes = Buffer.from(
					JSON.stringify({
						type: 'user',
						uuid: 'original-message',
						sessionId: 'original',
						cwd: project,
						message: { role: 'user', content: originalText },
					}) + '\r\n'
				);
				const memoryBytes = Buffer.from('Remember this exact memory.\r\nSecond line.\r\n');
				await disk.nativeFs.mkdir(`${claudeProject}/memory`, { recursive: true });
				await disk.nativeFs.mkdir(project, { recursive: true });
				await disk.nativeFs.mkdir(codexRoot, { recursive: true });
				await disk.nativeFs.createExclusive(sourceFile, sourceBytes);
				await disk.nativeFs.createExclusive(`${claudeProject}/memory/MEMORY.md`, memoryBytes);
				const unrelated = `${codexRoot}/unrelated.txt`;
				await disk.nativeFs.createExclusive(unrelated, 'Unrelated provider data');
				vi.spyOn(app, 'getPath').mockReturnValue(data);

				const localWrites = [
					vi.spyOn(localTranslationFs, 'mkdir'),
					vi.spyOn(localTranslationFs, 'createExclusive'),
					vi.spyOn(localTranslationFs, 'atomicWrite'),
					vi.spyOn(localTranslationFs, 'unlink'),
				];
				const nativeWrites = [
					vi.spyOn(nativeFs, 'mkdir'),
					vi.spyOn(nativeFs, 'createExclusive'),
					vi.spyOn(nativeFs, 'atomicWrite'),
					vi.spyOn(nativeFs, 'unlink'),
				];
				let session = createMockSession({
					id: 'ssh-round-trip',
					toolType: 'claude-code',
					cwd: project,
					projectRoot: project,
					sessionSshRemoteConfig: { enabled: true, remoteId: remote.id },
					aiTabs: [{ id: 'open', agentSessionId: 'original', logs: [] }] as any,
					activeTabId: 'open',
				});
				let interruptCommit = false;
				const persist = vi.fn((_key: string, sessions: (typeof session)[]) => {
					if (interruptCommit && sessions[0].toolType !== session.toolType) {
						interruptCommit = false;
						throw new Error('Synthetic session-store interruption before commit');
					}
					session = sessions[0];
				});
				const dependencies = {
					sessionsStore: { get: () => [session], set: persist },
					settingsStore: { get: (_key: string, fallback: unknown) => fallback },
					agentConfigsStore: { get: () => ({}) },
					getProcessManager: () => ({ get: () => undefined }),
					getAgentDetector: vi.fn(() => {
						throw new Error('Local provider detection is forbidden');
					}),
				} as unknown as ProviderTranslationDependencies;
				const rollouts = new Map<string, string>();
				const rpcMethods: string[] = [];
				const request: TranslationRpc['request'] = async <T>(
					method: string,
					params?: unknown
				): Promise<T> => {
					rpcMethods.push(method);
					if (method === 'thread/start') {
						expect(params).toMatchObject({
							cwd: project,
							approvalPolicy: 'never',
							sandbox: 'read-only',
						});
						const id = generateUUID();
						const file = `${codexRoot}/sessions/rollout-${id}.jsonl`;
						rollouts.set(id, file);
						await nativeFs.mkdir(path.posix.dirname(file), { recursive: true });
						await nativeFs.createExclusive(
							file,
							JSON.stringify({ type: 'session_meta', payload: { id, cwd: project } }) + '\n'
						);
						return { thread: { id, path: file } } as T;
					}
					if (method === 'thread/inject_items') {
						const { threadId, items } = params as { threadId: string; items: unknown[] };
						const file = rollouts.get(threadId)!;
						await nativeFs.atomicWrite(
							file,
							Buffer.concat([
								await nativeFs.readFile(file),
								Buffer.from(
									items
										.map((payload) => JSON.stringify({ type: 'response_item', payload }))
										.join('\n') + '\n'
								),
							])
						);
						return {} as T;
					}
					throw new Error(`Unexpected translation RPC: ${method}`);
				};
				const connection = { request, onNotification: () => () => {}, close: vi.fn() };
				const remoteHost = {
					nativeFs,
					resolveIdentity: vi.fn<NonNullable<TranslationNativeHost['resolveIdentity']>>(
						async (_session, provider) => ({
							provider,
							version: provider === 'codex' ? '0.162.1' : '2.1.296',
							accountRoot: provider === 'codex' ? codexRoot : claudeRoot,
							projectRoot: project,
							remoteHome: virtualRoot,
							remoteHost: translationHash(canonicalJson(remote)),
						})
					),
					execGit: vi.fn(async () => ({
						exitCode: 128,
						stdout: '',
						stderr: 'not a git repository',
					})),
					findCodexSessionFile: vi.fn(async (id: string, accountRoot: string) => {
						expect(accountRoot).toBe(codexRoot);
						return rollouts.get(id) ?? null;
					}),
					openCodexConnection: vi.fn(async () => connection),
				};
				vi.mocked(resolveSshTranslationHost).mockReset().mockResolvedValue(remoteHost);
				const archive = new TranslationArchive(path.join(data, 'provider-translations'));
				for (const destination of ['codex', 'claude-code'] as const) {
					const service = new ProviderTranslationService(dependencies);
					const before = structuredClone(session);
					const checkpointBefore = await archive.checkpoint(session.id);
					const planned = await service.run({ agentId: session.id, destination, action: 'plan' });
					expect(planned).toMatchObject({ success: true, plan: { status: 'ready' } });
					const planId = planned.plan!.id;
					const planJournal = await archive.read(session.id, planId);
					expect(planJournal.state).toBe('planned');
					if (destination === 'codex') {
						expect(
							await fs.readFile(
								path.join(
									path.dirname(archive.operationPath(session.id, planId)),
									`${translationHash(sourceBytes)}.bytes`
								)
							)
						).toEqual(sourceBytes);
					}
					expect(planJournal.resources).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								kind: 'memory',
								bytesBase64: memoryBytes.toString('base64'),
							}),
						])
					);
					interruptCommit = outcome !== 'commit';
					let applied = await service.run({
						agentId: session.id,
						destination,
						action: 'apply',
						planId,
						acceptLimitations: true,
					});
					expect(applied.result?.state, applied.error).toBe(
						outcome === 'commit' ? 'committed' : 'failed'
					);
					let journal = await archive.read(session.id, planId);
					expect(journal.mappings).toHaveLength(1);
					expect(journal.resourceWrites.length).toBeGreaterThan(0);
					const nativeFiles = [
						...journal.resourceWrites,
						...journal.mappings.flatMap((mapping) => mapping.artifacts),
					];
					for (const write of nativeFiles) {
						expect(write.path.startsWith(virtualRoot + '/')).toBe(true);
						expect(translationHash(await fs.readFile(disk.backingPath(write.path)))).toBe(
							write.sha256
						);
					}
					if (outcome !== 'commit') {
						expect(journal.failurePhase).toBe('committing');
						expect(session.toolType).toBe(before.toolType);
						expect(session.aiTabs).toEqual(before.aiTabs);
						const writeCounts = nativeWrites.map((write) => write.mock.calls.length);
						const rpcCount = rpcMethods.length;
						// A fresh service must recover solely from the local journal and remote bytes.
						applied = await new ProviderTranslationService(dependencies).run({
							agentId: session.id,
							destination,
							action: outcome,
							planId,
						});
						expect(applied.result?.state, applied.error).toBe(
							outcome === 'recover' ? 'committed' : 'rolled-back'
						);
						expect(rpcMethods).toHaveLength(rpcCount);
						if (outcome === 'recover') {
							expect(nativeWrites.map((write) => write.mock.calls.length)).toEqual(writeCounts);
						} else {
							expect(session.toolType).toBe(before.toolType);
							expect(session.aiTabs).toEqual(before.aiTabs);
							expect(await archive.checkpoint(session.id)).toEqual(checkpointBefore);
							for (const write of nativeFiles) {
								if (write.cleanup === 'retain') {
									expect(translationHash(await nativeFs.readFile(write.path))).toBe(write.sha256);
								} else {
									expect(await nativeFs.exists(write.path)).toBe(false);
									expect(nativeFs.unlink).toHaveBeenCalledWith(write.path);
								}
							}
							expect((await archive.read(session.id, planId)).state).toBe('rolled-back');
							// Retry as a new operation so this case also exercises the return hop.
							applied = await new ProviderTranslationService(dependencies).run({
								agentId: session.id,
								destination,
								action: 'apply',
								acceptLimitations: true,
							});
							expect(applied.result?.state, applied.error).toBe('committed');
							expect(applied.plan!.id).not.toBe(planId);
						}
					}
					journal = await archive.read(session.id, applied.plan!.id);
					expect(journal.state).toBe('committed');
					expect(session.toolType).toBe(destination);
					expect(session.aiTabs[0].agentSessionId).toBe(journal.mappings[0].destinationSessionId);
					expect(session.providerMigration?.state).toBe('committed');
					expect(session.aiTabs[0].logs).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								source: 'system',
								contextTranslation: expect.objectContaining({
									operationId: journal.plan.id,
									source: {
										provider: journal.plan.source.provider,
										version: journal.plan.source.version,
									},
									destination: { provider: destination, version: journal.plan.destination.version },
									verification: journal.plan.verification,
									limitations: journal.plan.limitations,
								}),
							}),
						])
					);
					expect(
						session.customEnvVars?.[destination === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR']
					).toBe(journal.plan.destination.accountRoot);
					expect(session.customEnvVars?.[TRANSLATION_KNOWLEDGE_ENV_VAR]).toBe(
						journal.knowledgeDirectory
					);
					expect(JSON.parse(session.customEnvVars![TRANSLATION_KNOWLEDGE_REMOTE_ENV_VAR])).toEqual({
						remoteHome: virtualRoot,
						remoteHost: translationHash(canonicalJson(remote)),
					});
					expect(
						journal.knowledgeDirectory!.startsWith(`${virtualRoot}/.maestro/provider-knowledge/`)
					).toBe(true);
					expect(await nativeFs.readFile(`${journal.knowledgeDirectory}/memory/MEMORY.md`)).toEqual(
						memoryBytes
					);
					expect((await archive.checkpoint(session.id))?.operationId).toBe(journal.plan.id);
					for (const artifact of journal.conversations.flatMap(
						(conversation) => conversation.artifacts
					)) {
						expect(
							await fs.readFile(
								path.join(
									path.dirname(archive.operationPath(session.id, journal.plan.id)),
									`${artifact.sha256}.bytes`
								)
							)
						).toEqual(Buffer.from(artifact.bytesBase64, 'base64'));
					}
					const file = journal.mappings[0].artifacts[0].path;
					const translated = extractNativeConversation(
						journal.plan.destination,
						'open',
						journal.mappings[0].destinationSessionId!,
						await nativeFs.readFile(file)
					);
					expect(
						translated.records
							.filter((record) => record.role === 'user' || record.role === 'assistant')
							.flatMap((record) => record.blocks)
					).toEqual([
						{ kind: 'text', text: originalText },
						...(destination === 'claude-code' ? [{ kind: 'text', text: newText }] : []),
					]);
					if (destination === 'codex') {
						await nativeFs.atomicWrite(
							file,
							Buffer.concat([
								await nativeFs.readFile(file),
								Buffer.from(
									JSON.stringify({
										type: 'response_item',
										payload: {
											type: 'message',
											id: 'new-codex-message',
											role: 'user',
											content: [{ type: 'input_text', text: newText }],
										},
									}) + '\n'
								),
							])
						);
					}
					expect(await nativeFs.readFile(sourceFile)).toEqual(sourceBytes);
					expect(await nativeFs.readFile(unrelated)).toEqual(
						Buffer.from('Unrelated provider data')
					);
				}
				// A native path never exists on the local host; all actual disk mutations
				// belong to either Maestro's archive or the isolated remote backing tree.
				await expect(fs.stat(virtualRoot)).rejects.toMatchObject({ code: 'ENOENT' });
				await expect(fs.stat(path.join(data, 'provider-knowledge'))).rejects.toMatchObject({
					code: 'ENOENT',
				});
				for (const write of nativeWrites) {
					for (const [file] of write.mock.calls)
						expect(file.startsWith(virtualRoot + '/')).toBe(true);
				}
				for (const write of localWrites) {
					for (const [file] of write.mock.calls) {
						expect(
							[data, backingRoot].some(
								(directory) => file === directory || file.startsWith(directory + path.sep)
							),
							file
						).toBe(true);
					}
				}
				expect(remoteFs.createExclusiveRemote).toHaveBeenCalledWith(
					expect.any(String),
					expect.anything(),
					remote,
					undefined,
					expect.any(Object)
				);
				expect(remoteFs.writeFileAtomicRemote).toHaveBeenCalledWith(
					expect.any(String),
					expect.anything(),
					remote,
					expect.any(Object),
					undefined
				);
				expect(openCodexTranslationConnection).not.toHaveBeenCalled();
				expect(dependencies.getAgentDetector).not.toHaveBeenCalled();
				expect(connection.close).toHaveBeenCalledTimes(
					remoteHost.openCodexConnection.mock.calls.length
				);
			} finally {
				vi.mocked(applyTranslation).mockReset();
				vi.mocked(recoverTranslation).mockReset();
				vi.mocked(resolveSshTranslationHost).mockReset();
				vi.restoreAllMocks();
				await fs.rm(temporary, { recursive: true, force: true });
			}
		},
		30_000
	);
});

describe('single-tab provider translation service', () => {
	it.each(['gated', 'connected', 'missing-channel'] as const)(
		'selects the per-agent remote host with %s import transport',
		async (transport) => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-remote-plan-'));
			try {
				vi.spyOn(app, 'getPath').mockReturnValue(path.join(root, 'data'));
				vi.mocked(getHistoryManager).mockReturnValue({ getEntries: async () => [] } as any);
				vi.spyOn(translationResources, 'collectTranslationResources').mockResolvedValue({
					artifacts: [],
					limitations: [],
				});
				const native = remapTranslationFs('/remote', path.join(root, 'remote'));
				const session = createMockSession({
					id: 'remote-agent',
					toolType: 'claude-code',
					cwd: '/remote/project',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote' },
					aiTabs: [{ id: 'open', agentSessionId: null }] as any,
				});
				const connection = { request: vi.fn(), onNotification: vi.fn(), close: vi.fn() };
				const openCodexConnection = vi.fn(async () => connection);
				const remoteHost = {
					nativeFs: native.nativeFs,
					resolveIdentity: vi.fn(async (_session, provider) => ({
						provider,
						version: provider === 'codex' ? '0.162.1' : '2.1.296',
						accountRoot: `/remote/${provider}`,
						projectRoot: '/remote/project',
						remoteHome: '/remote',
						remoteHost: translationHash('remote-host'),
					})),
					execGit: vi.fn(),
					findCodexSessionFile: vi.fn(),
					...(transport === 'connected' ? { openCodexConnection } : {}),
					assertCanApply: () => {
						if (transport !== 'gated') return;
						throw new Error('Remote import channel unavailable');
					},
				};
				vi.mocked(resolveSshTranslationHost).mockResolvedValue(remoteHost);
				const service = new ProviderTranslationService({
					sessionsStore: { get: () => [session] },
					settingsStore: { get: () => [] },
					agentConfigsStore: { get: () => ({}) },
					getProcessManager: () => ({ get: () => undefined }),
				} as unknown as ProviderTranslationDependencies);
				const report = await service.run({
					agentId: session.id,
					destination: 'codex',
					action: 'plan',
				});
				expect(report.error).toBeUndefined();
				expect(report.plan?.status).toBe('ready');
				expect(report.plan?.limitations.some((entry) => entry.code === 'remote-translation')).toBe(
					false
				);
				expect(translationResources.collectTranslationResources).toHaveBeenCalledWith(
					expect.objectContaining({ remoteHost: translationHash('remote-host') }),
					expect.anything(),
					undefined,
					native.nativeFs
				);
				const archive = new TranslationArchive(path.join(root, 'data/provider-translations'));
				expect((await archive.read(session.id, report.plan!.id)).plan.source.remoteHome).toBe(
					'/remote'
				);
				vi.mocked(applyTranslation).mockResolvedValueOnce({
					success: true,
					state: 'committed',
					plan: report.plan!,
					mappings: [],
				});
				vi.mocked(openCodexTranslationConnection).mockClear();
				const applied = await service.run({
					agentId: session.id,
					destination: 'codex',
					action: 'apply',
					acceptLimitations: true,
				});
				if (transport === 'connected') {
					expect(applied.success).toBe(true);
					expect(openCodexConnection).toHaveBeenCalledWith(report.plan!.destination);
					expect(applyTranslation).toHaveBeenLastCalledWith(
						expect.anything(),
						expect.anything(),
						expect.anything(),
						expect.objectContaining({ nativeFs: native.nativeFs, codex: connection }),
						true
					);
					expect(connection.close).toHaveBeenCalledOnce();
				} else {
					expect(applied).toMatchObject({
						success: false,
						error:
							transport === 'gated'
								? 'Remote import channel unavailable'
								: 'SSH translation requires a remote Codex import channel.',
					});
				}
				expect(openCodexTranslationConnection).not.toHaveBeenCalled();
				expect(native.nativeFs.atomicWrite).not.toHaveBeenCalled();
			} finally {
				vi.mocked(applyTranslation).mockReset();
				vi.mocked(resolveSshTranslationHost).mockReset();
				await fs.rm(root, { recursive: true, force: true });
			}
		}
	);
	it('translates only open tabs, leaving blocked closed and missing History sources for next use', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-open-tabs-'));
		try {
			vi.spyOn(app, 'getPath').mockReturnValue(path.join(root, 'data'));
			vi.mocked(getHistoryManager).mockReturnValue({
				getEntries: async () => [{ agentSessionId: 'missing-history' }],
			} as any);
			vi.mocked(execGitReadOnly).mockResolvedValue({
				exitCode: 128,
				stdout: '',
				stderr: 'fatal: not a git repository',
			});
			vi.spyOn(translationResources, 'collectTranslationResources').mockResolvedValue({
				artifacts: [],
				limitations: [],
			});
			const source = {
				provider: 'codex' as const,
				version: '0.162.1',
				accountRoot: path.join(root, 'codex'),
				projectRoot: path.join(root, 'project'),
			};
			const destination = {
				...source,
				provider: 'claude-code' as const,
				version: '2.1.296',
				accountRoot: path.join(root, 'claude'),
			};
			let session = createMockSession({
				id: 'agent',
				toolType: 'codex',
				aiTabs: [
					{ id: 'open', agentSessionId: 'open-native' },
					{ id: 'pinned', tabProvider: 'claude-code', agentSessionId: 'pinned-native' },
				] as any,
				closedTabHistory: [
					{ tab: { id: 'blocked', agentSessionId: 'missing-closed' }, index: 1, closedAt: 1 },
				] as any,
			});
			const service = new ProviderTranslationService({
				sessionsStore: {
					get: () => [session],
					set: (_key: string, sessions: (typeof session)[]) => {
						session = sessions[0];
					},
				},
				agentConfigsStore: { get: () => ({}) },
				getProcessManager: () => ({ get: () => undefined }),
			} as unknown as ProviderTranslationDependencies);
			vi.spyOn(service as any, 'identity').mockImplementation(
				async (_session: unknown, provider: unknown) =>
					provider === 'codex' ? source : destination
			);
			const readNative = (service as any).conversation.bind(service);
			const read = vi
				.spyOn(service as any, 'conversation')
				.mockImplementation(async (identity: any, tabId: any, nativeId: any) => {
					if (identity.provider === 'claude-code') return readNative(identity, tabId, nativeId);
					if (tabId !== 'open' && tabId !== 'reopened')
						throw new Error('Unusable closed native transcript');
					return extractNativeConversation(
						identity,
						tabId,
						nativeId,
						Buffer.from(
							JSON.stringify({
								type: 'response_item',
								payload: {
									type: 'message',
									id: 'message',
									role: 'user',
									content: [{ type: 'input_text', text: 'Keep this verbatim' }],
								},
							})
						)
					);
				});
			const actual = await vi.importActual<
				typeof import('../../shared/maestro-lib/translation/transaction')
			>('../../shared/maestro-lib/translation/transaction');
			vi.mocked(applyTranslation).mockImplementation(actual.applyTranslation);
			const preflight = await service.run({
				agentId: 'agent',
				destination: 'claude-code',
				action: 'plan',
			});
			expect(preflight.plan?.status).toBe('ready');
			expect(preflight.plan?.tabs.map((tab) => tab.tabId)).toEqual(['open']);
			expect(preflight.plan?.deferredTabs?.map((tab) => tab.id)).toEqual([
				'blocked',
				'history:missing-history',
			]);
			const applied = await service.run({
				agentId: 'agent',
				destination: 'claude-code',
				action: 'apply',
				planId: preflight.plan!.id,
				acceptLimitations: true,
			});
			expect(applied.error).toBeUndefined();
			expect(applied.result?.state).toBe('committed');
			expect(read.mock.calls.every(([, tabId]) => tabId === 'open')).toBe(true);
			expect(session.aiTabs.find((tab) => tab.id === 'pinned')).toMatchObject({
				tabProvider: 'claude-code',
				agentSessionId: 'pinned-native',
			});
			expect(session.closedTabHistory[0].tab).toMatchObject({
				agentSessionId: null,
				providerSessions: { codex: { agentSessionId: 'missing-closed' } },
			});
			expect(session.providerTranslationTabInventory).toContainEqual(
				expect.objectContaining({
					id: 'history:missing-history',
					agentSessionId: null,
					providerSessions: expect.objectContaining({
						codex: expect.objectContaining({ agentSessionId: 'missing-history' }),
					}),
				})
			);
			// History makes a new tab ID for an already checkpointed conversation.
			session.aiTabs = [{ ...session.aiTabs[0], id: 'reopened', pendingTranslation: 'codex' }];
			const reopened = await service.run({
				agentId: 'agent',
				tabId: 'reopened',
				destination: 'claude-code',
				action: 'plan',
			});
			expect(reopened.error).toBeUndefined();
			expect(reopened.plan?.status).toBe('ready');
			expect(
				reopened.plan?.limitations.some(
					(limitation) => limitation.code === 'destination-divergence'
				)
			).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it.each([false, true])(
		'shares resources and lineage across tabs (source already parked: %s)',
		async (parked) => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-single-tab-'));
			try {
				vi.spyOn(app, 'getPath').mockReturnValue(path.join(root, 'data'));
				vi.mocked(execGitReadOnly).mockResolvedValue({
					exitCode: 128,
					stdout: '',
					stderr: 'fatal: not a git repository',
				});
				const history = vi.fn(async () => []);
				vi.mocked(getHistoryManager).mockReturnValue({ getEntries: history } as any);
				const source = {
					provider: 'codex' as const,
					version: '0.162.1',
					accountRoot: path.join(root, 'codex'),
					projectRoot: path.join(root, 'project'),
				};
				const destination = {
					...source,
					provider: 'claude-code' as const,
					version: '2.1.296',
					accountRoot: path.join(root, 'claude'),
				};
				const resources = [
					translationArtifact(
						'memory',
						'synthetic',
						'memory/MEMORY.md',
						Buffer.from('One retained memory')
					),
					translationArtifact(
						'skill',
						'synthetic-skill',
						'skills/sample/SKILL.md',
						Buffer.from('---\nname: sample\ndescription: Sample\n---\nRetained skill')
					),
				];
				vi.spyOn(translationResources, 'collectTranslationResources').mockResolvedValue({
					artifacts: resources,
					limitations: [],
				});
				let session = createMockSession({
					id: 'agent',
					toolType: parked ? 'claude-code' : 'codex',
					customModel: 'preserved',
					customEnvVars: { CUSTOM: 'retained' },
					aiTabs: ['one', 'two', 'blocked'].map((id) => ({
						id,
						agentSessionId: parked ? null : id,
						...(parked && { providerSessions: { codex: { agentSessionId: id } } }),
					})) as any,
				});
				const service = new ProviderTranslationService({
					sessionsStore: {
						get: () => [session],
						set: (_key: string, sessions: (typeof session)[]) => {
							session = sessions[0];
						},
					},
					agentConfigsStore: { get: () => ({}) },
					getProcessManager: () => ({ get: () => undefined }),
				} as unknown as ProviderTranslationDependencies);
				vi.spyOn(service as any, 'identity').mockImplementation(
					async (_session: unknown, provider: unknown) =>
						provider === 'codex' ? source : destination
				);
				const read = vi
					.spyOn(service as any, 'conversation')
					.mockImplementation(async (identity: any, tabId: any, nativeId: any) => {
						const conversation = extractNativeConversation(
							identity,
							tabId,
							nativeId,
							Buffer.from(
								JSON.stringify({
									type: 'response_item',
									payload: {
										type: 'message',
										id: nativeId,
										role: 'user',
										content: [{ type: 'input_text', text: `Raw ${tabId}` }],
									},
								})
							)
						);
						if (tabId === 'blocked')
							conversation.limitations.push({
								code: 'synthetic-block',
								severity: 'block',
								tabId,
								message: 'Cannot translate this tab',
							});
						return conversation;
					});
				const actual = await vi.importActual<
					typeof import('../../shared/maestro-lib/translation/transaction')
				>('../../shared/maestro-lib/translation/transaction');
				vi.mocked(applyTranslation).mockImplementation(actual.applyTranslation);
				const before = structuredClone(session);
				const journals: TranslationJournal[] = [];
				for (const tabId of ['one', 'two']) {
					const request = {
						agentId: 'agent',
						tabId,
						destination: 'claude-code' as const,
						projectResourcesIntoRepo: true,
					};
					const preflight = await service.run({ ...request, action: 'plan' });
					expect(preflight.plan?.tabs.map((tab) => tab.tabId)).toEqual([tabId]);
					expect(preflight.plan?.status).toBe('ready');
					const result = await service.run({
						...request,
						action: 'apply',
						planId: preflight.plan?.id,
						acceptLimitations: true,
					});
					expect(result.error).toBeUndefined();
					expect(result.result?.state).toBe('committed');
					expect(session.providerMigration?.acceptedDirections).toEqual([
						expect.objectContaining({
							source: 'codex',
							destination: 'claude-code',
							sourceVersion: source.version,
							destinationVersion: destination.version,
							warnings: expect.arrayContaining(
								preflight
									.plan!.limitations.filter((l) => l.severity === 'warning')
									.map(canonicalJson)
							),
						}),
					]);
					journals.push(await (service as any).archive.read('agent', result.plan!.id));
					const repeated = await service.run({
						...request,
						action: 'apply',
						planId: result.plan!.id,
						acceptLimitations: true,
					});
					expect(repeated.result).toEqual(result.result);
				}
				expect(history).not.toHaveBeenCalled();
				expect(read.mock.calls.every(([, tabId]) => tabId !== 'blocked')).toBe(true);
				expect(journals[1].resourceWrites).toEqual([]);
				expect(journals[1].knowledgeDirectory).toBe(journals[0].knowledgeDirectory);
				expect(
					journals[0].resourceWrites.some((write) => write.resourceKey === 'skills/sample/SKILL.md')
				).toBe(true);
				const checkpoint = await (service as any).archive.checkpoint('agent');
				expect(checkpoint.conversations.map((c: any) => c.tabId)).toEqual(['one', 'two']);
				expect(checkpoint.lineage).toMatchObject(journals[0].mappings[0].lineage);
				expect(session.aiTabs![2]).toEqual(before.aiTabs![2]);
				expect(session.toolType).toBe(before.toolType);
				expect(session.customModel).toBe('preserved');
				if (!parked)
					expect(session.providerOverrides?.['claude-code']?.customEnvVars).toMatchObject({
						CLAUDE_CONFIG_DIR: destination.accountRoot,
						[TRANSLATION_KNOWLEDGE_ENV_VAR]: journals[0].knowledgeDirectory,
					});
				expect(session.customEnvVars?.CUSTOM).toBe('retained');
				expect(session.customEnvVars?.CLAUDE_CONFIG_DIR).toBe(
					parked ? destination.accountRoot : undefined
				);
				const beforeBlock = structuredClone(session);
				const blocked = await service.run({
					agentId: 'agent',
					tabId: 'blocked',
					destination: 'claude-code',
					action: 'apply',
					acceptLimitations: true,
					projectResourcesIntoRepo: true,
				});
				expect(blocked.result?.state).toBe('refused');
				expect(session).toEqual(beforeBlock);
				const missing = await service.run({
					agentId: 'agent',
					tabId: 'missing',
					destination: 'claude-code',
					action: 'plan',
				});
				expect(missing.error).toContain('tab not found');
				const wrong = await service.run({
					agentId: 'agent',
					tabId: 'two',
					destination: 'claude-code',
					action: 'apply',
					planId: journals[0].plan.id,
				});
				expect(wrong.error).toContain('tab does not match');
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		}
	);
});

describe('app-local managed knowledge', () => {
	it('writes SSH knowledge through the native port and persists its host binding with a local journal', async () => {
		const root = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'translation-ssh-knowledge-'))
		);
		try {
			const userDataDir = path.join(root, 'data');
			const native = remapTranslationFs('/remote', path.join(root, 'remote'));
			native.nativeFs.paths = path.posix;
			const realpath = native.nativeFs.realpath.getMockImplementation()!;
			native.nativeFs.realpath.mockImplementation(async (file) =>
				(await realpath(file)).split(path.sep).join('/')
			);
			await native.nativeFs.mkdir('/remote', { recursive: true });
			const remoteIdentity = { remoteHost: translationHash('remote'), remoteHome: '/remote' };
			let session = createMockSession({
				id: 'remote-agent',
				toolType: 'codex',
				cwd: '/remote/project',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote' },
				aiTabs: [{ id: 'tab', agentSessionId: null }] as any,
			});
			vi.spyOn(translationResources, 'collectTranslationResources').mockResolvedValue({
				artifacts: [
					translationArtifact(
						'memory',
						'synthetic',
						'memory/MEMORY.md',
						Buffer.from('Remote fact')
					),
				],
				limitations: [],
			});
			const service = new NativeTranslationService({
				userDataDir,
				nativeFs: native.nativeFs,
				getSession: () => session,
				persist: async (_id, update) => {
					session = update(session) as typeof session;
				},
				resolveIdentity: async (_session, provider) => ({
					provider,
					version: provider === 'codex' ? '0.162.1' : '2.1.296',
					accountRoot: `/remote/${provider}`,
					projectRoot: '/remote/project',
					...remoteIdentity,
				}),
				getProvider: vi.fn(),
				providerConfig: () => ({}),
				globalEnv: () => ({}),
				isBusy: () => false,
				findCodexSessionFile: vi.fn(),
				history: async () => [],
				execGit: vi.fn(),
				execFile: vi.fn(),
				contextWindow: () => 200_000,
			});
			const actual = await vi.importActual<
				typeof import('../../shared/maestro-lib/translation/transaction')
			>('../../shared/maestro-lib/translation/transaction');
			vi.mocked(applyTranslation).mockImplementationOnce(actual.applyTranslation);
			const report = await service.run({
				agentId: session.id,
				destination: 'claude-code',
				action: 'apply',
				acceptLimitations: true,
			});
			expect(report.result?.state).toBe('committed');
			const directory = path.posix.join(
				'/remote/.maestro/provider-knowledge',
				translationHash(session.id),
				report.plan!.id
			);
			expect(session.providerTranslationKnowledgeDirectory).toBe(directory);
			expect(session.customEnvVars?.[TRANSLATION_KNOWLEDGE_ENV_VAR]).toBe(directory);
			expect(JSON.parse(session.customEnvVars![TRANSLATION_KNOWLEDGE_REMOTE_ENV_VAR])).toEqual(
				remoteIdentity
			);
			expect(await fs.readFile(native.backingPath(`${directory}/memory/MEMORY.md`), 'utf8')).toBe(
				'Remote fact'
			);
			expect(native.nativeFs.createExclusive).toHaveBeenCalledWith(
				`${directory}/knowledge-index.md`,
				expect.any(Buffer),
				expect.anything()
			);
			const archive = new TranslationArchive(path.join(userDataDir, 'provider-translations'));
			const journal = await archive.read(session.id, report.plan!.id);
			expect(journal.knowledgeDirectory).toBe(directory);
			await expect(fs.stat(path.join(userDataDir, 'provider-knowledge'))).rejects.toMatchObject({
				code: 'ENOENT',
			});
			// A remote journal cannot acquire local filesystem authority after SSH is disabled.
			session.sessionSshRemoteConfig = undefined;
			expect(() => (service as any).host(journal)).toThrow('does not match the launch host');
		} finally {
			vi.mocked(applyTranslation).mockReset();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
	it.each(['default', 'git', 'non-git'] as const)(
		'keeps knowledge app-local and installs resources only by consent (%s)',
		async (mode) => {
			const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-app-data-'));
			try {
				const userData = path.join(root, 'data');
				vi.mocked(execGitReadOnly).mockImplementation(async (args) =>
					mode === 'git'
						? {
								exitCode: 0,
								stdout: args.includes('--git-common-dir') ? '../git-common' : root,
								stderr: '',
							}
						: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }
				);
				vi.spyOn(app, 'getPath').mockReturnValue(userData);
				vi.spyOn(TranslationArchive.prototype, 'checkpoint').mockResolvedValue(undefined);
				vi.mocked(getHistoryManager).mockReturnValue({ getEntries: vi.fn(async () => []) } as any);
				vi.spyOn(translationResources, 'collectTranslationResources').mockResolvedValue({
					artifacts: [
						translationArtifact(
							'memory',
							'synthetic',
							'memory/MEMORY.md',
							Buffer.from('Selected fact')
						),
						translationArtifact(
							'instruction',
							'synthetic',
							'AGENTS.md',
							Buffer.from('Project instructions')
						),
					],
					limitations: [],
				});
				let session = createMockSession({
					id: 'agent',
					toolType: 'codex',
					aiTabs: [{ id: 'tab', agentSessionId: null }] as any,
				});
				const service = new ProviderTranslationService({
					sessionsStore: {
						get: () => [session],
						set: (_key: string, sessions: (typeof session)[]) => {
							session = sessions[0];
						},
					},
					agentConfigsStore: { get: () => ({}) },
					getProcessManager: () => ({ get: () => undefined }),
				} as unknown as ProviderTranslationDependencies);
				vi.spyOn(service as any, 'identity').mockImplementation(
					async (_session: unknown, provider: unknown) => ({
						provider,
						version: provider === 'codex' ? '0.162.1' : '2.1.296',
						accountRoot: path.join(root, String(provider)),
						projectRoot: path.join(root, 'project'),
					})
				);
				const journal: TranslationJournal = await (service as any).prepare({
					agentId: 'agent',
					destination: 'claude-code',
					action: 'plan',
					...(mode !== 'default' && { projectResourcesIntoRepo: true }),
				});
				const host = (service as any).host(journal);
				expect(host.knowledgeRoot).toBe(path.join(userData, 'provider-knowledge'));
				const { applyTranslation: apply } = await vi.importActual<
					typeof import('../../shared/maestro-lib/translation/transaction')
				>('../../shared/maestro-lib/translation/transaction');
				const result = await apply(
					(service as any).archive,
					(service as any).registry,
					journal,
					host,
					true
				);
				expect(result.state).toBe('committed');
				const directory = path.join(host.knowledgeRoot, translationHash('agent'), journal.plan.id);
				expect(session.providerTranslationKnowledgeDirectory).toBe(directory);
				expect(session.customEnvVars?.[TRANSLATION_KNOWLEDGE_ENV_VAR]).toBe(directory);
				expect(await fs.readFile(path.join(directory, 'memory/MEMORY.md'), 'utf8')).toBe(
					'Selected fact'
				);
				if (mode === 'default') {
					expect(journal.plan.limitations).toContainEqual(
						expect.objectContaining({ code: 'resource-not-projected', severity: 'info' })
					);
					await expect(fs.readdir(path.join(root, 'project'))).rejects.toMatchObject({
						code: 'ENOENT',
					});
				} else {
					expect(await fs.readFile(path.join(root, 'project/CLAUDE.md'), 'utf8')).toBe(
						'Project instructions'
					);
					if (mode === 'git') {
						expect(execGitReadOnly).toHaveBeenCalledWith(
							['rev-parse', '--git-common-dir'],
							path.join(root, 'project')
						);
						expect(await fs.readFile(path.join(root, 'git-common/info/exclude'), 'utf8')).toContain(
							'/project/CLAUDE.md'
						);
					} else {
						expect(journal.plan.limitations).toContainEqual(
							expect.objectContaining({
								code: 'resource-git-exclude-unavailable',
								severity: 'info',
							})
						);
						await expect(fs.stat(path.join(root, 'git-common'))).rejects.toMatchObject({
							code: 'ENOENT',
						});
					}
				}
			} finally {
				await fs.rm(root, { recursive: true, force: true });
			}
		}
	);
});

describe('provider translation plan telemetry', () => {
	it.each(['ready', 'blocked', 'deferred', 'noop'] as const)(
		'reports exactly the allowed metadata and severity counts once for a %s plan',
		async (status) => {
			vi.mocked(captureMessage).mockClear();
			vi.spyOn(TranslationArchive.prototype, 'checkpoint').mockResolvedValue(undefined);
			vi.mocked(getHistoryManager).mockReturnValue({ getEntries: vi.fn(async () => []) } as any);
			vi.spyOn(translationResources, 'collectTranslationResources').mockResolvedValue({
				artifacts: [],
				limitations: [
					...(['info', 'info', 'warning'] as const).map((severity, index) => ({
						code: 'shared-code',
						severity,
						message: `Private conversation content ${index}`,
						tabId: `private-tab-${index}`,
						artifactId: `private-artifact-${index}`,
					})),
					...(status === 'blocked'
						? [{ code: 'blocked-code', severity: 'block' as const, message: '/private/path' }]
						: []),
				],
			});
			const session = createMockSession({
				id: 'private-agent',
				toolType: 'codex',
				aiTabs: [{ id: 'private-tab', agentSessionId: null }] as any,
			});
			const service = new ProviderTranslationService({
				agentConfigsStore: { get: () => ({}) },
				sessionsStore: { get: vi.fn(() => [session]) },
				getProcessManager: () => ({ get: () => (status === 'deferred' ? {} : undefined) }),
			} as unknown as ProviderTranslationDependencies);
			vi.spyOn(service as any, 'identity').mockImplementation(
				async (_session: unknown, provider: unknown) => ({
					provider,
					version: provider === 'codex' ? '0.162.1' : '2.1.296',
					accountRoot: '/private/account',
					projectRoot: '/private/project',
				})
			);
			const journal = await (service as any).prepare({
				agentId: session.id,
				destination: status === 'noop' ? 'codex' : 'claude-code',
				action: 'plan',
			});
			expect(journal.plan.status).toBe(status);
			expect(captureMessage).toHaveBeenCalledExactlyOnceWith('provider-translation-plan', 'info', {
				sourceProvider: 'codex',
				destinationProvider: status === 'noop' ? 'codex' : 'claude-code',
				sourceVersion: '0.162.1',
				destinationVersion: status === 'noop' ? '0.162.1' : '2.1.296',
				status,
				verification: 'unverified',
				limitationCounts: {
					info: status === 'noop' ? {} : { 'shared-code': 2 },
					warning:
						status === 'noop'
							? {}
							: {
									'shared-code': 1,
									'native-project-memory-unavailable': 1,
									'unverified-native-resume': 1,
								},
					block: status === 'blocked' ? { 'blocked-code': 1 } : {},
				},
			});
			expect(Object.keys(vi.mocked(captureMessage).mock.calls[0][2]!)).toEqual([
				'sourceProvider',
				'destinationProvider',
				'sourceVersion',
				'destinationVersion',
				'status',
				'verification',
				'limitationCounts',
			]);
		}
	);
});

describe('provider translation context capacity', () => {
	it.each([
		['claude-compactions', 'claude-code', 7],
		['codex-compacted-replacement', 'codex', 4],
		['codex-compacted-message', 'codex', 4],
	] as const)(
		'keeps the %s window intact and makes estimated overflow advisory',
		async (fixture, provider, archivedCount) => {
			vi.spyOn(TranslationArchive.prototype, 'checkpoint').mockResolvedValue(undefined);
			vi.mocked(getHistoryManager).mockReturnValue({ getEntries: vi.fn(async () => []) } as any);
			vi.spyOn(translationResources, 'collectTranslationResources').mockResolvedValue({
				artifacts: [],
				limitations: [],
			});
			const source = {
				provider,
				version: provider === 'codex' ? '0.162.1' : '2.1.296',
				accountRoot: `/isolated/${provider}`,
				projectRoot: '/isolated/project',
			};
			const bytes = await fs.readFile(
				path.resolve('src/__tests__/fixtures/provider-translation', `${fixture}.jsonl`)
			);
			const conversation = extractNativeConversation(source, 'tab', 'synthetic-compacted', bytes);
			// Fixture positions define the expected window independently of its window flags.
			const activeTokens = estimateTokenCount(
				canonicalJson(
					projectConversation(
						{ ...conversation, records: conversation.records.slice(archivedCount) },
						provider === 'codex' ? 'claude-code' : 'codex',
						'capacity-preview',
						provider === 'codex' ? '2.1.296' : '0.162.1'
					).map((row) => row.item)
				)
			);
			// Measure the full history with the same native message and tool overhead.
			const allTokens = estimateTokenCount(
				canonicalJson(
					projectConversation(
						{
							...conversation,
							records: conversation.records.map((record) => ({
								...record,
								window: 'active' as const,
							})),
						},
						provider === 'codex' ? 'claude-code' : 'codex',
						'capacity-preview',
						provider === 'codex' ? '2.1.296' : '0.162.1'
					).map((row) => row.item)
				)
			);
			expect(allTokens).toBeGreaterThan(activeTokens);
			const capacity = vi.spyOn(capabilitySnapshots, 'get');
			const session = createMockSession({
				id: 'agent',
				toolType: provider,
				aiTabs: [{ id: 'tab', agentSessionId: 'synthetic-compacted' }] as any,
			});
			const configs: Record<string, Record<string, unknown>> = {};
			const service = new ProviderTranslationService({
				agentConfigsStore: { get: () => configs },
				sessionsStore: { get: vi.fn(() => [session]) },
				getProcessManager: () => ({ get: () => undefined }),
			} as unknown as ProviderTranslationDependencies);
			vi.spyOn(service as any, 'identity').mockImplementation(
				async (_session: unknown, selected: unknown) => ({
					...source,
					provider: selected,
					version: selected === 'codex' ? '0.162.1' : '2.1.296',
				})
			);
			vi.spyOn(service as any, 'conversation').mockResolvedValue(conversation);
			for (const contextWindow of [activeTokens, activeTokens - 1]) {
				capacity.mockReturnValue({ contextWindow } as any);
				const journal: TranslationJournal = await (service as any).prepare({
					agentId: session.id,
					destination: provider === 'codex' ? 'claude-code' : 'codex',
					action: 'plan',
				});
				expect(journal.plan.status).toBe('ready');
				expect(
					journal.plan.limitations
						.filter((limit) => limit.code === 'context-capacity')
						.map((limit) => limit.severity)
				).toEqual(contextWindow === activeTokens ? [] : ['warning']);
				expect(journal.conversations[0].records).toEqual(conversation.records);
				expect(Buffer.from(journal.conversations[0].artifacts[0].bytesBase64, 'base64')).toEqual(
					bytes
				);
			}
			if (provider === 'codex') {
				configs['claude-code'] = { contextWindow: activeTokens - 1, model: 'opus[1m]' };
				const journal: TranslationJournal = await (service as any).prepare({
					agentId: session.id,
					destination: 'claude-code',
					action: 'plan',
				});
				expect(journal.plan.status).toBe('ready');
				expect(journal.plan.limitations.some((limit) => limit.code === 'context-capacity')).toBe(
					false
				);
			}
		}
	);
	it.each(['compacted', 'active-overflow', 'legacy'] as const)(
		'estimates only the active context for %s history',
		async (variant) => {
			vi.spyOn(TranslationArchive.prototype, 'checkpoint').mockResolvedValue(undefined);
			vi.mocked(getHistoryManager).mockReturnValue({ getEntries: vi.fn(async () => []) } as any);
			vi.spyOn(translationResources, 'collectTranslationResources').mockResolvedValue({
				artifacts: [],
				limitations: [],
			});
			vi.spyOn(capabilitySnapshots, 'get').mockReturnValue({ contextWindow: 256 } as any);
			const source = {
				provider: 'claude-code' as const,
				version: '2.1.296',
				accountRoot: '/isolated/claude',
				projectRoot: '/isolated/project',
			};
			const rows = [
				{
					type: 'user',
					uuid: 'old',
					message: { role: 'user', content: 'Old context '.repeat(2048) },
				},
				...(variant === 'legacy'
					? []
					: [{ type: 'system', uuid: 'boundary', subtype: 'compact_boundary' }]),
				{
					type: 'user',
					uuid: 'summary',
					isCompactSummary: variant !== 'legacy',
					message: {
						role: 'user',
						content:
							variant === 'active-overflow'
								? 'Large active context '.repeat(2048)
								: 'Provider summary',
					},
				},
			];
			const conversation = extractNativeConversation(
				source,
				'tab',
				'native',
				Buffer.from(rows.map((row) => JSON.stringify(row)).join('\n'))
			);
			if (variant === 'legacy') for (const record of conversation.records) delete record.window;
			const session = createMockSession({
				id: 'agent',
				toolType: 'claude-code',
				aiTabs: [{ id: 'tab', agentSessionId: 'native' }] as any,
			});
			const service = new ProviderTranslationService({
				agentConfigsStore: { get: () => ({}) },
				sessionsStore: { get: vi.fn(() => [session]) },
				getProcessManager: () => ({ get: () => undefined }),
			} as unknown as ProviderTranslationDependencies);
			vi.spyOn(service as any, 'identity').mockImplementation(
				async (_session: unknown, provider: unknown) => ({
					...source,
					provider,
					version: provider === 'codex' ? '0.162.1' : source.version,
				})
			);
			vi.spyOn(service as any, 'conversation').mockResolvedValue(conversation);
			const journal: TranslationJournal = await (service as any).prepare({
				agentId: session.id,
				destination: 'codex',
				action: 'plan',
			});
			expect(journal.plan.status).toBe('ready');
			expect(journal.plan.limitations.some((limit) => limit.code === 'context-capacity')).toBe(
				variant !== 'compacted'
			);
			expect(journal.plan.tabs[0]).toMatchObject({
				records: variant === 'legacy' ? 2 : 3,
				activeRecords: variant === 'legacy' ? 2 : 1,
				archivedRecords: variant === 'legacy' ? 0 : 2,
			});
			expect(journal.conversations[0].records[0].blocks).toEqual(conversation.records[0].blocks);
		}
	);
});

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
	it.each([
		{
			oversized: false,
			configured: undefined,
			parked: undefined,
			sourceWindow: undefined,
			warns: false,
		},
		{
			oversized: true,
			configured: undefined,
			parked: undefined,
			sourceWindow: undefined,
			warns: true,
		},
		{
			oversized: true,
			configured: 1_000_000,
			parked: undefined,
			sourceWindow: undefined,
			warns: false,
		},
		{
			oversized: true,
			configured: undefined,
			parked: 1_000_000,
			sourceWindow: undefined,
			warns: false,
		},
		{
			oversized: true,
			configured: undefined,
			parked: undefined,
			sourceWindow: 1_000_000,
			warns: true,
		},
	])(
		'uses destination capacity without borrowing source settings: %j',
		async ({ oversized, configured, parked, sourceWindow, warns }) => {
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
					customContextWindow: sourceWindow,
					providerOverrides: { codex: { customContextWindow: parked } },
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
					agentConfigsStore: { get: () => ({ codex: { contextWindow: configured } }) },
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
				).toBe(warns);
				expect(journal.plan.status).toBe('ready');
				if (warns)
					expect(journal.plan.limitations).toContainEqual(
						expect.objectContaining({ code: 'context-capacity', severity: 'warning' })
					);
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
	it.each(['transcript', 'memory', 'knowledge-directory', 'legacy-knowledge-directory'] as const)(
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
				vi.spyOn(app, 'getPath').mockReturnValue(path.join(root, 'data'));
				const knowledge = path.join(
					variant === 'legacy-knowledge-directory'
						? path.join(source.projectRoot, '.maestro/provider-knowledge')
						: path.join(root, 'data/provider-knowledge'),
					translationHash('agent'),
					generateUUID()
				);
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
				if (variant === 'legacy-knowledge-directory')
					await expect(
						(service as any).host(journal).assertSourceUnchanged(journal)
					).rejects.toThrow('Unsafe');
				const host = (service as any).host(journal, variant === 'legacy-knowledge-directory');
				await host.assertSourceUnchanged(journal);
				const external = path.join(root, 'unselected.jsonl');
				if (variant.endsWith('knowledge-directory')) {
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
				vi.spyOn(app, 'getPath').mockReturnValue(path.join(root, 'data'));
				const knowledge = path.join(
					root,
					'data/provider-knowledge',
					translationHash('agent'),
					generateUUID()
				);
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
				} else {
					await fs.mkdir(source.projectRoot, { recursive: true });
					await fs.symlink(external, ownedPath);
				}
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
					agentConfigsStore: { get: () => ({}) },
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
			vi.spyOn(app, 'getPath').mockReturnValue(path.join(root, 'data'));
			const knowledge = path.join(
				root,
				'data/provider-knowledge',
				translationHash('agent'),
				generateUUID()
			);
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
				agentConfigsStore: { get: () => ({}) },
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
		{
			name: 'info-only plan',
			status: 'ready',
			warnings: false,
			info: true,
			accept: undefined,
			opens: true,
		},
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
					: scenario.info
						? [{ code: 'native-cwd-drift', severity: 'info', message: 'Archived cwd' }]
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
