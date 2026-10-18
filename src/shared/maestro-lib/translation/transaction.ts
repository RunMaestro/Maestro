import { atomicWriteFile } from '../storage/atomic-json-store';
import { assertTranslationTarget } from './resource-projections';
import { translationKnowledgePrompt } from './resources';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createKeyedWriteQueue } from '../../keyedWriteQueue';
import { canonicalJson } from '../../canonicalJson';
import { translationHash, nativeRecordKey } from './identity';
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

export interface TranslationTransactionHost {
	/** Called again before every mutation and commit, not just when planning. */
	assertSourceUnchanged(journal: TranslationJournal): Promise<void>;
	setMigration(state: ProviderMigrationState): Promise<void>;
	/** Must commit the agent provider, all tab mappings, and operation ID atomically. */
	commit(journal: TranslationJournal): Promise<void>;
	isCommitted(operationId: string): Promise<boolean>;
	codex?: TranslationRpc;
}

const operations = createKeyedWriteQueue();

/** An intent is not ownership: only a successful exclusive create permits rollback deletion. */
async function stageResourceWrite(
	archive: TranslationArchive,
	journal: TranslationJournal,
	write: OwnedTranslationWrite,
	bytes: Buffer
): Promise<void> {
	const owned = { ...write, created: false };
	journal.resourceWrites.push(owned);
	await archive.write(journal);
	await assertTranslationTarget(write.path, journal.plan.destination.projectRoot);
	await fs.mkdir(path.dirname(write.path), { recursive: true, mode: 0o700 });
	await assertTranslationTarget(write.path, journal.plan.destination.projectRoot);
	if (write.deleted) await fs.unlink(write.path);
	else if (write.symlinkTarget && write.created) {
		await fs.symlink(write.symlinkTarget, write.path);
		owned.created = true;
		await archive.write(journal);
	} else if (write.created) {
		const handle = await fs.open(write.path, 'wx', write.mode ?? 0o600);
		try {
			owned.created = true;
			await archive.write(journal);
			await handle.writeFile(bytes);
			await handle.sync();
		} finally {
			await handle.close();
		}
	} else await atomicWriteFile(write.path, bytes, { mode: write.mode ?? 0o600, durable: true });
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
		destination: plan.destination.provider,
		state: 'deferred',
		verification: plan.verification,
		acceptLimitations,
		selectedUserResources: plan.scope.selectedUserResources,
		acceptedLimitationCodes: plan.limitations.map(canonicalJson),
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
	return operations.enqueue(journal.plan.agentId, async () => {
		const plan = journal.plan;
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
		if (plan.status === 'blocked' || (!acceptLimitations && plan.limitations.length)) {
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
		try {
			releaseProject = await archive.lock(`project:${plan.destination.projectRoot}`);
			await host.assertSourceUnchanged(journal);
			journal.state = 'staging';
			await archive.write(journal);
			await archive.markLatest(plan.agentId, plan.id);
			await host.setMigration({
				operationId: plan.id,
				destination: plan.destination.provider,
				state: 'staging',
				verification: plan.verification,
			});
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
					recordIntent: async (mapping) => {
						journal.mappings = [
							...journal.mappings.filter((m) => m.tabId !== mapping.tabId),
							mapping,
						];
						await archive.write(journal);
					},
				});
			}
			for (const projection of journal.projections ?? []) {
				await host.assertSourceUnchanged(journal);
				await assertTranslationTarget(projection.path, plan.destination.projectRoot);
				let current: Buffer | undefined;
				try {
					current = await fs.readFile(projection.path);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				}
				if ((current ? translationHash(current) : null) !== projection.expectedHash)
					throw new Error('Native resource changed since preflight');
				await stageResourceWrite(
					archive,
					journal,
					projection,
					Buffer.from(projection.bytesBase64, 'base64')
				);
			}
			if (journal.plan.scope.projectKnowledge) {
				const directory = path.join(
					plan.destination.projectRoot,
					'.maestro',
					'provider-knowledge',
					translationHash(plan.agentId),
					plan.id
				);
				journal.knowledgeDirectory = directory;
				for (const artifact of journal.resources) {
					const relative = path.normalize(artifact.relativePath);
					if (
						path.isAbsolute(relative) ||
						relative === '..' ||
						relative.startsWith('..' + path.sep)
					)
						throw new Error('Unsafe resource projection path');
					const file = path.join(directory, relative);
					const bytes = Buffer.from(artifact.bytesBase64, 'base64');
					await stageResourceWrite(
						archive,
						journal,
						{ path: file, sha256: artifact.sha256, created: true, mode: artifact.mode },
						bytes
					);
				}
				const indexPath = path.join(directory, 'knowledge-index.md');
				const index = translationKnowledgePrompt(directory, journal.resources);
				await stageResourceWrite(
					archive,
					journal,
					{ path: indexPath, sha256: translationHash(index), created: true },
					Buffer.from(index)
				);
			}
			await verifyTranslationWrites(journal);
			journal.state = 'staged';
			await archive.write(journal);
			await host.assertSourceUnchanged(journal);
			journal.state = 'committing';
			await archive.write(journal);
			await host.commit(journal);
			await finalizeTranslation(archive, journal);
			await host.setMigration({
				operationId: plan.id,
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
				destination: plan.destination.provider,
				state: journal.state,
				verification: plan.verification,
				error: journal.error,
			});
			return journal.result;
		} finally {
			await releaseProject?.();
			await release();
		}
	});
}

export async function verifyTranslationWrites(journal: TranslationJournal): Promise<void> {
	if (journal.mappings.length !== journal.conversations.length)
		throw new Error('Incomplete all-tabs mapping');
	const destinationObserved: Record<string, string> = {};
	for (const write of [
		...journal.resourceWrites,
		...journal.mappings.flatMap((m) => m.artifacts),
	]) {
		await assertTranslationTarget(
			write.path,
			journal.resourceWrites.includes(write)
				? journal.plan.destination.projectRoot
				: (journal.plan.destination.nativeSessionRoot ?? journal.plan.destination.accountRoot)
		);
		if (write.deleted) {
			try {
				await fs.lstat(write.path);
				throw new Error('Deleted native resource reappeared before commit');
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
				throw error;
			}
		}
		if (write.symlinkTarget && (await fs.readlink(write.path)) !== write.symlinkTarget)
			throw new Error('Native discovery alias changed before commit');
		const bytes = await fs.readFile(write.path);
		if (!write.sha256 || translationHash(bytes) !== write.sha256)
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
	const checkpoint: TranslationCheckpoint = journal.checkpoint ?? {
		observed: {},
		lineage: {},
		conversations: [],
		resources: [],
		resourceBases: {},
		providerRoots: {},
	};
	checkpoint.conversations = journal.conversations;
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
	// A later switch may replace the host's active operation ID, but it does not undo this commit.
	if (rollback && journal.state === 'committed')
		throw new Error('Committed migration cannot be deleted; switch back through a new translation');
	await archive.recoverLock(journal.plan.agentId);
	await archive.recoverLock(`project:${journal.plan.destination.projectRoot}`);
	const release = await archive.lock(journal.plan.agentId);
	let releaseProject: (() => Promise<void>) | undefined;
	try {
		releaseProject = await archive.lock(`project:${journal.plan.destination.projectRoot}`);
		if (await host.isCommitted(journal.plan.id)) {
			if (rollback)
				throw new Error(
					'Committed migration cannot be deleted; switch back through a new translation'
				);
			// Native files may have legitimate new turns. The pre-commit hashes are no longer a rollback warrant.
			if (journal.state !== 'committed') await finalizeTranslation(archive, journal);
			await host.setMigration({
				operationId: journal.plan.id,
				destination: journal.plan.destination.provider,
				state: 'committed',
				verification: journal.plan.verification,
			});
			return journal.result!;
		}
		if (rollback) {
			const writes = [...journal.resourceWrites, ...journal.mappings.flatMap((m) => m.artifacts)];
			for (const write of writes) {
				if (
					write.backup &&
					translationHash(Buffer.from(write.backup.bytesBase64, 'base64')) !== write.backup.sha256
				)
					throw new Error('Rollback refused: backup hash mismatch');
				// Missing files still need root validation before a backup can be restored.
				await assertTranslationTarget(
					write.path,
					journal.resourceWrites.includes(write)
						? journal.plan.destination.projectRoot
						: (journal.plan.destination.nativeSessionRoot ?? journal.plan.destination.accountRoot)
				);
				try {
					await fs.lstat(write.path);
					if (!write.created && !write.backup)
						throw new Error('Rollback refused: artifact creation ownership is unproved');
					if (write.symlinkTarget && (await fs.readlink(write.path)) !== write.symlinkTarget)
						throw new Error('Rollback refused: native alias changed');
					const hash = translationHash(await fs.readFile(write.path));
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
				if (write.cleanup === 'retain' || (!write.created && !write.backup)) continue;
				if (write.backup)
					await atomicWriteFile(write.path, Buffer.from(write.backup.bytesBase64, 'base64'), {
						mode: write.backup.mode ?? 0o600,
					});
				else
					await fs.unlink(write.path).catch((error) => {
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
			await verifyTranslationWrites(journal);
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
			destination: journal.plan.destination.provider,
			state: journal.state,
			verification: journal.plan.verification,
		});
		return journal.result;
	} finally {
		await releaseProject?.();
		await release();
	}
}
