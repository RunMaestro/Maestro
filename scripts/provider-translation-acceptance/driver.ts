import { BACKGROUND_STOP_GRACE_MS } from '../../src/shared/maestro-lib/control/termination';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
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
import { TRANSLATION_KNOWLEDGE_ENV_VAR } from '../../src/shared/maestro-lib/translation/knowledge-binding';
import {
	TranslationArchive,
	createTranslationRegistry,
	planTranslation,
	applyTranslation,
	collectTranslationResources,
	reconcileConversation,
	planResourceProjections,
	type TranslationIdentity,
	type TranslationJournal,
} from '../../src/shared/maestro-lib/translation';

export const GUINEA_PIG = {
	agentId: '92eb2f16-433d-4ecd-bb87-885c8a64b2f7',
	tabId: 'a77c0b6c-83c5-4275-baa9-9098994993f1',
};

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
		HOME: home,
		CLAUDE_CONFIG_DIR: claudeHome,
		CODEX_HOME: codexHome,
		TMPDIR: path.join(root, 'tmp'),
		XDG_CONFIG_HOME: path.join(home, '.config'),
		XDG_CACHE_HOME: path.join(home, '.cache'),
		XDG_DATA_HOME: path.join(home, '.local/share'),
	};
	const originalEnvironment = { ...process.env };
	Object.assign(process.env, env);
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
	const versions: Record<string, string> = {};
	for (const provider of ['claude-code', 'codex']) {
		const probe = await execFileNoThrow(wrappers[provider], ['--version'], undefined, { env });
		versions[provider] = /\d+\.\d+\.\d+/.exec(probe.stdout)?.[0] ?? '';
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
	try {
		for (const provider of ['codex', 'claude-code', 'codex'] as const) {
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
			const projections = await planResourceProjections(selectedResources, destination, checkpoint);
			const plan = planTranslation({
				agentId: 'isolated-guinea-pig',
				source: current,
				destination,
				scope,
				conversations: [reconciled.conversation],
				registry,
				resources: selectedResources,
				limitations: [...resources.limitations, ...projections.limitations],
			});
			if (plan.status === 'blocked')
				throw new Error(plan.limitations.map((l) => l.message).join('\n'));
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
				result = await applyTranslation(
					archive,
					registry,
					journal,
					{
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
				);
			} finally {
				connection?.close();
			}
			if (!result.success || !result.mappings[0]?.destinationSessionId)
				throw new Error(result.error ?? 'Native apply refused');
			current = destination;
			nativeId = result.mappings[0].destinationSessionId;
			nativeFile = result.mappings[0].artifacts[0].path;
			knowledge = journal.knowledgeDirectory;
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
			if (completed.outcome !== 'completed' || !completed.answerText?.includes(inputs.expected))
				throw new Error('Native continuation failed to recall the expected earlier fact');
			if (completed.sessionId && completed.sessionId !== nativeId)
				throw new Error('Continuation returned a different native identity');
			// Isolated source-only memory delta. It is supplied through the actual launch binding on the next native continuation.
			if (provider === 'codex' && evidence.length === 0 && knowledge) {
				const topic = path.join(knowledge, 'memory', 'acceptance-delta.md');
				await fs.mkdir(path.dirname(topic), { recursive: true });
				await fs.writeFile(topic, 'Isolated acceptance memory: violet heron.\n');
				const index = path.join(knowledge, 'memory', 'MEMORY.md');
				await fs.appendFile(index, '\n[Isolated acceptance memory](acceptance-delta.md)\n');
				journal.checkpoint!.resources = [
					...selectedResources,
					{
						id: translationHash(topic),
						kind: 'memory',
						sourcePath: topic,
						relativePath: 'memory/acceptance-delta.md',
						sha256: translationHash(await fs.readFile(topic)),
						bytesBase64: (await fs.readFile(topic)).toString('base64'),
						scope: 'project',
					},
				];
				for (const artifact of journal.checkpoint!.resources) {
					const file = path.join(knowledge, artifact.relativePath);
					try {
						const bytes = await fs.readFile(file);
						artifact.bytesBase64 = bytes.toString('base64');
						artifact.sha256 = translationHash(bytes);
					} catch {
						/* Non-memory native resources retain their archived bodies. */
					}
				}
				await archive.saveCheckpoint('isolated-guinea-pig', journal.checkpoint!);
			}
			if (evidence.length > 0 && knowledge) {
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
				if (
					memoryResult.outcome !== 'completed' ||
					!memoryResult.answerText?.includes('violet heron')
				)
					throw new Error('Native memory discovery failed');
			}
			const after = registry
				.get(provider)!
				.extract(current, GUINEA_PIG.tabId, nativeId, await fs.readFile(nativeFile));
			const delta = reconcileConversation(after, await archive.checkpoint('isolated-guinea-pig'));
			if (
				new Set(delta.conversation.records.map((r) => recordKey(r.origin))).size !==
				delta.conversation.records.length
			)
				throw new Error('Round-trip lineage echoes detected');
			evidence.push({
				provider,
				version: current.version,
				nativeId,
				nativeResume: completed.outcome,
				recalled: true,
				records: delta.conversation.records.length,
				newRecords: delta.newRecords,
				verification: 'unverified',
			});
			await assertOriginal();
		}
		await atomicWriteFile(
			path.join(root, 'evidence.json'),
			JSON.stringify({
				originalHash,
				evidence,
				verification: 'unverified',
				limits: resources.limitations,
			}),
			{ mode: 0o600, durable: true }
		);
		console.log(
			`Isolated acceptance evidence: ${path.join(root, 'evidence.json')}. Registry certification remains unchanged.`
		);
	} finally {
		for (const key of Object.keys(process.env))
			if (!(key in originalEnvironment)) delete process.env[key];
		Object.assign(process.env, originalEnvironment);
		await assertOriginal();
	}
}
