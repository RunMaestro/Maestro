import {
	analyzeMemoryLinks,
	discoverClaudeMemoryRoot,
	resolveMemoryRepositoryRoot,
} from '../shared/maestro-lib/translation/memory';
import {
	planResourceProjections,
	nativeResourceVariant,
	assertTranslationTarget,
} from '../shared/maestro-lib/translation/resource-projections';
import { TRANSLATION_KNOWLEDGE_ENV_VAR } from '../shared/maestro-lib/translation/knowledge-binding';
import { estimateTokenCount } from '../shared/formatters';
import { getContextWindowForAgent } from '../shared/agentConstants';
import { app } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type Store from 'electron-store';
import type { AgentDetector } from './agents';
import type { AgentConfigsData, SessionsData, StoredSession } from './stores/types';
import type { MaestroSettings } from './ipc/handlers/persistence';
import { broadcastSessionLifecycle } from './ipc/handlers/persistence';
import { isAgentBusy, type ProcessLivenessProbe } from './utils/agent-busy';
import { capabilitySnapshots } from './agents/capability-snapshot';
import { execGitReadOnly } from './utils/remote-git';
import { execFileNoThrow } from './utils/execFile';
import { CodexSessionStorage } from './storage/codex-session-storage';
import { getHistoryManager } from './history-manager';
import { resolveAgentAccountKey } from '../shared/providerProfiles';
import { buildAgentEnvironment } from '../shared/maestro-lib/launch/env';
import { expandTilde, encodeClaudeProjectPath } from '../shared/pathUtils';
import { AGENT_IDS } from '../shared/agentIds';
import { canonicalJson } from '../shared/canonicalJson';
import { isPathAtOrUnderRoot } from '../shared/worktreePaths';
import { createKeyedWriteQueue } from '../shared/keyedWriteQueue';
import {
	createTranslationRegistry,
	projectConversation,
} from '../shared/maestro-lib/translation/adapters';
import {
	TranslationArchive,
	type TranslationJournal,
} from '../shared/maestro-lib/translation/archive';
import { planTranslation } from '../shared/maestro-lib/translation/registry';
import {
	reconcileConversation,
	reconcileResource,
} from '../shared/maestro-lib/translation/reconcile';
import { collectTranslationResources } from '../shared/maestro-lib/translation/resources';
import { translationHash, nativeRecordKey } from '../shared/maestro-lib/translation/identity';
import {
	commitTranslationSession,
	translationSessionTabs,
	type TranslatableSession,
} from '../shared/maestro-lib/translation/session';
import {
	applyTranslation,
	recoverTranslation,
	type TranslationTransactionHost,
} from '../shared/maestro-lib/translation/transaction';
import { openCodexTranslationConnection } from '../shared/maestro-lib/codex/connection';
import type { ToolType } from '../shared/types';
import type {
	PortableConversation,
	TranslationArtifact,
	TranslationCheckpoint,
	TranslationIdentity,
	TranslationLimitation,
	TranslationReport,
	TranslationRequest,
} from '../shared/maestro-lib/translation/types';
import { TranslationSourceBusyError } from '../shared/maestro-lib/translation/types';

export interface ProviderTranslationDependencies {
	sessionsStore: Store<SessionsData>;
	settingsStore: Store<MaestroSettings>;
	agentConfigsStore: Store<AgentConfigsData>;
	getAgentDetector(): AgentDetector | null;
	getProcessManager(): ProcessLivenessProbe | null;
}

export class ProviderTranslationService {
	private readonly registry = createTranslationRegistry();
	private readonly queue = createKeyedWriteQueue();
	private readonly archive = new TranslationArchive(
		path.join(app.getPath('userData'), 'provider-translations')
	);
	constructor(private readonly deps: ProviderTranslationDependencies) {}
	private session(agentId: string): StoredSession & TranslatableSession {
		const session = this.deps.sessionsStore.get('sessions', []).find((s) => s.id === agentId);
		if (!session) throw new Error('Agent not found');
		return session as StoredSession & TranslatableSession;
	}
	private persist(
		agentId: string,
		update: (session: StoredSession & TranslatableSession) => StoredSession
	): void {
		const before = this.session(agentId);
		const next = update(before);
		this.deps.sessionsStore.set(
			'sessions',
			this.deps.sessionsStore.get('sessions', []).map((s) => (s.id === agentId ? next : s))
		);
		broadcastSessionLifecycle(undefined, {
			added: [],
			removedIds: [],
			baselines: [before],
			updated: [next],
		});
	}
	private async identity(
		session: StoredSession,
		provider: ToolType,
		source: boolean,
		checkpoint?: TranslationCheckpoint
	): Promise<TranslationIdentity> {
		const detector = this.deps.getAgentDetector();
		if (!detector) throw new Error('Agent detector unavailable');
		const detected = await detector.getAgent(provider);
		const providerConfig = this.deps.agentConfigsStore.get('configs', {})[provider] ?? {};
		const env = buildAgentEnvironment({
			surface: 'desktop',
			globalShellEnvVars: this.deps.settingsStore.get('shellEnvVars', {}) as Record<string, string>,
			defaultEnvVars: detected?.defaultEnvVars,
			sessionCustomEnvVars: source ? session.customEnvVars : undefined,
			agentCustomEnvVars: providerConfig.customEnvVars as Record<string, string> | undefined,
		});
		const selectedRoot = !source ? checkpoint?.providerRoots[provider]?.accountRoot : undefined;
		const accountRoot =
			selectedRoot ?? resolveAgentAccountKey(provider, env as Record<string, string>, os.homedir());
		if (!accountRoot && this.registry.get(provider))
			throw new Error('Cannot resolve selected provider account');
		let root = accountRoot ? path.resolve(expandTilde(accountRoot)) : '';
		try {
			root = await fs.realpath(root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		const customBinary = source ? session.customPath : undefined;
		const binary = customBinary || detected?.path;
		let version = '';
		if (binary) {
			const probe = await execFileNoThrow(binary, ['--version']);
			if (probe.exitCode === 0) version = /\d+\.\d+\.\d+/.exec(probe.stdout)?.[0] ?? '';
		}
		const projectRoot = await fs.realpath(session.projectRoot || session.cwd);
		let nativeSessionRoot: string | undefined;
		if (provider === 'claude-code') {
			nativeSessionRoot = path.join(root, 'projects');
			try {
				nativeSessionRoot = await fs.realpath(nativeSessionRoot);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
		}
		const memoryProjectRoot = await resolveMemoryRepositoryRoot(projectRoot, async (cwd) => {
			const result = await execGitReadOnly(['rev-parse', '--git-common-dir'], cwd);
			return result.exitCode === 0 ? result.stdout : undefined;
		});
		const userResourceRoots: NonNullable<TranslationIdentity['userResourceRoots']> = [
			{ path: path.join(os.homedir(), '.agents', 'skills'), kind: 'skill' },
		];
		if (provider === 'claude-code') {
			const memory = await discoverClaudeMemoryRoot(projectRoot, root, memoryProjectRoot);
			if (memory.source === 'account')
				userResourceRoots.push({ path: memory.path, kind: 'memory' });
		}
		return {
			provider,
			version,
			accountRoot: root,
			...(nativeSessionRoot && { nativeSessionRoot }),
			projectRoot,
			memoryProjectRoot,
			userResourceRoots,
		};
	}
	private async conversation(
		identity: TranslationIdentity,
		tabId: string,
		sessionId: string | null
	): Promise<PortableConversation> {
		if (!sessionId)
			return {
				tabId,
				nativeSessionId: null,
				identity,
				records: [],
				artifacts: [],
				limitations: [],
			};
		const adapter = this.registry.get(identity.provider);
		if (!adapter)
			return {
				tabId,
				nativeSessionId: sessionId,
				identity,
				records: [],
				artifacts: [],
				limitations: [
					{
						code: 'unsupported-provider',
						severity: 'block',
						tabId,
						message: `No native reader for ${identity.provider}.`,
					},
				],
			};
		if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Unsafe native session ID');
		const file =
			identity.provider === 'claude-code'
				? path.join(
						identity.nativeSessionRoot ?? path.join(identity.accountRoot, 'projects'),
						encodeClaudeProjectPath(identity.projectRoot),
						`${sessionId}.jsonl`
					)
				: await new CodexSessionStorage().findSessionFile(sessionId, identity.accountRoot);
		if (!file) throw new Error(`Selected native session missing for tab ${tabId}`);
		await assertTranslationTarget(file, identity.nativeSessionRoot ?? identity.accountRoot);
		const stat = await fs.stat(file);
		const bytes = await fs.readFile(file);
		const after = await fs.stat(file);
		if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs)
			throw new Error('Native source changed during snapshot');
		const bundle = adapter.extract(identity, tabId, sessionId, bytes);
		bundle.artifacts[0].sourcePath = file;
		return bundle;
	}
	private async prepare(request: TranslationRequest): Promise<TranslationJournal> {
		const session = this.session(request.agentId);
		if (!this.deps.getProcessManager())
			throw new Error(
				'Live process ownership is unavailable; native migration cannot be planned safely'
			);
		const checkpoint = await this.archive.checkpoint(session.id);
		const source = await this.identity(session, session.toolType, true, checkpoint);
		const destination = await this.identity(session, request.destination, false, checkpoint);
		const scope = {
			projectKnowledge: true as const,
			selectedUserResources: request.selectedUserResources ?? [],
		};
		const busy = isAgentBusy(
			{ ...session, aiTabs: translationSessionTabs(session) },
			this.deps.getProcessManager()
		);
		const limitations: TranslationLimitation[] = [];
		if (session.sessionSshRemoteConfig?.enabled || session.sshRemoteId)
			limitations.push({
				code: 'remote-translation',
				severity: 'block',
				message:
					'Remote native translation requires an SSH adapter; local roots cannot stand in for remote accounts.',
			});
		const tabs = translationSessionTabs(session);
		const conversations: PortableConversation[] = [];
		const newRecords: Record<string, number> = {};
		const nextCheckpoint: TranslationCheckpoint = checkpoint
			? structuredClone(checkpoint)
			: {
					observed: {},
					lineage: {},
					conversations: [],
					resources: [],
					resourceBases: {},
					providerRoots: {},
				};
		// Do not snapshot a partial source tail while a turn is running.
		if (!busy && source.provider !== destination.provider) {
			for (const tab of tabs) {
				const native = await this.conversation(source, tab.id, tab.agentSessionId);
				if (
					!tab.agentSessionId &&
					(tab as any).logs?.some((l: any) => l.source === 'user' || l.source === 'ai')
				)
					native.limitations.push({
						code: 'missing-native-session',
						severity: 'block',
						tabId: tab.id,
						message:
							'Displayed conversation has no native identity. A flattened transcript cannot be used as transport.',
					});
				const reconciled = reconcileConversation(native, checkpoint);
				// A parked destination with independently authored deltas is a real fork, not an overwrite warrant.
				const parkedId = tab.providerSessions?.[destination.provider]?.agentSessionId;
				if (parkedId) {
					const parked = await this.conversation(destination, tab.id, parkedId);
					const parkedResult = reconcileConversation(parked, checkpoint);
					limitations.push(...parkedResult.limitations);
					if (parkedResult.newRecords > 0)
						limitations.push({
							code: 'destination-divergence',
							severity: 'block',
							tabId: tab.id,
							message:
								'Parked destination has new native events. Both branches are retained; choose the branch before applying.',
						});
					for (const artifact of parked.artifacts) reconciled.conversation.artifacts.push(artifact);
				}
				conversations.push(reconciled.conversation);
				newRecords[tab.id] = reconciled.newRecords;
				for (const record of native.records)
					nextCheckpoint.observed[nativeRecordKey(source, tab.agentSessionId!, record.nativeId)] =
						record.semanticHash;
			}
			// Closed native histories are selected by this agent's History, never by scanning the project wholesale.
			const history = await getHistoryManager().getEntries(session.id);
			const selectedIds = new Set(tabs.map((t) => t.agentSessionId).filter(Boolean));
			for (const entry of history) {
				if (!entry.agentSessionId || selectedIds.has(entry.agentSessionId)) continue;
				selectedIds.add(entry.agentSessionId);
				const key = `history:${entry.agentSessionId}`;
				try {
					const mapped = session.providerTranslationHistoryMappings?.find(
						(m: any) => m.tabId === key
					)?.destinationSessionId;
					const nativeId = mapped ?? entry.agentSessionId;
					if (mapped && tabs.some((tab) => tab.agentSessionId === mapped)) continue;
					const native = await this.conversation(source, key, nativeId);
					conversations.push(reconcileConversation(native, checkpoint).conversation);
					for (const record of native.records)
						nextCheckpoint.observed[nativeRecordKey(source, nativeId, record.nativeId)] =
							record.semanticHash;
				} catch {
					conversations.push({
						tabId: key,
						nativeSessionId: entry.agentSessionId,
						identity: source,
						records: [],
						artifacts: [],
						limitations: [],
					});
					limitations.push({
						code: 'history-provider-ownership',
						severity: 'warning',
						message: `History ${entry.agentSessionId} has no current-provider ownership proof. Its Maestro record remains intact; it is not imported under a guessed provider.`,
					});
				}
			}
		} else
			for (const tab of tabs)
				conversations.push({
					tabId: tab.id,
					nativeSessionId: tab.agentSessionId,
					identity: source,
					records: [],
					artifacts: [],
					limitations: [],
				});
		if (source.provider === 'codex' && !checkpoint)
			limitations.push({
				code: 'native-project-memory-unavailable',
				severity: 'warning',
				message:
					'Generated Codex account memory is excluded from project migration. Select specific user-level resources; no native scoped project-memory export is declared for this version.',
			});
		const nativeResources = await collectTranslationResources(source, scope);
		limitations.push(...nativeResources.limitations);
		const resources = new Map(
			nativeResources.artifacts
				.filter((a) => !checkpoint?.ownedResources?.[a.sourcePath])
				.map((a) => [a.relativePath, a])
		);
		nextCheckpoint.resourceTombstones ??= {};
		for (const [key, tombstone] of Object.entries(nextCheckpoint.resourceTombstones)) {
			const original = resources.get(key);
			if (!original) continue;
			if (original.sha256 === tombstone.originSha256) resources.delete(key);
			else
				limitations.push({
					code: 'resource-conflict',
					severity: 'block',
					artifactId: original.id,
					message: `Native resource ${key} changed after a deletion tombstone. Both versions are retained.`,
				});
		}

		if (checkpoint && session.providerTranslationKnowledgeDirectory) {
			await assertTranslationTarget(
				session.providerTranslationKnowledgeDirectory,
				source.projectRoot
			);
			const managedResources = await collectTranslationResources(
				source,
				{ projectKnowledge: true, selectedUserResources: [] },
				session.providerTranslationKnowledgeDirectory
			);
			limitations.push(...managedResources.limitations);
			const previousPaths = new Set(checkpoint.resources.map((a) => a.relativePath));
			for (const artifact of managedResources.artifacts)
				if (!previousPaths.has(artifact.relativePath)) {
					resources.set(artifact.relativePath, artifact);
					delete nextCheckpoint.resourceTombstones[artifact.relativePath];
				}
			for (const base of checkpoint.resources) {
				let managed: TranslationArtifact | null = null;
				const managedPath = path.join(
					session.providerTranslationKnowledgeDirectory,
					base.relativePath
				);
				try {
					await assertTranslationTarget(managedPath, session.providerTranslationKnowledgeDirectory);
					const bytes = await fs.readFile(managedPath);
					managed = {
						...base,
						sourcePath: managedPath,
						bytesBase64: bytes.toString('base64'),
						sha256: translationHash(bytes),
						...(base.metadata?.directoryLink
							? {
									metadata: { ...base.metadata, directoryLink: false, originalDirectoryLink: true },
								}
							: {}),
					};
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				}
				let original: TranslationArtifact | null = resources.get(base.relativePath) ?? null;
				if (!original) {
					const file = base.originPath ?? base.sourcePath;
					try {
						const bytes =
							base.metadata?.directoryLink || base.metadata?.originalDirectoryLink
								? Buffer.from(await fs.readlink(file))
								: await fs.readFile(file);
						original = {
							...base,
							sourcePath: file,
							bytesBase64: bytes.toString('base64'),
							sha256: translationHash(bytes),
						};
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
					}
				}
				let activeVariant = managed;
				for (const [file, owned] of Object.entries(checkpoint.ownedResources ?? {})) {
					if (owned.resourceKey !== base.relativePath) continue;
					let bytes: Buffer | undefined;
					try {
						await assertTranslationTarget(file, source.projectRoot);
						bytes = await fs.readFile(file);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
					}
					if (bytes && translationHash(bytes) === owned.sha256) continue;
					const variant = bytes ? nativeResourceVariant(base, file, bytes, owned.format) : null;
					if (
						(activeVariant?.sha256 ?? null) !== base.sha256 &&
						(activeVariant?.sha256 ?? null) !== (variant?.sha256 ?? null)
					) {
						limitations.push({
							code: 'resource-conflict',
							severity: 'block',
							artifactId: base.id,
							message: `Native and managed versions both changed: ${base.relativePath}. Both variants are retained.`,
						});
						if (variant)
							resources.set(`conflicts/${translationHash(file)}/${base.relativePath}`, {
								...variant,
								relativePath: `conflicts/${translationHash(file)}/${base.relativePath}`,
							});
					} else activeVariant = variant;
				}
				const delta = reconcileResource(
					base.sha256,
					activeVariant?.sha256 ?? null,
					original?.sha256 ?? null
				);
				if (delta.state === 'conflict') {
					limitations.push({
						code: 'resource-conflict',
						severity: 'block',
						artifactId: base.id,
						message: `Both versions changed: ${base.relativePath}. Native and managed variants are retained.`,
					});
					if (activeVariant)
						resources.set(`conflicts/${base.id}/${base.relativePath}`, {
							...activeVariant,
							relativePath: `conflicts/${base.id}/${base.relativePath}`,
						});
					if (original) resources.set(base.relativePath, original);
				} else if (delta.value === null) {
					resources.delete(base.relativePath);
					nextCheckpoint.resourceBases[base.relativePath] = null;
					nextCheckpoint.resourceTombstones[base.relativePath] = {
						originPath: base.originPath ?? base.sourcePath,
						originSha256: base.originSha256 ?? base.sha256,
					};
					if (base.kind === 'instruction')
						limitations.push({
							code: 'instruction-deletion',
							severity: 'block',
							artifactId: base.id,
							message:
								'A managed instruction deletion cannot disable a user-owned native instruction file. Resolve its canonical discovery binding first.',
						});
				} else {
					const selected = (
						delta.state === 'destination' ? original : (activeVariant ?? original)
					)!;
					resources.set(base.relativePath, {
						...selected,
						...(original && original.sha256 === delta.value
							? { originSha256: original.sha256 }
							: {}),
					});
				}
			}
		}
		const memoryLinks = analyzeMemoryLinks(
			new Map(
				[...resources.values()]
					.filter((a) => a.kind === 'memory')
					.map((a) => [a.relativePath, Buffer.from(a.bytesBase64, 'base64').toString('utf8')])
			)
		);
		for (const link of memoryLinks.brokenLinks)
			limitations.push({
				code: 'broken-memory-link',
				severity: 'block',
				message: `Memory ${link.source} links to missing topic ${link.target}.`,
			});
		const resourceProjections = await planResourceProjections(
			[...resources.values()],
			destination,
			checkpoint
		);
		limitations.push(...resourceProjections.limitations);

		if (destination.provider === 'codex')
			limitations.push({
				code: 'provider-owned-indexes',
				severity: 'warning',
				message:
					'Rollback retains staged Codex threads and provider-owned indexes for inspection; deleting a rollout alone cannot undo the native thread metadata.',
			});
		const capacity = getContextWindowForAgent(
			destination.provider,
			capabilitySnapshots.get(destination.provider)
		);
		for (const conversation of conversations) {
			const projected =
				destination.provider === 'codex' || destination.provider === 'claude-code'
					? projectConversation(conversation, destination.provider, 'capacity-preview').map(
							(row) => row.item
						)
					: [];
			if (estimateTokenCount(canonicalJson(projected)) > capacity)
				limitations.push({
					code: 'context-capacity',
					severity: 'block',
					tabId: conversation.tabId,
					message: `Ordered conversation exceeds the destination context capacity (${capacity} tokens). No history is truncated or summarized.`,
				});
		}
		const plan = planTranslation({
			agentId: session.id,
			source,
			destination,
			scope,
			conversations,
			registry: this.registry,
			busy,
			limitations,
			newRecords,
			resources: [...resources.values()],
		});

		plan.fingerprint = translationHash(
			canonicalJson({
				fingerprint: plan.fingerprint,
				resources: [...resources.values()],
				projections: resourceProjections.projections,
			})
		);
		return {
			schemaVersion: 1,
			plan,
			state: 'planned',
			conversations,
			resources: [...resources.values()],
			checkpoint: nextCheckpoint,
			mappings: [],
			resourceWrites: [],
			projections: resourceProjections.projections,
		};
	}
	private host(journal: TranslationJournal): TranslationTransactionHost {
		return {
			assertSourceUnchanged: async (operation) => {
				const session = this.session(operation.plan.agentId);
				if (session.toolType !== operation.plan.source.provider)
					throw new Error('Source provider changed since preflight');
				if (
					isAgentBusy(
						{ ...session, aiTabs: translationSessionTabs(session) },
						this.deps.getProcessManager()
					)
				)
					throw new TranslationSourceBusyError();
				const actual = await this.identity(session, session.toolType, true, operation.checkpoint);
				if (canonicalJson(actual) !== canonicalJson(operation.plan.source))
					throw new Error('Source account, project root or provider version changed');
				const destination = await this.identity(
					session,
					operation.plan.destination.provider,
					false,
					operation.checkpoint
				);
				if (canonicalJson(destination) !== canonicalJson(operation.plan.destination))
					throw new Error('Destination account, project root or provider version changed');
				if (session.providerTranslationKnowledgeDirectory)
					await assertTranslationTarget(
						session.providerTranslationKnowledgeDirectory,
						actual.projectRoot
					);
				for (const artifact of operation.resources)
					if (path.isAbsolute(artifact.sourcePath)) {
						const managedDirectory = session.providerTranslationKnowledgeDirectory;
						if (
							managedDirectory &&
							isPathAtOrUnderRoot(
								path.resolve(artifact.sourcePath).replace(/\\/g, '/'),
								path.resolve(managedDirectory).replace(/\\/g, '/')
							) &&
							!artifact.metadata?.directoryLink
						)
							await assertTranslationTarget(artifact.sourcePath, managedDirectory);
						const bytes = artifact.metadata?.directoryLink
							? Buffer.from(await fs.readlink(artifact.sourcePath))
							: await fs.readFile(artifact.sourcePath);
						if (translationHash(bytes) !== artifact.sha256)
							throw new Error('Selected resource changed since preflight');
					}
				for (const conversation of operation.conversations)
					for (const artifact of conversation.artifacts) {
						if (artifact.kind === 'transcript' && path.isAbsolute(artifact.sourcePath)) {
							const identity = [
								operation.plan.source,
								operation.plan.destination,
								...Object.values(operation.checkpoint?.providerRoots ?? {}),
							].find((root) =>
								isPathAtOrUnderRoot(
									path.resolve(artifact.sourcePath).replace(/\\/g, '/'),
									path.resolve(root.nativeSessionRoot ?? root.accountRoot).replace(/\\/g, '/')
								)
							);
							if (!identity) throw new Error('Native source is outside selected provider accounts');
							await assertTranslationTarget(
								artifact.sourcePath,
								identity.nativeSessionRoot ?? identity.accountRoot
							);
							if (translationHash(await fs.readFile(artifact.sourcePath)) !== artifact.sha256)
								throw new Error('Native source changed since preflight');
						}
					}
			},
			setMigration: async (state) => {
				this.persist(journal.plan.agentId, (s) => ({ ...s, providerMigration: state }));
			},
			isCommitted: async (id) =>
				this.session(journal.plan.agentId).providerMigration?.operationId === id &&
				this.session(journal.plan.agentId).toolType === journal.plan.destination.provider,
			commit: async (operation) => {
				this.persist(operation.plan.agentId, (session) => {
					const result = commitTranslationSession(
						session,
						operation.plan.destination.provider,
						operation.plan.id,
						operation.mappings,
						operation.knowledgeDirectory
					);
					const envKey =
						operation.plan.destination.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
					return {
						...result,
						providerMigration: { ...result.providerMigration!, state: 'committing' },
						customEnvVars: {
							...(this.deps.agentConfigsStore.get('configs', {})[
								operation.plan.destination.provider
							]?.customEnvVars ?? {}),
							[envKey]: operation.plan.destination.accountRoot,
							...(operation.knowledgeDirectory && {
								[TRANSLATION_KNOWLEDGE_ENV_VAR]: operation.knowledgeDirectory,
							}),
						},
					};
				});
			},
		};
	}
	async run(request: TranslationRequest): Promise<TranslationReport> {
		if (
			!request ||
			typeof request.agentId !== 'string' ||
			!(AGENT_IDS as readonly string[]).includes(request.destination) ||
			!['plan', 'apply', 'status', 'recover', 'rollback'].includes(request.action) ||
			(request.acceptLimitations !== undefined && typeof request.acceptLimitations !== 'boolean') ||
			(request.selectedUserResources !== undefined &&
				(!Array.isArray(request.selectedUserResources) ||
					request.selectedUserResources.some((p) => typeof p !== 'string')))
		)
			return { success: false, error: 'Malformed provider translation request' };
		return this.queue.enqueue(request.agentId, async () => {
			try {
				if (
					request.action === 'status' ||
					request.action === 'recover' ||
					request.action === 'rollback'
				) {
					const id =
						request.planId ??
						this.session(request.agentId).providerMigration?.operationId ??
						(await this.archive.lastOperation(request.agentId));
					if (!id) return { success: false, error: 'No provider migration journal for this agent' };
					const current = this.session(request.agentId).providerMigration;
					if (request.action !== 'status' && current && id !== current.operationId)
						return {
							success: false,
							error:
								'Only the current provider migration can be recovered or rolled back. Inspect historical operations with status.',
						};
					const journal = await this.archive.read(request.agentId, id);
					if (request.action === 'status')
						return {
							success: true,
							plan: journal.plan,
							result: journal.result ?? {
								success: false,
								state: journal.state,
								plan: journal.plan,
								mappings: journal.mappings,
								error: journal.error,
							},
						};
					const result = await recoverTranslation(
						this.archive,
						journal,
						this.host(journal),
						request.action === 'rollback'
					);
					return { success: result.success, plan: journal.plan, result };
				}
				const migration = this.session(request.agentId).providerMigration;
				const previous =
					request.action === 'apply' && request.planId
						? await this.archive.read(request.agentId, request.planId)
						: undefined;
				if (previous) {
					if (previous.plan.destination.provider !== request.destination)
						return { success: false, error: 'Preflight destination does not match the request.' };
					if (previous.state === 'committed' && previous.result?.state === 'committed') {
						if (!(await this.host(previous).isCommitted(previous.plan.id)))
							return {
								success: false,
								error: 'Historical migration cannot be reapplied. Inspect it with status.',
							};
						if (migration?.state !== 'committed')
							return {
								success: false,
								plan: previous.plan,
								error: 'The committed migration requires recovery to settle its persisted state.',
							};
						return {
							success: previous.result.success,
							plan: previous.plan,
							result: previous.result,
						};
					}
					if (
						previous.state !== 'planned' ||
						previous.mappings.length > 0 ||
						previous.resourceWrites.length > 0
					)
						return {
							success: false,
							plan: previous.plan,
							error:
								'Existing provider migration requires recovery or rollback; staging is not replayed.',
						};
				}
				if (
					migration &&
					['staging', 'staged', 'committing', 'recovery-required', 'failed'].includes(
						migration.state
					)
				)
					return {
						success: false,
						error:
							'The previous provider migration requires recovery or rollback before another plan or apply.',
					};
				const journal = await this.prepare(request);
				if (request.action === 'plan') {
					await this.archive.write(journal);
					await this.archive.markLatest(request.agentId, journal.plan.id);
					return { success: true, plan: journal.plan };
				}
				if (previous) {
					if (previous.plan.fingerprint !== journal.plan.fingerprint)
						return {
							success: false,
							plan: journal.plan,
							error: 'Preflight changed. Review the new plan before apply.',
						};
					// Retain the reviewed operation's identity across apply and response retries.
					journal.plan.id = previous.plan.id;
				}
				const host = this.host(journal);
				let connection: Awaited<ReturnType<typeof openCodexTranslationConnection>> | undefined;
				try {
					if (
						journal.plan.status === 'ready' &&
						journal.plan.destination.provider === 'codex' &&
						(journal.plan.limitations.length === 0 || request.acceptLimitations)
					) {
						const detected = await this.deps.getAgentDetector()!.getAgent('codex');
						const binary = detected?.path;
						if (!binary) throw new Error('Codex binary unavailable');
						const env = buildAgentEnvironment({
							surface: 'desktop',
							globalShellEnvVars: this.deps.settingsStore.get('shellEnvVars', {}) as Record<
								string,
								string
							>,
							defaultEnvVars: detected?.defaultEnvVars,
							agentCustomEnvVars: this.deps.agentConfigsStore.get('configs', {}).codex
								?.customEnvVars as Record<string, string> | undefined,
						});
						connection = await openCodexTranslationConnection({
							binary,
							cwd: journal.plan.destination.projectRoot,
							env: { ...env, CODEX_HOME: journal.plan.destination.accountRoot },
						});
						host.codex = connection;
					}
					const result = await applyTranslation(
						this.archive,
						this.registry,
						journal,
						host,
						request.acceptLimitations
					);
					return { success: result.success, plan: journal.plan, result, error: result.error };
				} finally {
					connection?.close();
				}
			} catch (error) {
				return { success: false, error: error instanceof Error ? error.message : String(error) };
			}
		});
	}
}
