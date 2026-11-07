import { assertTranslationTarget } from './resource-projections';
import { translationKnowledgePrompt, resourceBindingHash } from './resources';
import type { TranslationFs } from './fs-port';
import { localTranslationFs } from './local-fs';
import * as path from 'node:path';
import { createKeyedWriteQueue } from '../../keyedWriteQueue';
import { canonicalJson } from '../../canonicalJson';
import { translationHash, nativeRecordKey, translationArtifact } from './identity';
import { extractNativeConversation } from './native-records';
import { TranslationArchive, type TranslationJournal } from './archive';
import { TranslationRegistry } from './registry';
import type {
	TranslationResult,
	TranslationRpc,
	TranslationCheckpoint,
	ProviderMigrationState,
	OwnedTranslationWrite,
} from './types';
import { TranslationSourceBusyError } from './types';
import { limitationsNeedingAcceptance } from './limitations';
import { assertTranslationKnowledgeDirectory } from './knowledge-binding';
import { isPathAtOrUnderRoot } from '../../worktreePaths';

export interface TranslationTransactionHost {
	/** Native provider files; the archive owns a separate, fixed local filesystem. */
	nativeFs?: TranslationFs;
	/** Host-owned directory: local app data or the SSH user's .maestro, never the project. */
	knowledgeRoot: string;
	/** Resolve git metadata without coupling the library to the desktop host. */
	resolveProjectGit?(
		projectRoot: string
	): Promise<{ root: string; commonDirectory: string } | undefined>;
	/** Called again before every mutation and commit, not just when planning. */
	assertSourceUnchanged(journal: TranslationJournal): Promise<void>;
	setMigration(state: ProviderMigrationState): Promise<void>;
	/** Atomically commit the selected mappings and operation ID; only an unscoped plan switches the agent. */
	commit(journal: TranslationJournal): Promise<void>;
	isCommitted(operationId: string): Promise<boolean>;
	codex?: TranslationRpc;
}

const operations = createKeyedWriteQueue();

/** A journal never gets to choose an arbitrary root for its writes or rollback. */
async function translationWriteRoot(
	journal: TranslationJournal,
	write: OwnedTranslationWrite,
	knowledgeRoot: string,
	allowLegacyKnowledge = false,
	resolveProjectGit?: TranslationTransactionHost['resolveProjectGit'],
	nativeFs: TranslationFs = localTranslationFs
): Promise<string> {
	const paths = nativeFs?.paths ?? path;
	if (!journal.resourceWrites.includes(write))
		return journal.plan.destination.nativeSessionRoot ?? journal.plan.destination.accountRoot;
	if (write.gitExcludeBlock) {
		const git = await resolveProjectGit?.(journal.plan.destination.projectRoot);
		if (!git || paths.resolve(write.path) !== paths.join(git.commonDirectory, 'info', 'exclude'))
			throw new Error('Unsafe journal git exclude path');
		return git.commonDirectory;
	}
	const directory = journal.knowledgeDirectory;
	if (directory) {
		const suffix = paths.join(translationHash(journal.plan.agentId), journal.plan.id);
		const legacyRoot = paths.join(
			journal.plan.destination.projectRoot,
			'.maestro/provider-knowledge'
		);
		const legacy =
			allowLegacyKnowledge && paths.resolve(directory) === paths.resolve(legacyRoot, suffix);
		const root = legacy ? legacyRoot : knowledgeRoot;
		if (paths.resolve(directory) !== paths.resolve(root, suffix))
			throw new Error('Unsafe journal knowledge directory');
		await assertTranslationKnowledgeDirectory(directory, root, nativeFs);
		if (
			isPathAtOrUnderRoot(
				paths.resolve(write.path).split(paths.sep).join('/'),
				paths.resolve(directory).split(paths.sep).join('/')
			)
		)
			return legacy ? journal.plan.destination.projectRoot : root;
	}
	return journal.plan.destination.projectRoot;
}

/** An intent is not ownership: only a successful exclusive create permits rollback deletion. */
async function stageResourceWrite(
	archive: TranslationArchive,
	journal: TranslationJournal,
	write: OwnedTranslationWrite,
	bytes: Buffer,
	knowledgeRoot: string,
	resolveProjectGit?: TranslationTransactionHost['resolveProjectGit'],
	nativeFs: TranslationFs = localTranslationFs
): Promise<void> {
	const paths = nativeFs?.paths ?? path;
	const owned = { ...write, created: false };
	journal.resourceWrites.push(owned);
	await archive.write(journal);
	const root = await translationWriteRoot(
		journal,
		owned,
		knowledgeRoot,
		false,
		resolveProjectGit,
		nativeFs
	);
	await assertTranslationTarget(write.path, root, nativeFs);
	await nativeFs.mkdir(paths.dirname(write.path), { recursive: true, mode: 0o700 });
	await assertTranslationTarget(write.path, root, nativeFs);
	if (write.deleted) await nativeFs.unlink(write.path);
	else if (write.symlinkTarget && write.created) {
		await nativeFs.symlink(write.symlinkTarget, write.path);
		owned.created = true;
		await archive.write(journal);
	} else if (write.created) {
		await nativeFs.createExclusive(write.path, bytes, {
			mode: write.mode ?? 0o600,
			durable: true,
			onCreated: async () => {
				owned.created = true;
				await archive.write(journal);
			},
		});
	} else
		await nativeFs.atomicWrite(write.path, bytes, { mode: write.mode ?? 0o600, durable: true });
}

async function deferTranslation(
	archive: TranslationArchive,
	journal: TranslationJournal,
	host: TranslationTransactionHost,
	acceptLimitations: boolean
): Promise<TranslationResult> {
	const plan = journal.plan;
	plan.status = 'deferred';
	journal.state = 'planned';
	await archive.write(journal);
	await archive.markLatest(plan.agentId, plan.id);
	await host.setMigration({
		operationId: plan.id,
		tabId: plan.tabId,
		destination: plan.destination.provider,
		state: 'deferred',
		verification: plan.verification,
		acceptLimitations,
		selectedUserResources: plan.scope.selectedUserResources,
		projectResourcesIntoRepo: plan.scope.projectResourcesIntoRepo,
		acceptedLimitationCodes: limitationsNeedingAcceptance(plan.limitations).map(canonicalJson),
	});
	return {
		success: false,
		state: 'deferred',
		plan,
		mappings: [],
		error: 'Source turn is still active. Migration is selected but not committed.',
	};
}

/** Unverified/partial warnings need an explicit opt-in. Blocking failures cannot be accepted. */
export async function applyTranslation(
	archive: TranslationArchive,
	registry: TranslationRegistry,
	journal: TranslationJournal,
	host: TranslationTransactionHost,
	acceptLimitations = false
): Promise<TranslationResult> {
	const nativeFs = host.nativeFs ?? localTranslationFs;
	const paths = nativeFs.paths ?? path;
	return operations.enqueue(journal.plan.agentId, async () => {
		const plan = journal.plan;
		assertTabScope(journal);
		// Reapplying a durable operation must never replay an uncertain native import.
		if (journal.state === 'committed' && journal.result?.state === 'committed')
			return journal.result;
		if (
			journal.state !== 'planned' ||
			journal.mappings.length > 0 ||
			journal.resourceWrites.length > 0
		)
			return {
				success: false,
				state: 'refused',
				plan,
				mappings: journal.mappings,
				error:
					'Existing provider migration requires recovery or rollback; native staging is not replayed.',
			};
		if (plan.status === 'noop') return { success: true, state: 'noop', plan, mappings: [] };
		if (
			plan.status === 'blocked' ||
			(!acceptLimitations && limitationsNeedingAcceptance(plan.limitations).length)
		) {
			journal.result = {
				success: false,
				state: 'refused',
				plan,
				mappings: [],
				error: plan.limitations.map((l) => l.message).join('\n'),
			};
			await archive.write(journal);
			await archive.markLatest(plan.agentId, plan.id);
			return journal.result;
		}
		if (plan.status === 'deferred') {
			return deferTranslation(archive, journal, host, acceptLimitations);
		}
		const release = await archive.lock(plan.agentId);
		let releaseProject: (() => Promise<void>) | undefined;
		let releaseGit: (() => Promise<void>) | undefined;
		try {
			releaseProject = await archive.lock(`project:${plan.destination.projectRoot}`);
			const currentCheckpoint = await archive.checkpoint(plan.agentId);
			if (currentCheckpoint?.operationId !== journal.checkpoint?.operationId)
				return {
					success: false,
					state: 'refused',
					plan,
					mappings: [],
					error: 'Agent checkpoint changed since preflight; plan translation again',
				};
			await host.assertSourceUnchanged(journal);
			journal.state = 'staging';
			await archive.write(journal);
			await archive.markLatest(plan.agentId, plan.id);
			await host.setMigration({
				operationId: plan.id,
				tabId: plan.tabId,
				destination: plan.destination.provider,
				state: 'staging',
				verification: plan.verification,
			});
			const projections = plan.scope.projectResourcesIntoRepo ? (journal.projections ?? []) : [];
			if (projections.some((p) => !p.deleted) && !host.resolveProjectGit)
				throw new Error('Project resource installation requires a host git resolver');
			const git = projections.some((p) => !p.deleted)
				? await host.resolveProjectGit?.(plan.destination.projectRoot)
				: undefined;
			if (
				projections.some((p) => !p.deleted) &&
				!git &&
				!plan.limitations.some((l) => l.code === 'resource-git-exclude-unavailable')
			)
				plan.limitations.push({
					code: 'resource-git-exclude-unavailable',
					severity: 'info',
					message:
						'This project is not a git repository. Native resources will be installed without a local git exclude entry.',
				});
			if (git) releaseGit = await archive.lock(`git:${git.commonDirectory}`);
			const adapter = registry.get(plan.destination.provider);
			if (!adapter) throw new Error('Destination translation adapter unavailable');
			for (const conversation of journal.conversations) {
				await host.assertSourceUnchanged(journal);
				if (!conversation.records.some((r) => r.role === 'user' || r.role === 'assistant')) {
					journal.mappings.push({
						tabId: conversation.tabId,
						sourceSessionId: conversation.nativeSessionId,
						destinationSessionId: null,
						artifacts: [],
						lineage: {},
					});
					continue;
				}
				await adapter.stage(conversation, {
					operationId: plan.id,
					destination: plan.destination,
					codex: host.codex,
					nativeFs,
					recordIntent: async (mapping) => {
						journal.mappings = [
							...journal.mappings.filter((m) => m.tabId !== mapping.tabId),
							mapping,
						];
						await archive.write(journal);
					},
				});
			}
			if (git) {
				const file = paths.join(git.commonDirectory, 'info', 'exclude');
				await assertTranslationTarget(file, git.commonDirectory, nativeFs);
				let current: Buffer | undefined;
				try {
					current = await nativeFs.readFile(file);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				}
				const excludePaths = projections
					.filter((p) => !p.deleted)
					.map((p) => {
						const relative = paths.relative(git.root, p.path).split(paths.sep).join('/');
						if (
							!relative ||
							relative === '..' ||
							relative.startsWith('../') ||
							paths.isAbsolute(relative) ||
							/[\r\n]/.test(relative)
						)
							throw new Error('Unsafe git exclude resource path');
						// Anchored literal patterns, including names with gitignore metacharacters.
						return '/' + relative.replace(/([\\*?\[\] ])/g, '\\$1');
					});
				const block = `${current?.length && current[current.length - 1] !== 10 ? '\n' : ''}# Maestro provider resources ${plan.id} begin\n${[...new Set(excludePaths)].join('\n')}\n# Maestro provider resources ${plan.id} end\n`;
				const bytes = Buffer.concat([current ?? Buffer.alloc(0), Buffer.from(block)]);
				const backup = current
					? {
							...translationArtifact('instruction', file, 'git-info-exclude', current),
							mode: (await nativeFs.stat(file)).mode & 0o777,
						}
					: undefined;
				await stageResourceWrite(
					archive,
					journal,
					{
						path: file,
						sha256: translationHash(bytes),
						created: !current,
						gitExcludeBlock: block,
						backup,
						mode: backup?.mode,
					},
					bytes,
					host.knowledgeRoot,
					host.resolveProjectGit,
					nativeFs
				);
			}
			for (const projection of projections) {
				await host.assertSourceUnchanged(journal);
				await assertTranslationTarget(projection.path, plan.destination.projectRoot, nativeFs);
				let current: Buffer | undefined;
				try {
					current = await nativeFs.readFile(projection.path);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				}
				if ((current ? translationHash(current) : null) !== projection.expectedHash)
					throw new Error('Native resource changed since preflight');
				await stageResourceWrite(
					archive,
					journal,
					projection,
					Buffer.from(projection.bytesBase64, 'base64'),
					host.knowledgeRoot,
					host.resolveProjectGit,
					nativeFs
				);
			}
			journal.resources.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
			const resourceKey = translationHash(
				canonicalJson({
					source: plan.source,
					destination: plan.destination,
					scope: plan.scope,
					binding: resourceBindingHash(journal.resources),
					resources: journal.resources.map((resource) => ({
						path: resource.relativePath,
						kind: resource.kind,
						mode: resource.mode,
						symlinkTarget: resource.symlinkTarget,
					})),
				})
			);
			const previousImport = currentCheckpoint?.resourceImport;
			journal.resourceImport =
				previousImport?.key === resourceKey
					? previousImport
					: { key: resourceKey, operationId: plan.id };
			if (journal.resourceImport.operationId !== plan.id) {
				journal.knowledgeDirectory = paths.resolve(
					host.knowledgeRoot,
					translationHash(plan.agentId),
					journal.resourceImport.operationId
				);
			} else if (journal.plan.scope.projectKnowledge) {
				const directory = paths.resolve(host.knowledgeRoot, translationHash(plan.agentId), plan.id);
				journal.knowledgeDirectory = directory;
				await assertTranslationKnowledgeDirectory(directory, host.knowledgeRoot, nativeFs);
				await nativeFs.mkdir(host.knowledgeRoot, { recursive: true, mode: 0o700 });
				for (const artifact of journal.resources) {
					const relative = paths.normalize(artifact.relativePath);
					if (
						paths.isAbsolute(relative) ||
						relative === '..' ||
						relative.startsWith('..' + paths.sep)
					)
						throw new Error('Unsafe resource projection path');
					const file = paths.join(directory, relative);
					const bytes = Buffer.from(artifact.bytesBase64, 'base64');
					await stageResourceWrite(
						archive,
						journal,
						{ path: file, sha256: artifact.sha256, created: true, mode: artifact.mode },
						bytes,
						host.knowledgeRoot,
						host.resolveProjectGit,
						nativeFs
					);
				}
				const indexPath = paths.join(directory, 'knowledge-index.md');
				const index = translationKnowledgePrompt(directory, journal.resources, paths);
				await stageResourceWrite(
					archive,
					journal,
					{ path: indexPath, sha256: translationHash(index), created: true },
					Buffer.from(index),
					host.knowledgeRoot,
					host.resolveProjectGit,
					nativeFs
				);
			}
			await verifyTranslationWrites(
				journal,
				host.knowledgeRoot,
				false,
				host.resolveProjectGit,
				nativeFs
			);
			journal.state = 'staged';
			await archive.write(journal);
			await host.assertSourceUnchanged(journal);
			journal.state = 'committing';
			await archive.write(journal);
			await host.commit(journal);
			await finalizeTranslation(archive, journal);
			await host.setMigration({
				operationId: plan.id,
				tabId: plan.tabId,
				destination: plan.destination.provider,
				state: 'committed',
				verification: plan.verification,
			});
			return journal.result!;
		} catch (error) {
			if (
				error instanceof TranslationSourceBusyError &&
				journal.mappings.length === 0 &&
				journal.resourceWrites.length === 0
			)
				return await deferTranslation(archive, journal, host, acceptLimitations);
			// A commit may have landed before a store/notification error. Never report it rolled back.
			const committed = await host.isCommitted(plan.id);
			journal.failurePhase = journal.state;
			journal.state = committed ? 'recovery-required' : 'failed';
			journal.error = error instanceof Error ? error.message : String(error);
			journal.result = {
				success: false,
				state: journal.state,
				plan,
				mappings: journal.mappings,
				error: journal.error,
			};
			await archive.write(journal);
			await host.setMigration({
				operationId: plan.id,
				tabId: plan.tabId,
				destination: plan.destination.provider,
				state: journal.state,
				verification: plan.verification,
				error: journal.error,
			});
			return journal.result;
		} finally {
			await releaseGit?.();
			await releaseProject?.();
			await release();
		}
	});
}

/** Select the existing transaction engine, including its recovery and rollback journal. */
export async function applyTabTranslation(
	...args: Parameters<typeof applyTranslation>
): Promise<TranslationResult> {
	if (!args[2].plan.tabId) throw new Error('Single-tab apply requires a tab-scoped plan');
	return applyTranslation(...args);
}

function assertTabScope(journal: TranslationJournal): void {
	const tabId = journal.plan.tabId;
	if (
		tabId !== undefined &&
		(!tabId ||
			journal.plan.tabs.length !== 1 ||
			journal.plan.tabs[0].tabId !== tabId ||
			journal.conversations.length !== 1 ||
			journal.conversations[0].tabId !== tabId ||
			journal.mappings.some((mapping) => mapping.tabId !== tabId))
	)
		throw new Error('Single-tab journal contains an unrelated conversation or mapping');
}

export async function verifyTranslationWrites(
	journal: TranslationJournal,
	knowledgeRoot: string,
	allowLegacyKnowledge = false,
	resolveProjectGit?: TranslationTransactionHost['resolveProjectGit'],
	nativeFs: TranslationFs = localTranslationFs
): Promise<void> {
	const paths = nativeFs?.paths ?? path;
	assertTabScope(journal);
	if (journal.mappings.length !== journal.conversations.length)
		throw new Error('Incomplete all-tabs mapping');
	if (journal.resourceImport && journal.resourceImport.operationId !== journal.plan.id) {
		const directory = paths.resolve(
			knowledgeRoot,
			translationHash(journal.plan.agentId),
			journal.resourceImport.operationId
		);
		if (journal.knowledgeDirectory !== directory)
			throw new Error('Invalid reused knowledge directory');
		await assertTranslationKnowledgeDirectory(directory, knowledgeRoot, nativeFs);
		for (const resource of journal.resources) {
			const file = paths.join(directory, resource.relativePath);
			await assertTranslationTarget(file, directory, nativeFs);
			if (translationHash(await nativeFs.readFile(file)) !== resource.sha256)
				throw new Error('Previously imported resource changed since preflight');
		}
		const index = paths.join(directory, 'knowledge-index.md');
		await assertTranslationTarget(index, directory, nativeFs);
		if (
			(await nativeFs.readFile(index)).toString('utf8') !==
			translationKnowledgePrompt(directory, journal.resources, paths)
		)
			throw new Error('Previously imported knowledge index changed since preflight');
	}
	const destinationObserved: Record<string, string> = {};
	for (const write of [
		...journal.resourceWrites,
		...journal.mappings.flatMap((m) => m.artifacts),
	]) {
		await assertTranslationTarget(
			write.path,
			await translationWriteRoot(
				journal,
				write,
				knowledgeRoot,
				allowLegacyKnowledge,
				resolveProjectGit,
				nativeFs
			),
			nativeFs
		);
		if (write.deleted) {
			try {
				await nativeFs.lstat(write.path);
				throw new Error('Deleted native resource reappeared before commit');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
				throw error;
			}
		}
		if (write.symlinkTarget && (await nativeFs.readlink(write.path)) !== write.symlinkTarget)
			throw new Error('Native discovery alias changed before commit');
		const bytes = await nativeFs.readFile(write.path);
		if (
			write.gitExcludeBlock
				? !bytes.includes(Buffer.from(write.gitExcludeBlock))
				: !write.sha256 || translationHash(bytes) !== write.sha256
		)
			throw new Error(`Destination readback changed: ${write.path}`);
		const mapping = journal.mappings.find((m) => m.artifacts.includes(write));
		if (mapping) {
			const readback = extractNativeConversation(
				journal.plan.destination,
				mapping.tabId,
				mapping.destinationSessionId!,
				bytes
			);
			for (const record of readback.records)
				destinationObserved[
					nativeRecordKey(journal.plan.destination, mapping.destinationSessionId!, record.nativeId)
				] = record.semanticHash;
		}
	}
	journal.destinationObserved = destinationObserved;
}

async function finalizeTranslation(
	archive: TranslationArchive,
	journal: TranslationJournal
): Promise<void> {
	if (!journal.destinationObserved)
		throw new Error('Staged native checkpoint is missing; recovery requires inspection');
	const checkpoint: TranslationCheckpoint = journal.checkpoint
		? structuredClone(journal.checkpoint)
		: {
				observed: {},
				lineage: {},
				conversations: [],
				resources: [],
				resourceBases: {},
				providerRoots: {},
			};
	checkpoint.operationId = journal.plan.id;
	checkpoint.resourceImport = journal.resourceImport;
	checkpoint.conversations = [
		...checkpoint.conversations.filter(
			(conversation) =>
				!journal.conversations.some((current) => current.tabId === conversation.tabId)
		),
		...journal.conversations,
	];
	checkpoint.resources = journal.resources;
	checkpoint.ownedResources ??= {};
	for (const write of journal.resourceWrites)
		if (write.deleted) delete checkpoint.ownedResources[write.path];
		else if (write.resourceKey && write.format)
			checkpoint.ownedResources[write.path] = {
				sha256: write.sha256,
				resourceKey: write.resourceKey,
				format: write.format,
			};
	for (const resource of journal.resources)
		checkpoint.resourceBases[resource.relativePath] = resource.sha256;
	checkpoint.providerRoots[journal.plan.source.provider] = journal.plan.source;
	checkpoint.providerRoots[journal.plan.destination.provider] = journal.plan.destination;
	for (const mapping of journal.mappings) Object.assign(checkpoint.lineage, mapping.lineage);
	// Recovery after commit must not accept later edits as the original imported baseline.
	Object.assign(checkpoint.observed, journal.destinationObserved);
	await archive.saveCheckpoint(journal.plan.agentId, checkpoint);
	journal.state = 'committed';
	journal.result = {
		success: true,
		state: 'committed',
		plan: journal.plan,
		mappings: journal.mappings,
	};
	await archive.write(journal);
}

/** Recovery never replays an uncertain RPC or overwrites a user's later native work. */
export async function recoverTranslation(
	archive: TranslationArchive,
	journal: TranslationJournal,
	host: TranslationTransactionHost,
	rollback = false
): Promise<TranslationResult> {
	const nativeFs = host.nativeFs ?? localTranslationFs;
	assertTabScope(journal);
	// A later switch may replace the host's active operation ID, but it does not undo this commit.
	if (rollback && journal.state === 'committed')
		throw new Error('Committed migration cannot be deleted; switch back through a new translation');
	await archive.recoverLock(journal.plan.agentId);
	await archive.recoverLock(`project:${journal.plan.destination.projectRoot}`);
	const release = await archive.lock(journal.plan.agentId);
	let releaseProject: (() => Promise<void>) | undefined;
	let releaseGit: (() => Promise<void>) | undefined;
	try {
		releaseProject = await archive.lock(`project:${journal.plan.destination.projectRoot}`);
		if (journal.resourceWrites.some((w) => w.gitExcludeBlock)) {
			const git = await host.resolveProjectGit?.(journal.plan.destination.projectRoot);
			if (!git) throw new Error('Cannot resolve journal git exclude directory');
			await archive.recoverLock(`git:${git.commonDirectory}`);
			releaseGit = await archive.lock(`git:${git.commonDirectory}`);
		}
		if (await host.isCommitted(journal.plan.id)) {
			if (rollback)
				throw new Error(
					'Committed migration cannot be deleted; switch back through a new translation'
				);
			// Native files may have legitimate new turns. The pre-commit hashes are no longer a rollback warrant.
			if (journal.state !== 'committed') await finalizeTranslation(archive, journal);
			await host.setMigration({
				operationId: journal.plan.id,
				tabId: journal.plan.tabId,
				destination: journal.plan.destination.provider,
				state: 'committed',
				verification: journal.plan.verification,
			});
			return journal.result!;
		}
		if (rollback) {
			const writes = [...journal.resourceWrites, ...journal.mappings.flatMap((m) => m.artifacts)];
			const excludeRollbacks = new Map<OwnedTranslationWrite, Buffer>();
			for (const write of writes) {
				if (
					write.backup &&
					translationHash(Buffer.from(write.backup.bytesBase64, 'base64')) !== write.backup.sha256
				)
					throw new Error('Rollback refused: backup hash mismatch');
				// Missing files still need root validation before a backup can be restored.
				await assertTranslationTarget(
					write.path,
					await translationWriteRoot(
						journal,
						write,
						host.knowledgeRoot,
						true,
						host.resolveProjectGit,
						nativeFs
					),
					nativeFs
				);
				// Codex owns the rollout/index pair. A lost import reply leaves its hash
				// unknown, but rollback never mutates retained artifacts, so no hash is needed.
				if (write.cleanup === 'retain') continue;
				if (write.gitExcludeBlock) {
					let bytes: Buffer;
					try {
						bytes = await nativeFs.readFile(write.path);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
						throw error;
					}
					if (!write.created && !write.backup)
						throw new Error('Rollback refused: git exclude creation ownership is unproved');
					if (write.created && !bytes.length) {
						excludeRollbacks.set(write, bytes);
						continue;
					}
					// Latin1 gives a reversible byte-to-character mapping for unrelated user data.
					const current = bytes.toString('latin1');
					const block = Buffer.from(write.gitExcludeBlock).toString('latin1');
					if (current.includes(block)) {
						excludeRollbacks.set(write, Buffer.from(current.replace(block, ''), 'latin1'));
						continue;
					}
					const begin = `# Maestro provider resources ${journal.plan.id} begin\n`;
					const end = `# Maestro provider resources ${journal.plan.id} end\n`;
					const start = current.indexOf(begin);
					const finish = current.indexOf(end, start + begin.length);
					if (start < 0 && finish < 0) continue;
					if (start < 0 || finish < 0)
						throw new Error('Rollback refused: git exclude markers changed');
					const owned = new Set(
						block
							.slice(block.indexOf(begin) + begin.length, block.indexOf(end))
							.split('\n')
							.filter(Boolean)
					);
					const retained = current
						.slice(start + begin.length, finish)
						.split('\n')
						.filter((line) => !owned.delete(line))
						.join('\n');
					let prefix = current.slice(0, start);
					if (!retained && block.startsWith('\n') && prefix.endsWith('\n'))
						prefix = prefix.slice(0, -1);
					excludeRollbacks.set(
						write,
						Buffer.from(prefix + retained + current.slice(finish + end.length), 'latin1')
					);
					continue;
				}
				try {
					await nativeFs.lstat(write.path);
					if (!write.created && !write.backup)
						throw new Error('Rollback refused: artifact creation ownership is unproved');
					if (write.symlinkTarget && (await nativeFs.readlink(write.path)) !== write.symlinkTarget)
						throw new Error('Rollback refused: native alias changed');
					const hash = translationHash(await nativeFs.readFile(write.path));
					if (
						(!write.created && !write.backup) ||
						!write.sha256 ||
						(hash !== write.sha256 && hash !== write.backup?.sha256)
					)
						throw new Error('Rollback refused: owned artifact changed or mutation is uncertain');
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
						if (write.backup && !write.deleted)
							throw new Error('Rollback refused: backed-up artifact was deleted after staging');
						continue;
					}
					throw error;
				}
			}
			for (const write of writes) {
				if (write.gitExcludeBlock) {
					const remaining = excludeRollbacks.get(write);
					if (!remaining) continue;
					if (!remaining.length && write.created) await nativeFs.unlink(write.path);
					else
						await nativeFs.atomicWrite(write.path, remaining, {
							mode: (await nativeFs.stat(write.path)).mode & 0o777,
							durable: true,
						});
					continue;
				}
				if (write.cleanup === 'retain' || (!write.created && !write.backup)) continue;
				if (write.backup)
					await nativeFs.atomicWrite(write.path, Buffer.from(write.backup.bytesBase64, 'base64'), {
						mode: write.backup.mode ?? 0o600,
					});
				else
					await nativeFs.unlink(write.path).catch((error) => {
						if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
					});
			}

			journal.state = 'rolled-back';
		} else {
			if (
				journal.state !== 'staged' &&
				journal.state !== 'committing' &&
				!(
					journal.state === 'failed' &&
					(journal.failurePhase === 'staged' || journal.failurePhase === 'committing')
				)
			)
				throw new Error(
					'Incomplete native staging requires inspection/rollback; uncertain writes are not retried'
				);
			await host.assertSourceUnchanged(journal);
			await verifyTranslationWrites(
				journal,
				host.knowledgeRoot,
				true,
				host.resolveProjectGit,
				nativeFs
			);
			await host.commit(journal);
			await finalizeTranslation(archive, journal);
		}
		journal.result = {
			success: true,
			state: journal.state,
			plan: journal.plan,
			mappings: journal.mappings,
		};
		await archive.write(journal);
		await host.setMigration({
			operationId: journal.plan.id,
			tabId: journal.plan.tabId,
			destination: journal.plan.destination.provider,
			state: journal.state,
			verification: journal.plan.verification,
		});
		return journal.result;
	} finally {
		await releaseGit?.();
		await releaseProject?.();
		await release();
	}
}
