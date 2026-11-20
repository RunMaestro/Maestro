import { BACKGROUND_STOP_GRACE_MS } from '../../src/shared/maestro-lib/control/termination';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { canonicalJson } from '../../src/shared/canonicalJson';
import { fileTimestampSlug } from '../../src/shared/formatters';
import { withMaestroClient } from '../../src/cli/services/maestro-client';
import { getSessionById, readSettings, readAgentConfig } from '../../src/cli/services/storage';
import { resolveAgentAccountKey } from '../../src/shared/providerProfiles';
import { isPathAtOrUnderRoot } from '../../src/shared/worktreePaths';
import { encodeClaudeProjectPath } from '../../src/shared/pathUtils';
import { shellEscape } from '../../src/shared/maestro-lib/launch/shell-escape';
import { execFileNoThrow } from '../../src/shared/maestro-lib/launch/exec-file';
import { atomicWriteFile } from '../../src/shared/maestro-lib/storage/atomic-json-store';
import { planSessionTurn } from '../../src/shared/maestro-lib/run/session';
import { runToCompletion } from '../../src/shared/maestro-lib/run/run-to-completion';
import { openCodexTranslationConnection } from '../../src/shared/maestro-lib/codex/connection';
import {
	translationHash,
	nativeRecordKey,
	recordKey,
} from '../../src/shared/maestro-lib/translation/identity';
import {
	TRANSLATION_KNOWLEDGE_ENV_VAR,
	translationKnowledgeRoot,
	assertTranslationKnowledgeDirectory,
} from '../../src/shared/maestro-lib/translation/knowledge-binding';
import {
	commitTranslationSession,
	type TranslatableSession,
} from '../../src/shared/maestro-lib/translation/session';
import { activeContextRecords } from '../../src/shared/maestro-lib/translation/context-window';
import {
	TranslationArchive,
	createTranslationRegistry,
	planTabTranslation,
	applyTabTranslation,
	prepareTabForSend,
	limitationsNeedingAcceptance,
	projectConversation,
	collectTranslationResources,
	reconcileConversation,
	planResourceProjections,
	TRANSLATION_PROVIDER_VERSIONS,
	translationVersionLimitation,
	type TranslationIdentity,
	type TranslationJournal,
	type TranslationPlan,
	type TranslationResult,
	type PortableConversation,
} from '../../src/shared/maestro-lib/translation';

export const GUINEA_PIG = {
	agentId: '92eb2f16-433d-4ecd-bb87-885c8a64b2f7',
	tabId: 'a77c0b6c-83c5-4275-baa9-9098994993f1',
};

export function acceptanceProviderVersion(
	provider: keyof typeof TRANSLATION_PROVIDER_VERSIONS,
	output: string
): string {
	// Preserve prerelease/build tags so a prerelease never becomes a tested release.
	const version =
		/(?:^|\s)(v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/.exec(
			output
		)?.[1] ?? '';
	const limitation = translationVersionLimitation(
		provider,
		version,
		TRANSLATION_PROVIDER_VERSIONS[provider]
	);
	if (limitation?.severity === 'block') throw new Error(limitation.message);
	return version;
}

/** Acceptance allows only the two expected, explicitly recorded warnings. */
export function assertAcceptancePlan(plan: TranslationPlan): void {
	const refused = plan.limitations.filter(
		(limit) =>
			limit.severity === 'block' ||
			(limit.severity === 'warning' &&
				!['unverified-native-resume', 'untested-version'].includes(limit.code))
	);
	if (plan.status !== 'ready' || refused.length)
		throw new Error(
			`Acceptance preflight refused: ${plan.status}; ${refused.map((l) => l.code).join(', ')}`
		);
	if (plan.tabs.length !== 1 || plan.tabs[0].tabId !== plan.tabId)
		throw new Error('Acceptance requires a single-tab plan');
}

/** Compare persisted native payloads before continuation, including summary order and archived exclusion. */
export function assertAcceptanceContextWindow(
	source: PortableConversation,
	readback: PortableConversation
): void {
	const provider = readback.identity.provider;
	if (provider !== 'codex' && provider !== 'claude-code')
		throw new Error('Unsupported acceptance destination');
	const payload = (native: unknown): unknown => {
		const row = native as Record<string, unknown>;
		if (provider === 'codex') return row.payload;
		const message = row.message as Record<string, unknown>;
		return { role: message.role, content: message.content };
	};
	const expected = projectConversation(source, provider, readback.nativeSessionId!).map((row) =>
		payload(provider === 'codex' ? { payload: row.item } : row.item)
	);
	const actual = activeContextRecords(readback.records)
		.filter((record) => record.role === 'user' || record.role === 'assistant')
		.map((record) => payload(record.native));
	if (!expected.length || canonicalJson(expected) !== canonicalJson(actual))
		throw new Error('Destination did not retain the source active compaction window');
}

/** Exercise the shared send gate with an isolated session, never the desktop test agent. */
export async function applyAcceptanceHop(
	journal: TranslationJournal,
	apply: () => Promise<TranslationResult>,
	throughSend: boolean
): Promise<TranslationResult> {
	const { plan } = journal;
	assertAcceptancePlan(plan);
	if (!throughSend) return apply();
	let session: TranslatableSession = {
		id: plan.agentId,
		toolType: plan.source.provider,
		aiTabs: [{ id: plan.tabId!, agentSessionId: plan.tabs[0].sourceSessionId }],
		providerMigration: {
			operationId: plan.id,
			destination: plan.destination.provider,
			state: 'committed',
			verification: 'unverified',
			acceptedDirections: [
				{
					source: plan.source.provider,
					destination: plan.destination.provider,
					sourceVersion: plan.source.version,
					destinationVersion: plan.destination.version,
					warnings: limitationsNeedingAcceptance(plan.limitations).map(canonicalJson),
				},
			],
		},
	};
	let result: TranslationResult | undefined;
	const resumed = await prepareTabForSend(plan.tabId!, plan.destination.provider, {
		getSession: () => session,
		isBusy: () => false,
		translate: async (request) => {
			if (
				request.agentId !== plan.agentId ||
				request.tabId !== plan.tabId ||
				request.destination !== plan.destination.provider
			)
				throw new Error('Translate-at-send selected a different tab or provider');
			if (request.action === 'plan') return { success: true, plan };
			if (request.action !== 'apply' || request.planId !== plan.id || !request.acceptLimitations)
				throw new Error('Translate-at-send did not apply the reviewed plan');
			result = await apply();
			if (result.success && result.state === 'committed')
				session = commitTranslationSession(
					session,
					plan.destination.provider,
					plan.id,
					result.mappings,
					journal.knowledgeDirectory,
					plan.source.provider,
					plan.tabId
				);
			return { success: result.success, plan, result };
		},
	});
	if (!result || resumed !== result.mappings[0]?.destinationSessionId)
		throw new Error('Translate-at-send returned a different native session');
	return result;
}

/** Seed only isolated managed memory, preserving the finalized native import checkpoint. */
export async function seedAcceptanceMemoryDelta(
	archive: TranslationArchive,
	plan: TranslationPlan,
	identity: TranslationIdentity,
	knowledge: string
): Promise<void> {
	const checkpoint = await archive.checkpoint(plan.agentId);
	if (!checkpoint) throw new Error('Native import did not persist its checkpoint');
	const topic = path.join(knowledge, 'memory', 'acceptance-delta.md');
	await fs.mkdir(path.dirname(topic), { recursive: true });
	await fs.writeFile(topic, 'Isolated acceptance memory: violet heron.\n', {
		flag: 'wx',
		mode: 0o600,
	});
	await fs.appendFile(
		path.join(knowledge, 'memory', 'MEMORY.md'),
		'\n[Isolated acceptance memory](acceptance-delta.md)\n',
		{ mode: 0o600 }
	);
	const updated = await collectTranslationResources(identity, plan.scope, knowledge);
	assertAcceptancePlan({ ...plan, limitations: [...plan.limitations, ...updated.limitations] });
	checkpoint.resources = updated.artifacts;
	await archive.saveCheckpoint(plan.agentId, checkpoint);
}

export function validateAcceptanceInputs(
	workspace: string,
	args: string[]
): { claudeAuth: string; codexAuth: string; question: string; expected: string } {
	const value = (name: string): string => {
		const index = args.indexOf(name);
		if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--'))
			throw new Error(`Required acceptance input missing: ${name}`);
		return args[index + 1];
	};
	if (!args.includes('--execute-isolated-acceptance'))
		throw new Error('Acceptance execution needs explicit opt-in');
	const claudeAuth = path.resolve(value('--claude-auth'));
	const codexAuth = path.resolve(value('--codex-auth'));
	const scratch = path.join(workspace, '.maestro', 'scratch');
	for (const file of [claudeAuth, codexAuth]) {
		const relative = path.relative(scratch, file);
		if (relative.startsWith('..') || path.isAbsolute(relative))
			throw new Error(
				'Acceptance credentials must already be staged inside checkout scratch, never default provider homes'
			);
	}
	return {
		claudeAuth,
		codexAuth,
		question: value('--recall-question'),
		expected: value('--expected-recall'),
	};
}

/** Originals are read-only inputs. Every provider process runs behind a macOS write boundary. */
export async function runIsolatedAcceptance(workspace: string, args: string[]): Promise<void> {
	const inputs = validateAcceptanceInputs(workspace, args);
	if (process.platform !== 'darwin')
		throw new Error(
			'This prepared driver requires macOS sandbox-exec; it is not cross-platform acceptance evidence'
		);
	await fs.access('/usr/bin/sandbox-exec');
	const live = await withMaestroClient(async (client) => {
		const roster = await client.sendCommand<{ sessions: Array<{ id: string; state: string }> }>(
			{ type: 'get_sessions' },
			'sessions_list'
		);
		const active = await client.sendCommand<{
			ok: boolean;
			result: Array<{ sessionId: string; isTerminal: boolean }>;
		}>(
			{
				type: 'bridge.invoke',
				channel: 'process:getActiveProcesses',
				args: [{ includeChildProcesses: false }],
			},
			'bridge.response'
		);
		const tab = await client.sendCommand<{
			success: boolean;
			agentId: string;
			agentSessionId: string;
		}>({ type: 'get_session_history', tabId: GUINEA_PIG.tabId }, 'session_history_result');
		if (
			!active.ok ||
			!Array.isArray(active.result) ||
			!tab.success ||
			tab.agentId !== GUINEA_PIG.agentId ||
			!tab.agentSessionId
		)
			throw new Error('Cannot prove live guinea-pig identity/process ownership');
		const agent = roster.sessions.find((s) => s.id === GUINEA_PIG.agentId);
		if (
			!agent ||
			agent.state === 'busy' ||
			agent.state === 'connecting' ||
			active.result.some((p) => !p.isTerminal && p.sessionId.startsWith(GUINEA_PIG.agentId))
		)
			throw new Error('Guinea pig is busy; isolated acceptance refuses a partial source tail');
		return { nativeId: tab.agentSessionId };
	});
	const originalAgent = getSessionById(GUINEA_PIG.agentId);
	if (
		!originalAgent ||
		originalAgent.toolType !== 'claude-code' ||
		originalAgent.sessionSshRemoteConfig?.enabled
	)
		throw new Error('Designated guinea pig is not a local Claude agent');
	const originalProject = originalAgent.projectRoot || originalAgent.cwd;
	const providerConfig = readAgentConfig('claude-code');
	const sourceRoot = resolveAgentAccountKey(
		'claude-code',
		{
			...process.env,
			...(readSettings().shellEnvVars as Record<string, string> | undefined),
			...(originalAgent.customEnvVars ??
				(providerConfig.customEnvVars as Record<string, string> | undefined)),
		} as Record<string, string>,
		os.homedir()
	);
	if (!sourceRoot) throw new Error('Guinea-pig account root is unknown');
	const originalTranscript = path.join(
		sourceRoot,
		'projects',
		encodeClaudeProjectPath(originalProject),
		`${live.nativeId}.jsonl`
	);
	const originalBytes = await fs.readFile(originalTranscript);
	const originalHash = translationHash(originalBytes);
	const root = await fs.mkdtemp(
		path.join(workspace, '.maestro', 'scratch', 'provider-translation-acceptance-')
	);
	const home = path.join(root, 'home');
	const project = path.join(root, 'project');
	const claudeHome = path.join(home, '.claude');
	const codexHome = path.join(home, '.codex');
	await Promise.all(
		[home, project, claudeHome, codexHome, path.join(root, 'tmp')].map((dir) =>
			fs.mkdir(dir, { recursive: true, mode: 0o700 })
		)
	);
	const env = {
		...process.env,
		MAESTRO_USER_DATA: path.join(root, 'maestro-data'),
		HOME: home,
		CLAUDE_CONFIG_DIR: claudeHome,
		CODEX_HOME: codexHome,
		TMPDIR: path.join(root, 'tmp'),
		XDG_CONFIG_HOME: path.join(home, '.config'),
		XDG_CACHE_HOME: path.join(home, '.cache'),
		XDG_DATA_HOME: path.join(home, '.local/share'),
	};
	const originalEnvironment = { ...process.env };
	const credentials = [
		[inputs.claudeAuth, path.join(claudeHome, '.credentials.json')],
		[inputs.codexAuth, path.join(codexHome, 'auth.json')],
	];
	for (const [from, to] of credentials) {
		const real = await fs.realpath(from);
		if (
			!isPathAtOrUnderRoot(
				real.replace(/\\/g, '/'),
				path.join(workspace, '.maestro', 'scratch').replace(/\\/g, '/')
			)
		)
			throw new Error('Staged acceptance credentials escape checkout scratch through a symlink');
		await fs.copyFile(real, to, fs.constants.COPYFILE_EXCL);
	}
	const scope = { projectKnowledge: true as const, selectedUserResources: [] };
	const realClaude = await execFileNoThrow('/usr/bin/which', ['claude']);
	const realCodex = await execFileNoThrow('/usr/bin/which', ['codex']);
	if (realClaude.exitCode !== 0 || realCodex.exitCode !== 0)
		throw new Error('Both native binaries are required');
	const guard = `(version 1) (allow default) (deny file-write*) (allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))`;
	const wrappers: Record<string, string> = {};
	for (const [provider, binary] of [
		['claude-code', realClaude.stdout.trim()],
		['codex', realCodex.stdout.trim()],
	]) {
		const wrapper = path.join(root, `${provider}-isolated.sh`);
		await fs.writeFile(
			wrapper,
			`#!/bin/sh\nexec /usr/bin/sandbox-exec -p ${shellEscape(guard)} ${shellEscape(binary)} "$@"\n`,
			{ mode: 0o700, flag: 'wx' }
		);
		wrappers[provider] = wrapper;
	}
	const versions = {} as Record<keyof typeof TRANSLATION_PROVIDER_VERSIONS, string>;
	for (const provider of ['claude-code', 'codex'] as const) {
		const probe = await execFileNoThrow(wrappers[provider], ['--version'], undefined, { env });
		versions[provider] = acceptanceProviderVersion(
			provider,
			probe.exitCode === 0 ? probe.stdout : ''
		);
	}
	const originalIdentity: TranslationIdentity = {
		provider: 'claude-code',
		version: versions['claude-code'],
		accountRoot: sourceRoot,
		projectRoot: originalProject,
	};
	const resources = await collectTranslationResources(originalIdentity, scope);
	for (const artifact of resources.artifacts.filter(
		(a) => a.kind === 'instruction' && a.scope === 'project'
	)) {
		const file = path.join(project, artifact.relativePath);
		if (
			artifact.symlinkTarget &&
			!path.isAbsolute(artifact.symlinkTarget) &&
			!artifact.symlinkTarget.startsWith('..')
		)
			await fs.symlink(artifact.symlinkTarget, file);
		else
			await fs.writeFile(file, Buffer.from(artifact.bytesBase64, 'base64'), {
				flag: 'wx',
				mode: 0o600,
			});
	}
	const sourceFile = path.join(
		claudeHome,
		'projects',
		encodeClaudeProjectPath(originalProject),
		`${live.nativeId}.jsonl`
	);
	await fs.mkdir(path.dirname(sourceFile), { recursive: true, mode: 0o700 });
	await fs.writeFile(sourceFile, originalBytes, { flag: 'wx', mode: 0o600 });
	const registry = createTranslationRegistry();
	const archive = new TranslationArchive(path.join(root, 'archive'));
	let current: TranslationIdentity = { ...originalIdentity, accountRoot: claudeHome };
	let nativeId = live.nativeId;
	let nativeFile = sourceFile;
	let knowledge: string | undefined;
	let committedOperation: string | undefined;
	const evidence: Array<Record<string, unknown>> = [];
	const evidenceDirectory = path.join(
		workspace,
		'.maestro',
		'scratch',
		'provider-translation-acceptance'
	);
	await fs.mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
	const evidenceFile = path.join(
		evidenceDirectory,
		`evidence-${fileTimestampSlug()}-${Date.now()}.json`
	);
	const saveEvidence = async (): Promise<void> => {
		await atomicWriteFile(
			evidenceFile,
			JSON.stringify({
				schemaVersion: 1,
				createdAt: new Date().toISOString(),
				testedVersions: versions,
				originalSourceSha256: originalHash,
				hops: evidence,
				verification: 'unverified',
			}),
			{ mode: 0o600, durable: true }
		);
	};
	const knowledgeRoot = translationKnowledgeRoot(env.MAESTRO_USER_DATA);
	const assertOriginal = async (): Promise<void> => {
		if (translationHash(await fs.readFile(originalTranscript)) !== originalHash)
			throw new Error('Original transcript changed during isolated acceptance');
		for (const artifact of resources.artifacts) {
			const bytes = artifact.metadata?.directoryLink
				? Buffer.from(await fs.readlink(artifact.sourcePath))
				: await fs.readFile(artifact.sourcePath);
			if (translationHash(bytes) !== artifact.sha256)
				throw new Error('Original knowledge changed during isolated acceptance');
		}
	};
	// Launch planning resolves the trusted data directory from the host environment.
	// Change it only while inside the restoration boundary, after setup has succeeded.
	Object.assign(process.env, env);
	try {
		for (const [hopIndex, provider] of (['codex', 'claude-code', 'codex'] as const).entries()) {
			const startedAt = performance.now();
			const hop = {
				direction: { source: current.provider, destination: provider },
				versions: { source: current.version, destination: versions[provider] },
				path: hopIndex === 1 ? 'translate-at-send' : 'single-tab',
				planStatus: null as TranslationPlan['status'] | null,
				limitations: [] as TranslationPlan['limitations'],
				recall: { answer: null as string | null, passed: false },
				memoryDelta: { expected: hopIndex > 0, found: false },
				duplicateImport: {
					passed: false,
					importedNewRecords: null as number | null,
					records: 0,
					newRecords: 0,
				},
				originalSourceSha256: { before: null as string | null, after: null as string | null },
				compactionWindow: { present: false, passed: false, activeRecords: 0, archivedRecords: 0 },
				managedKnowledge: false,
				archivePreserved: false,
				payloadClasses: [] as string[],
				passed: false,
				error: null as string | null,
				wallTimeMs: 0,
			};
			evidence.push(hop);
			try {
				hop.originalSourceSha256.before = translationHash(await fs.readFile(originalTranscript));
				await assertOriginal();
				const raw = await fs.readFile(nativeFile);
				const input = registry
					.get(current.provider)!
					.extract(current, GUINEA_PIG.tabId, nativeId, raw);
				const checkpoint = await archive.checkpoint('isolated-guinea-pig');
				const reconciled = reconcileConversation(input, checkpoint);
				const selectedResources = structuredClone(checkpoint?.resources ?? resources.artifacts);
				const destination: TranslationIdentity = {
					provider,
					version: versions[provider],
					accountRoot: provider === 'codex' ? codexHome : claudeHome,
					projectRoot: project,
				};
				const projections = await planResourceProjections(
					selectedResources,
					destination,
					checkpoint
				);
				const plan = planTabTranslation({
					agentId: 'isolated-guinea-pig',
					tabId: GUINEA_PIG.tabId,
					source: current,
					destination,
					scope,
					conversations: [reconciled.conversation],
					registry,
					resources: selectedResources,
					limitations: [...resources.limitations, ...projections.limitations],
				});
				hop.planStatus = plan.status;
				hop.limitations = plan.limitations;
				assertAcceptancePlan(plan);
				const journal: TranslationJournal = {
					schemaVersion: 1,
					plan,
					state: 'planned',
					conversations: [reconciled.conversation],
					resources: selectedResources,
					mappings: [],
					resourceWrites: [],
					projections: projections.projections,
					checkpoint: checkpoint ?? {
						observed: {},
						lineage: {},
						conversations: [],
						resources: [],
						resourceBases: {},
						providerRoots: {},
					},
				};
				for (const record of input.records)
					journal.checkpoint!.observed[nativeRecordKey(current, nativeId, record.nativeId)] =
						record.semanticHash;
				const connection =
					provider === 'codex'
						? await openCodexTranslationConnection({ binary: wrappers.codex, cwd: project, env })
						: undefined;
				let result;
				try {
					result = await applyAcceptanceHop(
						journal,
						() =>
							applyTabTranslation(
								archive,
								registry,
								journal,
								{
									knowledgeRoot,
									codex: connection,
									assertSourceUnchanged: async () => {
										await assertOriginal();
										if (translationHash(await fs.readFile(nativeFile)) !== translationHash(raw))
											throw new Error('Isolated source changed since snapshot');
									},
									setMigration: async () => {},
									isCommitted: async (id) => committedOperation === id,
									commit: async (operation) => {
										await atomicWriteFile(
											path.join(root, 'mapping.json'),
											JSON.stringify(operation.mappings),
											{ mode: 0o600, durable: true }
										);
										committedOperation = operation.plan.id;
									},
								},
								true
							),
						hopIndex === 1
					);
				} finally {
					connection?.close();
				}
				if (
					!result.success ||
					result.state !== 'committed' ||
					!result.mappings[0]?.destinationSessionId
				)
					throw new Error(result.error ?? 'Native apply refused');
				const archived = await archive.read(plan.agentId, plan.id);
				hop.archivePreserved =
					canonicalJson(archived.conversations) === canonicalJson(journal.conversations) &&
					archived.conversations.some((conversation) =>
						conversation.artifacts.some(
							(artifact) =>
								artifact.kind === 'transcript' && artifact.sha256 === translationHash(raw)
						)
					);
				if (!hop.archivePreserved)
					throw new Error('Source bytes or portable records are absent from the archive');
				current = destination;
				nativeId = result.mappings[0].destinationSessionId;
				nativeFile = result.mappings[0].artifacts[0].path;
				knowledge = journal.knowledgeDirectory;
				if (!knowledge) throw new Error('Translation returned no managed knowledge directory');
				assertTranslationKnowledgeDirectory(knowledge, knowledgeRoot);
				if (isPathAtOrUnderRoot(knowledge, project))
					throw new Error('Managed knowledge was written into the project');
				for (const resource of selectedResources) {
					if (resource.kind !== 'memory' && resource.kind !== 'instruction') continue;
					if (
						translationHash(await fs.readFile(path.join(knowledge, resource.relativePath))) !==
						resource.sha256
					)
						throw new Error('Managed knowledge differs from the selected resource');
				}
				hop.managedKnowledge = true;
				const staged = registry
					.get(provider)!
					.extract(current, GUINEA_PIG.tabId, nativeId, await fs.readFile(nativeFile));
				hop.limitations = [...hop.limitations, ...staged.limitations];
				assertAcceptancePlan({ ...plan, limitations: hop.limitations });
				assertAcceptanceContextWindow(reconciled.conversation, staged);
				const committedCheckpoint = await archive.checkpoint('isolated-guinea-pig');
				if (!committedCheckpoint) throw new Error('Native import did not persist its checkpoint');
				const imported = reconcileConversation(staged, committedCheckpoint);
				hop.duplicateImport.importedNewRecords = imported.newRecords;
				// Provider metadata has no projected lineage. Every projected row must map
				// back to an existing source origin rather than count as fresh history.
				const sourceOrigins = new Set(
					reconciled.conversation.records.map((record) => recordKey(record.origin))
				);
				if (
					staged.records
						.filter((record) => record.role === 'user' || record.role === 'assistant')
						.some((record) => {
							const origin =
								committedCheckpoint?.lineage[nativeRecordKey(current, nativeId, record.nativeId)];
							return !origin || !sourceOrigins.has(recordKey(origin));
						})
				)
					throw new Error('Imported native history lost its original lineage');
				const active = activeContextRecords(reconciled.conversation.records);
				hop.compactionWindow = {
					present: reconciled.conversation.records.some(
						(r) => r.boundary === 'compaction' || r.window === 'archived'
					),
					passed: true,
					activeRecords: active.length,
					archivedRecords: reconciled.conversation.records.length - active.length,
				};
				const turn = await planSessionTurn({
					agentId: provider,
					command: wrappers[provider],
					cwd: project,
					resumeSessionId: nativeId,
					prompt: inputs.question,
					readOnly: true,
					envVars: { ...env, ...(knowledge && { [TRANSLATION_KNOWLEDGE_ENV_VAR]: knowledge }) },
				});
				if (!turn.ok) throw new Error(turn.error);
				const completed = await runToCompletion(turn.spec, {
					agentId: provider,
					sessionId: 'isolated-acceptance',
					stopGraceMs: BACKGROUND_STOP_GRACE_MS,
				});
				hop.recall.answer = completed.answerText ?? null;
				hop.recall.passed =
					completed.outcome === 'completed' && !!completed.answerText?.includes(inputs.expected);
				if (!hop.recall.passed)
					throw new Error('Native continuation failed to recall the expected earlier fact');
				if (completed.sessionId && completed.sessionId !== nativeId)
					throw new Error('Continuation returned a different native identity');
				// Isolated source-only memory delta. It is supplied through the actual launch binding on the next native continuation.
				if (hopIndex === 0) {
					await seedAcceptanceMemoryDelta(archive, plan, current, knowledge);
				}
				if (hopIndex > 0) {
					const memoryTurn = await planSessionTurn({
						agentId: provider,
						command: wrappers[provider],
						cwd: project,
						resumeSessionId: nativeId,
						prompt: 'Read the isolated project memory and report the acceptance memory value.',
						readOnly: true,
						envVars: { ...env, [TRANSLATION_KNOWLEDGE_ENV_VAR]: knowledge },
					});
					if (!memoryTurn.ok) throw new Error(memoryTurn.error);
					const memoryResult = await runToCompletion(memoryTurn.spec, {
						agentId: provider,
						sessionId: 'isolated-memory-acceptance',
						stopGraceMs: BACKGROUND_STOP_GRACE_MS,
					});
					hop.memoryDelta.found =
						memoryResult.outcome === 'completed' &&
						!!memoryResult.answerText?.includes('violet heron');
					if (
						!hop.memoryDelta.found ||
						(memoryResult.sessionId && memoryResult.sessionId !== nativeId)
					)
						throw new Error('Native memory discovery failed');
				}
				const after = registry
					.get(provider)!
					.extract(current, GUINEA_PIG.tabId, nativeId, await fs.readFile(nativeFile));
				const delta = reconcileConversation(after, await archive.checkpoint('isolated-guinea-pig'));
				hop.limitations = [...hop.limitations, ...delta.limitations];
				assertAcceptancePlan({ ...plan, limitations: hop.limitations });
				hop.duplicateImport = {
					passed:
						new Set(delta.conversation.records.map((r) => recordKey(r.origin))).size ===
						delta.conversation.records.length,
					importedNewRecords: imported.newRecords,
					records: delta.conversation.records.length,
					newRecords: delta.newRecords,
				};
				if (!hop.duplicateImport.passed) throw new Error('Round-trip lineage echoes detected');
				// Only native payloads read back and resources checked above count as covered.
				const classes = new Set<string>(['conversation', 'transcript']);
				if (
					reconciled.conversation.records.some((record) =>
						record.blocks.some((block) => block.kind === 'opaque')
					)
				)
					classes.add('opaque');
				for (const record of staged.records)
					for (const block of record.blocks)
						if (block.kind !== 'text' && block.kind !== 'opaque') classes.add(block.kind);
				for (const resource of selectedResources)
					if (resource.kind === 'memory' || resource.kind === 'instruction')
						classes.add(resource.kind);
				if (hop.compactionWindow.present) classes.add('compaction');
				hop.payloadClasses = [...classes].sort();
				await assertOriginal();
				hop.passed = true;
			} catch (error) {
				hop.error = error instanceof Error ? error.message : String(error);
				throw error;
			} finally {
				try {
					hop.originalSourceSha256.after = translationHash(await fs.readFile(originalTranscript));
					await assertOriginal();
				} catch (error) {
					hop.passed = false;
					hop.error = error instanceof Error ? error.message : String(error);
					throw error;
				} finally {
					hop.wallTimeMs = performance.now() - startedAt;
					await saveEvidence();
				}
			}
		}
		console.log(
			`Isolated acceptance evidence: ${evidenceFile}. Registry certification remains unchanged.`
		);
	} finally {
		for (const key of Object.keys(process.env))
			if (!(key in originalEnvironment)) delete process.env[key];
		Object.assign(process.env, originalEnvironment);
		await assertOriginal();
	}
}
