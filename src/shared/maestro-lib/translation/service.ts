import { pendingTranslationSource } from './send';
import {
	analyzeMemoryLinks,
	discoverClaudeMemoryRoot,
	resolveMemoryRepositoryRoot,
} from './memory';
import {
	planResourceProjections,
	nativeResourceVariant,
	assertTranslationTarget,
} from './resource-projections';
import {
	assertTranslationKnowledgeDirectory,
	translationKnowledgeRoot,
	TRANSLATION_KNOWLEDGE_ENV_VAR,
	TRANSLATION_KNOWLEDGE_REMOTE_ENV_VAR,
} from './knowledge-binding';
import { estimateTokenCount } from '../../formatters';
import { getModelContextWindowOverride } from '../../agentConstants';
import { getContextWindowValue } from '../launch/agent-args';
import type { TranslationFs } from './fs-port';
import { localTranslationFs } from './local-fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentConfig } from '../providers/definitions';
import { resolveAgentAccountKey } from '../../providerProfiles';
import { buildAgentEnvironment } from '../launch/env';
import { expandTilde, encodeClaudeProjectPath } from '../../pathUtils';
import { AGENT_IDS } from '../../agentIds';
import { canonicalJson } from '../../canonicalJson';
import { isPathAtOrUnderRoot } from '../../worktreePaths';
import { createKeyedWriteQueue } from '../../keyedWriteQueue';
import { createTranslationRegistry, projectConversation } from './adapters';
import { providerOverridesFor, resolveTabProvider } from '../agents/providerSwap';
import { TranslationArchive, type TranslationJournal } from './archive';
import { planTranslation } from './registry';
import { limitationsNeedingAcceptance } from './limitations';
import { reconcileConversation, reconcileResource } from './reconcile';
import { collectTranslationResources } from './resources';
import { translationHash, nativeRecordKey } from './identity';
import {
	commitTranslationSession,
	recordTranslationCommit,
	translationSessionTabs,
	type TranslatableSession,
} from './session';
import {
	applyTranslation,
	recoverTranslation,
	type TranslationTransactionHost,
} from './transaction';
import { openCodexTranslationConnection } from '../codex/connection';
import type { ToolType } from '../../types';
import type {
	PortableConversation,
	TranslationArtifact,
	TranslationCheckpoint,
	TranslationIdentity,
	TranslationLimitation,
	TranslationReport,
	TranslationRequest,
} from './types';
import { TranslationSourceBusyError } from './types';

/** Host-owned reads and durable writes; native planning and transactions stay shared. */
export interface TranslationServiceSession extends TranslatableSession {
	name: string;
	cwd: string;
	projectRoot?: string;
}

export interface TranslationServiceHost {
	/** Defaults to local for existing hosts. Archives always stay in userDataDir. */
	nativeFs?: TranslationFs;
	/** Resolve per request, so concurrent agents cannot share another host's filesystem. */
	resolveNativeHost?(
		session: TranslationServiceSession
	): Promise<TranslationNativeHost | undefined>;
	resolveIdentity?(
		session: TranslationServiceSession,
		provider: ToolType,
		source: boolean,
		checkpoint?: TranslationCheckpoint
	): Promise<TranslationIdentity>;
	/** Refuse writes when a host lacks a required transaction transport. */
	assertCanApply?(destination: TranslationIdentity): void | Promise<void>;
	/** Native host owns the import transport; SSH must never use the local fallback. */
	openCodexConnection?(
		destination: TranslationIdentity
	): ReturnType<typeof openCodexTranslationConnection>;
	userDataDir: string;
	getSession(agentId: string): TranslationServiceSession;
	persist(
		agentId: string,
		update: (session: TranslationServiceSession) => TranslationServiceSession
	): Promise<void>;
	getProvider(
		provider: ToolType
	): Promise<
		| (Pick<AgentConfig, 'path' | 'defaultEnvVars'> & Partial<Pick<AgentConfig, 'binaryName'>>)
		| null
		| undefined
	>;
	providerConfig(provider: ToolType): Record<string, any>;
	globalEnv(): Record<string, string>;
	isBusy(session: TranslationServiceSession): boolean;
	findCodexSessionFile(sessionId: string, accountRoot: string): Promise<string | null>;
	history(agentId: string): Promise<Array<{ agentSessionId?: string }>>;
	execGit(
		args: string[],
		cwd: string
	): Promise<{ exitCode: number | string; stdout: string; stderr: string }>;
	execFile(
		binary: string,
		args: string[]
	): Promise<{ exitCode: number | string; stdout: string; stderr: string }>;
	contextWindow(provider: ToolType): number;
	reportPlan?(plan: TranslationJournal['plan']): void;
}

export type TranslationNativeHost = Pick<
	TranslationServiceHost,
	| 'nativeFs'
	| 'resolveIdentity'
	| 'execGit'
	| 'findCodexSessionFile'
	| 'assertCanApply'
	| 'openCodexConnection'
>;

export class NativeTranslationService {
	private readonly nativeFs: TranslationFs;
	private readonly paths: path.PlatformPath;
	private readonly registry = createTranslationRegistry();
	private readonly queue = createKeyedWriteQueue();
	private readonly archive: TranslationArchive;
	constructor(private readonly deps: TranslationServiceHost) {
		this.nativeFs = deps.nativeFs ?? localTranslationFs;
		this.paths = this.nativeFs.paths ?? path;
		this.archive = new TranslationArchive(path.join(deps.userDataDir, 'provider-translations'));
	}
	private session(agentId: string): TranslationServiceSession {
		return this.deps.getSession(agentId);
	}
	private persist(
		agentId: string,
		update: (session: TranslationServiceSession) => TranslationServiceSession
	): Promise<void> {
		return this.deps.persist(agentId, update);
	}
	private async identity(
		session: TranslationServiceSession,
		provider: ToolType,
		source: boolean,
		checkpoint?: TranslationCheckpoint
	): Promise<TranslationIdentity> {
		if (this.deps.resolveIdentity)
			return this.deps.resolveIdentity(session, provider, source, checkpoint);
		const detected = await this.deps.getProvider(provider);
		const providerConfig = this.deps.providerConfig(provider);
		const overrides = providerOverridesFor(
			{ ...session, aiTabs: undefined, toolType: session.toolType as ToolType },
			provider
		);
		const env = buildAgentEnvironment({
			surface: 'desktop',
			globalShellEnvVars: this.deps.globalEnv(),
			defaultEnvVars: detected?.defaultEnvVars,
			sessionCustomEnvVars: overrides.customEnvVars,
			agentCustomEnvVars: providerConfig.customEnvVars as Record<string, string> | undefined,
		});
		const selectedRoot =
			!source || provider !== session.toolType
				? checkpoint?.providerRoots[provider]?.accountRoot
				: undefined;
		const accountRoot =
			selectedRoot ?? resolveAgentAccountKey(provider, env as Record<string, string>, os.homedir());
		if (!accountRoot && this.registry.get(provider))
			throw new Error('Cannot resolve selected provider account');
		let root = accountRoot ? this.paths.resolve(expandTilde(accountRoot)) : '';
		try {
			root = await this.nativeFs.realpath(root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
		const customBinary = overrides.customPath;
		const binary = customBinary || detected?.path;
		let version = '';
		if (binary) {
			const probe = await this.deps.execFile(binary, ['--version']);
			if (probe.exitCode === 0) version = /\d+\.\d+\.\d+/.exec(probe.stdout)?.[0] ?? '';
		}
		const projectRoot = await this.nativeFs.realpath(session.projectRoot || session.cwd);
		let nativeSessionRoot: string | undefined;
		if (provider === 'claude-code') {
			nativeSessionRoot = this.paths.join(root, 'projects');
			try {
				nativeSessionRoot = await this.nativeFs.realpath(nativeSessionRoot);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
			}
		}
		const memoryProjectRoot = await resolveMemoryRepositoryRoot(projectRoot, async (cwd) => {
			const result = await this.deps.execGit(['rev-parse', '--git-common-dir'], cwd);
			return result.exitCode === 0 ? result.stdout : undefined;
		});
		const userResourceRoots: NonNullable<TranslationIdentity['userResourceRoots']> = [
			{ path: this.paths.join(os.homedir(), '.agents', 'skills'), kind: 'skill' },
		];
		if (provider === 'claude-code') {
			const memory = await discoverClaudeMemoryRoot(
				projectRoot,
				root,
				memoryProjectRoot,
				this.nativeFs
			);
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
				? this.paths.join(
						identity.nativeSessionRoot ?? this.paths.join(identity.accountRoot, 'projects'),
						encodeClaudeProjectPath(identity.projectRoot),
						`${sessionId}.jsonl`
					)
				: await this.deps.findCodexSessionFile(sessionId, identity.accountRoot);
		if (!file) throw new Error(`Selected native session missing for tab ${tabId}`);
		await assertTranslationTarget(
			file,
			identity.nativeSessionRoot ?? identity.accountRoot,
			this.nativeFs
		);
		const stat = await this.nativeFs.stat(file);
		const bytes = await this.nativeFs.readFile(file);
		const after = await this.nativeFs.stat(file);
		if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs)
			throw new Error('Native source changed during snapshot');
		const bundle = adapter.extract(identity, tabId, sessionId, bytes);
		bundle.artifacts[0].sourcePath = file;
		return bundle;
	}
	private async prepare(request: TranslationRequest): Promise<TranslationJournal> {
		const session = this.session(request.agentId);
		const checkpoint = await this.archive.checkpoint(session.id);
		const inventory = translationSessionTabs(session);
		const tabs =
			request.tabId === undefined
				? session.aiTabs.filter((tab) => tab.tabProvider === undefined)
				: translationSessionTabs(session, request.tabId);
		const deferredTabs =
			request.tabId === undefined
				? inventory
						.filter(
							(tab) => tab.tabProvider === undefined && !tabs.some((open) => open.id === tab.id)
						)
						.map((tab) => ({
							id: tab.id,
							agentSessionId: tab.agentSessionId,
							providerSessions: tab.providerSessions,
							pendingTranslation: tab.pendingTranslation,
						}))
				: undefined;
		// History contributes identities, never native extraction during an agent-wide switch.
		if (deferredTabs) {
			for (const entry of await this.deps.history(session.id)) {
				if (!entry.agentSessionId) continue;
				const key = `history:${entry.agentSessionId}`;
				const mapping = session.providerTranslationHistoryMappings?.find((m) => m.tabId === key);
				const nativeId = mapping?.destinationSessionId ?? entry.agentSessionId;
				if (
					[...inventory, ...deferredTabs].some(
						(tab) =>
							tab.id === key ||
							tab.agentSessionId === nativeId ||
							Object.values(tab.providerSessions ?? {}).some(
								(slot) => slot?.agentSessionId === nativeId
							)
					)
				)
					continue;
				// Legacy failed mappings have no trustworthy provider ownership.
				if (mapping && !mapping.destinationSessionId) continue;
				deferredTabs.push({
					id: key,
					agentSessionId: nativeId,
					providerSessions: undefined,
					pendingTranslation: undefined,
				});
			}
		}
		const pendingSource =
			request.tabId !== undefined
				? pendingTranslationSource(session, request.tabId, request.destination)
				: undefined;
		if (pendingSource === 'ambiguous')
			throw new Error('Multiple parked source providers; select the source before translation');
		const sourceProvider = pendingSource ?? resolveTabProvider(tabs[0], session);
		const source = await this.identity(session, sourceProvider, true, checkpoint);
		const destination = await this.identity(session, request.destination, false, checkpoint);
		const knowledgeRoot = translationKnowledgeRoot(this.deps.userDataDir, source);
		const scope = {
			projectKnowledge: true as const,
			selectedUserResources: request.selectedUserResources ?? [],
			projectResourcesIntoRepo: request.projectResourcesIntoRepo === true,
		};
		const busy = this.deps.isBusy(session);
		const limitations: TranslationLimitation[] = [];
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
				const sourceId =
					sourceProvider === resolveTabProvider(tab, session)
						? tab.agentSessionId
						: (tab.providerSessions?.[sourceProvider]?.agentSessionId ?? null);
				const native = await this.conversation(source, tab.id, sourceId);
				if (
					!sourceId &&
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
				const parkedId =
					destination.provider === resolveTabProvider(tab, session)
						? tab.agentSessionId
						: tab.providerSessions?.[destination.provider]?.agentSessionId;
				if (parkedId) {
					const parked = await this.conversation(destination, tab.id, parkedId);
					const parkedResult = reconcileConversation(parked, checkpoint);
					limitations.push(...parkedResult.limitations);
					// History can reopen under a new tab ID. Known native events are
					// still the same branch even without that tab's prior conversation.
					if (
						parkedResult.newRecords > 0 &&
						parked.records.some(
							(record) =>
								checkpoint?.observed[nativeRecordKey(destination, parkedId, record.nativeId)] ===
								undefined
						)
					)
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
					nextCheckpoint.observed[nativeRecordKey(source, sourceId!, record.nativeId)] =
						record.semanticHash;
			}
		} else
			for (const tab of tabs)
				conversations.push({
					tabId: tab.id,
					nativeSessionId:
						sourceProvider === resolveTabProvider(tab, session)
							? tab.agentSessionId
							: (tab.providerSessions?.[sourceProvider]?.agentSessionId ?? null),
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
		const nativeResources = await collectTranslationResources(
			source,
			scope,
			undefined,
			this.nativeFs
		);
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
			await assertTranslationKnowledgeDirectory(
				session.providerTranslationKnowledgeDirectory,
				knowledgeRoot,
				this.nativeFs
			);
			const managedResources = await collectTranslationResources(
				source,
				{ projectKnowledge: true, selectedUserResources: [] },
				session.providerTranslationKnowledgeDirectory,
				this.nativeFs
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
				const managedPath = this.paths.join(
					session.providerTranslationKnowledgeDirectory,
					base.relativePath
				);
				try {
					await assertTranslationTarget(
						managedPath,
						session.providerTranslationKnowledgeDirectory,
						this.nativeFs
					);
					const bytes = await this.nativeFs.readFile(managedPath);
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
								? Buffer.from(await this.nativeFs.readlink(file))
								: await this.nativeFs.readFile(file);
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
						await assertTranslationTarget(file, source.projectRoot, this.nativeFs);
						bytes = await this.nativeFs.readFile(file);
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
			checkpoint,
			scope.projectResourcesIntoRepo,
			this.nativeFs
		);
		limitations.push(...resourceProjections.limitations);
		if (scope.projectResourcesIntoRepo && !(await this.resolveProjectGit(destination.projectRoot)))
			limitations.push({
				code: 'resource-git-exclude-unavailable',
				severity: 'info',
				message:
					'This project is not a git repository. Native resources will be installed without a local git exclude entry.',
			});

		if (destination.provider === 'codex')
			limitations.push({
				code: 'provider-owned-indexes',
				severity: 'warning',
				message:
					'Rollback retains staged Codex threads and provider-owned indexes for inspection; deleting a rollout alone cannot undo the native thread metadata.',
			});
		const destinationConfig = this.deps.providerConfig(destination.provider);
		const destinationOverrides = providerOverridesFor(
			{ ...session, aiTabs: undefined },
			destination.provider
		);
		const capacity =
			getContextWindowValue(undefined, {}, destinationOverrides.customContextWindow) ||
			getModelContextWindowOverride(destinationOverrides.customModel ?? destinationConfig.model) ||
			getContextWindowValue(undefined, destinationConfig) ||
			this.deps.contextWindow(destination.provider);
		for (const conversation of conversations) {
			const projected =
				destination.provider === 'codex' || destination.provider === 'claude-code'
					? projectConversation(
							conversation,
							destination.provider,
							'capacity-preview',
							destination.version
						).map((row) => row.item)
					: [];
			if (estimateTokenCount(canonicalJson(projected)) > capacity)
				limitations.push({
					code: 'context-capacity',
					// Serialized import size is an estimate, not the model's token count.
					// A provider-wide fallback cannot establish the selected model's limit.
					severity: 'warning',
					tabId: conversation.tabId,
					message:
						'This conversation may exceed the destination model’s context window. The full source transcript is preserved.',
				});
		}
		const plan = planTranslation({
			agentId: session.id,
			tabId: request.tabId,
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

		if (deferredTabs) plan.deferredTabs = deferredTabs;

		plan.fingerprint = translationHash(
			canonicalJson({
				fingerprint: plan.fingerprint,
				deferredTabs,
				resources: [...resources.values()],
				projections: resourceProjections.projections,
			})
		);
		this.deps.reportPlan?.(plan);
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
	private async resolveProjectGit(projectRoot: string) {
		const common = await this.deps.execGit(['rev-parse', '--git-common-dir'], projectRoot);
		if (common.exitCode !== 0) {
			if (/not a git repository/i.test(common.stderr)) return undefined;
			throw new Error('Cannot resolve the project git directory');
		}
		const top = await this.deps.execGit(['rev-parse', '--show-toplevel'], projectRoot);
		if (top.exitCode !== 0) throw new Error('Cannot resolve the repository root');
		return {
			root: this.paths.resolve(top.stdout.trim()),
			commonDirectory: this.paths.resolve(projectRoot, common.stdout.trim()),
		};
	}
	private host(journal: TranslationJournal, recovering = false): TranslationTransactionHost {
		const session = this.session(journal.plan.agentId);
		if (
			Boolean(session.sessionSshRemoteConfig?.enabled || session.sshRemoteId) !==
			Boolean(journal.plan.destination.remoteHost)
		)
			throw new Error('Provider knowledge journal does not match the launch host');
		return {
			knowledgeRoot: translationKnowledgeRoot(this.deps.userDataDir, journal.plan.destination),
			nativeFs: this.nativeFs,
			resolveProjectGit: (root) => this.resolveProjectGit(root),
			assertSourceUnchanged: async (operation) => {
				const session = this.session(operation.plan.agentId);
				if (
					operation.plan.tabId === undefined &&
					session.toolType !== operation.plan.source.provider
				)
					throw new Error('Source provider changed since preflight');
				if (operation.plan.tabId !== undefined) {
					const [tab] = translationSessionTabs(session, operation.plan.tabId);
					const sourceId =
						resolveTabProvider(tab, session) === operation.plan.source.provider
							? tab.agentSessionId
							: tab.providerSessions?.[operation.plan.source.provider]?.agentSessionId;
					if (sourceId !== operation.plan.tabs[0].sourceSessionId)
						throw new Error('Native source identity changed since preflight');
				}
				if (
					operation.plan.deferredTabs !== undefined &&
					canonicalJson(
						session.aiTabs
							.filter((tab) => tab.tabProvider === undefined)
							.map((tab) => tab.id)
							.sort()
					) !== canonicalJson(operation.plan.tabs.map((tab) => tab.tabId).sort())
				)
					throw new Error('Open tabs changed since preflight');
				if (this.deps.isBusy(session)) throw new TranslationSourceBusyError();
				const actual = await this.identity(
					session,
					operation.plan.source.provider,
					true,
					operation.checkpoint
				);
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
				if (session.providerTranslationKnowledgeDirectory) {
					const directory = session.providerTranslationKnowledgeDirectory;
					const legacyRoot = this.paths.join(actual.projectRoot, '.maestro/provider-knowledge');
					const legacy =
						recovering &&
						isPathAtOrUnderRoot(
							this.paths.resolve(directory).split(this.paths.sep).join('/'),
							this.paths.resolve(legacyRoot).split(this.paths.sep).join('/')
						);
					await assertTranslationKnowledgeDirectory(
						directory,
						legacy ? legacyRoot : translationKnowledgeRoot(this.deps.userDataDir, actual),
						this.nativeFs
					);
					if (legacy) await assertTranslationTarget(directory, actual.projectRoot, this.nativeFs);
				}
				for (const artifact of operation.resources)
					if (this.paths.isAbsolute(artifact.sourcePath)) {
						const managedDirectory = session.providerTranslationKnowledgeDirectory;
						if (
							managedDirectory &&
							isPathAtOrUnderRoot(
								this.paths.resolve(artifact.sourcePath).split(this.paths.sep).join('/'),
								this.paths.resolve(managedDirectory).split(this.paths.sep).join('/')
							) &&
							!artifact.metadata?.directoryLink
						)
							await assertTranslationTarget(artifact.sourcePath, managedDirectory, this.nativeFs);
						const bytes = artifact.metadata?.directoryLink
							? Buffer.from(await this.nativeFs.readlink(artifact.sourcePath))
							: await this.nativeFs.readFile(artifact.sourcePath);
						if (translationHash(bytes) !== artifact.sha256)
							throw new Error('Selected resource changed since preflight');
					}
				for (const conversation of operation.conversations)
					for (const artifact of conversation.artifacts) {
						if (artifact.kind === 'transcript' && this.paths.isAbsolute(artifact.sourcePath)) {
							const identity = [
								operation.plan.source,
								operation.plan.destination,
								...Object.values(operation.checkpoint?.providerRoots ?? {}),
							].find((root) =>
								isPathAtOrUnderRoot(
									this.paths.resolve(artifact.sourcePath).split(this.paths.sep).join('/'),
									this.paths
										.resolve(root.nativeSessionRoot ?? root.accountRoot)
										.split(this.paths.sep)
										.join('/')
								)
							);
							if (!identity) throw new Error('Native source is outside selected provider accounts');
							await assertTranslationTarget(
								artifact.sourcePath,
								identity.nativeSessionRoot ?? identity.accountRoot,
								this.nativeFs
							);
							if (
								translationHash(await this.nativeFs.readFile(artifact.sourcePath)) !==
								artifact.sha256
							)
								throw new Error('Native source changed since preflight');
						}
					}
			},
			setMigration: async (state) => {
				await this.persist(journal.plan.agentId, (s) => {
					const acceptedDirections = (s.providerMigration?.acceptedDirections ?? []).map(
						(entry) => ({ ...entry, warnings: [...entry.warnings] })
					);
					// Staging is reached only after the transaction's acceptance gate.
					if (state.state === 'staging') {
						const plan = journal.plan;
						const entry = {
							source: plan.source.provider,
							destination: plan.destination.provider,
							sourceVersion: plan.source.version,
							destinationVersion: plan.destination.version,
							warnings: limitationsNeedingAcceptance(plan.limitations).map(canonicalJson),
						};
						const previous = acceptedDirections.find(
							(a) =>
								a.source === entry.source &&
								a.destination === entry.destination &&
								a.sourceVersion === entry.sourceVersion &&
								a.destinationVersion === entry.destinationVersion
						);
						if (previous)
							previous.warnings = [...new Set([...previous.warnings, ...entry.warnings])];
						else acceptedDirections.push(entry);
					}
					const updated =
						state.state === 'committed' && journal.result
							? recordTranslationCommit(s, {
									success: journal.result.success,
									plan: journal.plan,
									result: journal.result,
								})
							: s;
					return { ...updated, providerMigration: { ...state, acceptedDirections } };
				});
			},
			isCommitted: async (id) =>
				this.session(journal.plan.agentId).providerMigration?.operationId === id &&
				['committing', 'committed', 'recovery-required'].includes(
					this.session(journal.plan.agentId).providerMigration?.state ?? ''
				) &&
				(journal.plan.tabId !== undefined ||
					this.session(journal.plan.agentId).toolType === journal.plan.destination.provider),
			commit: async (operation) => {
				const knowledgeEnv = operation.knowledgeDirectory
					? {
							[TRANSLATION_KNOWLEDGE_ENV_VAR]: operation.knowledgeDirectory,
							[TRANSLATION_KNOWLEDGE_REMOTE_ENV_VAR]: operation.plan.destination.remoteHost
								? canonicalJson({
										remoteHost: operation.plan.destination.remoteHost,
										remoteHome: operation.plan.destination.remoteHome,
									})
								: '',
						}
					: {};
				await this.persist(operation.plan.agentId, (session) => {
					const result = commitTranslationSession(
						session,
						operation.plan.destination.provider,
						operation.plan.id,
						operation.mappings,
						operation.knowledgeDirectory,
						operation.plan.source.provider,
						operation.plan.tabId,
						operation.plan.deferredTabs
					);
					const envKey =
						operation.plan.destination.provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
					return {
						...result,
						// A captured turn can target a provider that is still parked.
						// Bind its resume token to the account and knowledge just written.
						...(operation.plan.tabId !== undefined &&
							session.toolType !== operation.plan.destination.provider && {
								providerOverrides: {
									...session.providerOverrides,
									[operation.plan.destination.provider]: {
										...session.providerOverrides?.[operation.plan.destination.provider],
										customEnvVars: {
											...this.deps.providerConfig(operation.plan.destination.provider)
												.customEnvVars,
											...session.providerOverrides?.[operation.plan.destination.provider]
												?.customEnvVars,
											[envKey]: operation.plan.destination.accountRoot,
											...knowledgeEnv,
										},
									},
								},
							}),
						providerMigration: {
							...result.providerMigration!,
							state: 'committing',
							acceptedDirections: session.providerMigration?.acceptedDirections,
						},
						customEnvVars: {
							...(operation.plan.tabId !== undefined
								? session.customEnvVars
								: {
										...(this.deps.providerConfig(operation.plan.destination.provider)
											.customEnvVars ?? {}),
										[envKey]: operation.plan.destination.accountRoot,
									}),
							...(operation.plan.tabId !== undefined &&
								session.toolType === operation.plan.destination.provider && {
									[envKey]: operation.plan.destination.accountRoot,
								}),
							...knowledgeEnv,
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
			(request.tabId !== undefined &&
				(typeof request.tabId !== 'string' || !request.tabId.trim())) ||
			(request.projectResourcesIntoRepo !== undefined &&
				typeof request.projectResourcesIntoRepo !== 'boolean') ||
			(request.acceptLimitations !== undefined && typeof request.acceptLimitations !== 'boolean') ||
			(request.selectedUserResources !== undefined &&
				(!Array.isArray(request.selectedUserResources) ||
					request.selectedUserResources.some((p) => typeof p !== 'string')))
		)
			return { success: false, error: 'Malformed provider translation request' };
		return this.queue.enqueue(request.agentId, async () => {
			try {
				const session = this.session(request.agentId);
				if (request.action !== 'status' && this.deps.resolveNativeHost) {
					const nativeHost = await this.deps.resolveNativeHost(session);
					if (nativeHost)
						return new NativeTranslationService({
							...this.deps,
							...nativeHost,
							resolveNativeHost: undefined,
						}).run(request);
				}
				if (
					request.action !== 'status' &&
					(session.sessionSshRemoteConfig?.enabled || session.sshRemoteId) &&
					!this.deps.resolveIdentity
				)
					throw new Error(
						'SSH translation requires a remote native host; local fallback is forbidden.'
					);
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
					if (request.tabId !== undefined && request.tabId !== journal.plan.tabId)
						return { success: false, error: 'Journal tab does not match the request.' };
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
					await this.deps.assertCanApply?.(journal.plan.destination);
					const result = await recoverTranslation(
						this.archive,
						journal,
						this.host(journal, true),
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
					if (previous.plan.tabId !== request.tabId)
						return { success: false, error: 'Preflight tab does not match the request.' };
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
				await this.deps.assertCanApply?.(journal.plan.destination);
				const host = this.host(journal);
				let connection: Awaited<ReturnType<typeof openCodexTranslationConnection>> | undefined;
				try {
					if (
						journal.plan.status === 'ready' &&
						journal.plan.destination.provider === 'codex' &&
						(limitationsNeedingAcceptance(journal.plan.limitations).length === 0 ||
							request.acceptLimitations)
					) {
						if (this.deps.openCodexConnection) {
							connection = await this.deps.openCodexConnection(journal.plan.destination);
						} else {
							if (session.sessionSshRemoteConfig?.enabled || session.sshRemoteId)
								throw new Error('SSH translation requires a remote Codex import channel.');
							const detected = await this.deps.getProvider('codex');
							const binary = detected?.path;
							if (!binary) throw new Error('Codex binary unavailable');
							const env = buildAgentEnvironment({
								surface: 'desktop',
								globalShellEnvVars: this.deps.globalEnv(),
								defaultEnvVars: detected?.defaultEnvVars,
								agentCustomEnvVars: this.deps.providerConfig('codex').customEnvVars as
									| Record<string, string>
									| undefined,
							});
							connection = await openCodexTranslationConnection({
								binary,
								cwd: journal.plan.destination.projectRoot,
								env: { ...env, CODEX_HOME: journal.plan.destination.accountRoot },
							});
						}
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
