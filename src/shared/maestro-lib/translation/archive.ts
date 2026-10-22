import * as localArchiveFs from 'node:fs/promises';
import { localTranslationFs } from './local-fs';
import * as path from 'node:path';
import { canonicalJson } from '../../canonicalJson';
import { translationHash } from './identity';
import type {
	PortableConversation,
	TranslationArtifact,
	TranslationCheckpoint,
	TranslationPlan,
	TranslationResult,
	TranslationTabMapping,
	TranslationOperationState,
	ResourceProjection,
	OwnedTranslationWrite,
} from './types';

export interface TranslationJournal {
	schemaVersion: 1;
	plan: TranslationPlan;
	state: TranslationOperationState;
	conversations: PortableConversation[];
	resources: TranslationArtifact[];
	checkpoint?: TranslationCheckpoint;
	mappings: TranslationTabMapping[];
	resourceWrites: OwnedTranslationWrite[];
	projections?: ResourceProjection[];
	result?: TranslationResult;
	error?: string;
	failurePhase?: TranslationOperationState;
	/** App-local for new operations; legacy in-repo paths remain intact for recovery/rollback. */
	knowledgeDirectory?: string;
	/** Content-addressed resource lineage, independent of the selected conversation. */
	resourceImport?: { key: string; operationId: string };
	/** Native hashes captured at staged readback, never reconstructed from later destination work. */
	destinationObserved?: Record<string, string>;
}

/** Private local storage is chosen by the host, never the repository or synced session store. */
export class TranslationArchive {
	/** Fixed local port: nativeFs is never used for journals, checkpoints or archive bytes. */
	readonly archiveFs = localTranslationFs;
	constructor(readonly root: string) {}
	private agentDirectory(agentId: string): string {
		return path.join(this.root, translationHash(agentId));
	}
	operationPath(agentId: string, operationId: string): string {
		if (!/^[a-f0-9-]{36}$/i.test(operationId)) throw new Error('Unsafe translation operation ID');
		return path.join(this.agentDirectory(agentId), 'operations', operationId, 'journal.json');
	}
	async write(journal: TranslationJournal): Promise<void> {
		const file = this.operationPath(journal.plan.agentId, journal.plan.id);
		await this.archiveFs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		for (const artifact of [
			...journal.resources,
			...journal.conversations.flatMap((c) => c.artifacts),
			...(journal.projections ?? []).flatMap((p) => (p.backup ? [p.backup] : [])),
			...journal.resourceWrites.flatMap((w) => (w.backup ? [w.backup] : [])),
			...journal.mappings.flatMap((m) => m.artifacts.flatMap((w) => (w.backup ? [w.backup] : []))),
		]) {
			const bytes = Buffer.from(artifact.bytesBase64, 'base64');
			if (translationHash(bytes) !== artifact.sha256)
				throw new Error(`Archive hash mismatch: ${artifact.id}`);
			const artifactPath = path.join(path.dirname(file), `${artifact.sha256}.bytes`);
			try {
				await this.archiveFs.createExclusive(artifactPath, bytes, { mode: 0o600, durable: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			}
			if (translationHash(await this.archiveFs.readFile(artifactPath)) !== artifact.sha256)
				throw new Error('Corrupt archive artifact');
		}
		await this.archiveFs.atomicWrite(file, canonicalJson(journal), { mode: 0o600, durable: true });
	}
	async read(agentId: string, operationId: string): Promise<TranslationJournal> {
		const journal = JSON.parse(
			(await this.archiveFs.readFile(this.operationPath(agentId, operationId))).toString('utf8')
		) as TranslationJournal;
		if (
			journal.schemaVersion !== 1 ||
			journal.plan.agentId !== agentId ||
			journal.plan.id !== operationId
		)
			throw new Error('Translation journal identity mismatch');
		for (const artifact of [
			...journal.resources,
			...journal.conversations.flatMap((c) => c.artifacts),
			...(journal.projections ?? []).flatMap((p) => (p.backup ? [p.backup] : [])),
			...journal.resourceWrites.flatMap((w) => (w.backup ? [w.backup] : [])),
			...journal.mappings.flatMap((m) => m.artifacts.flatMap((w) => (w.backup ? [w.backup] : []))),
		]) {
			if (translationHash(Buffer.from(artifact.bytesBase64, 'base64')) !== artifact.sha256)
				throw new Error('Corrupt translation journal artifact');
		}
		return journal;
	}
	async checkpoint(agentId: string): Promise<TranslationCheckpoint | undefined> {
		try {
			return JSON.parse(
				(
					await this.archiveFs.readFile(path.join(this.agentDirectory(agentId), 'checkpoint.json'))
				).toString('utf8')
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
			throw error;
		}
	}
	async saveCheckpoint(agentId: string, checkpoint: TranslationCheckpoint): Promise<void> {
		const file = path.join(this.agentDirectory(agentId), 'checkpoint.json');
		await this.archiveFs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
		await this.archiveFs.atomicWrite(file, canonicalJson(checkpoint), {
			mode: 0o600,
			durable: true,
		});
	}
	async lastOperation(agentId: string): Promise<string | undefined> {
		try {
			return (await this.archiveFs.readFile(path.join(this.agentDirectory(agentId), 'latest')))
				.toString('utf8')
				.trim();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
			throw error;
		}
	}
	async markLatest(agentId: string, operationId: string): Promise<void> {
		await this.archiveFs.atomicWrite(
			path.join(this.agentDirectory(agentId), 'latest'),
			operationId,
			{
				mode: 0o600,
				durable: true,
			}
		);
	}
	/** Exclusive cross-process migration ownership. Stale ownership requires explicit recovery. */
	async lock(agentId: string): Promise<() => Promise<void>> {
		const directory = this.agentDirectory(agentId);
		await this.archiveFs.mkdir(directory, { recursive: true, mode: 0o700 });
		const file = path.join(directory, 'migration.lock');
		const handle = await localArchiveFs.open(file, 'wx', 0o600);
		await handle.writeFile(canonicalJson({ pid: process.pid }));
		return async () => {
			await handle.close();
			await this.archiveFs.unlink(file);
		};
	}
	async recoverLock(agentId: string): Promise<void> {
		const file = path.join(this.agentDirectory(agentId), 'migration.lock');
		try {
			const holder = JSON.parse((await this.archiveFs.readFile(file)).toString('utf8')) as {
				pid: number;
			};
			try {
				process.kill(holder.pid, 0);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
					await this.archiveFs.unlink(file);
					return;
				}
				throw error;
			}
			throw new Error('Migration is still owned by a live process');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
}
