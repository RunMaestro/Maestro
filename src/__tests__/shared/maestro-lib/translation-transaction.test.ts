// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	mkdtemp,
	readFile,
	readlink,
	rm,
	writeFile,
	mkdir,
	symlink,
	readdir,
} from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { canonicalJson } from '../../../shared/canonicalJson';
import {
	TranslationArchive,
	type TranslationJournal,
} from '../../../shared/maestro-lib/translation/archive';
import {
	applyTranslation,
	recoverTranslation,
} from '../../../shared/maestro-lib/translation/transaction';
import { createTranslationRegistry } from '../../../shared/maestro-lib/translation/adapters';
import { extractNativeConversation } from '../../../shared/maestro-lib/translation/native-records';
import { planTranslation } from '../../../shared/maestro-lib/translation/registry';
import { reconcileConversation } from '../../../shared/maestro-lib/translation/reconcile';
import {
	nativeRecordKey,
	translationArtifact,
	translationHash,
} from '../../../shared/maestro-lib/translation/identity';

afterEach(() => vi.restoreAllMocks());

async function scenario() {
	const root = await mkdtemp(path.join(os.tmpdir(), 'maestro-translation-'));
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
	const conversations = ['one', 'two'].map((tabId) =>
		extractNativeConversation(
			source,
			tabId,
			tabId,
			Buffer.from(
				JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'message',
						id: tabId,
						role: 'user',
						content: [{ type: 'input_text', text: 'synthetic' }],
					},
				})
			)
		)
	);
	const registry = createTranslationRegistry();
	const plan = planTranslation({
		agentId: 'agent',
		source,
		destination,
		scope: { projectKnowledge: true, selectedUserResources: [] },
		conversations,
		registry,
	});
	const journal: TranslationJournal = {
		schemaVersion: 1,
		plan,
		state: 'planned',
		conversations,
		resources: [],
		mappings: [],
		resourceWrites: [],
	};
	let committed = false;
	const host = {
		assertSourceUnchanged: vi.fn(async () => {}),
		setMigration: vi.fn(async () => {}),
		commit: vi.fn(async () => {
			committed = true;
		}),
		isCommitted: vi.fn(async () => committed),
	};
	return {
		root,
		journal,
		registry,
		host,
		archive: new TranslationArchive(path.join(root, 'private')),
	};
}

describe('all-tabs migration journal', () => {
	it('returns a committed apply retry without changing mappings or later native work', async () => {
		const s = await scenario();
		try {
			const committed = await applyTranslation(s.archive, s.registry, s.journal, s.host, true);
			const file = committed.mappings[0].artifacts[0].path;
			const later = (await readFile(file, 'utf8')) + '\nsynthetic later native work';
			await writeFile(file, later);
			const durable = await s.archive.read('agent', s.journal.plan.id);
			const stage = vi.spyOn(s.registry.get('claude-code')!, 'stage');
			s.host.assertSourceUnchanged.mockClear();
			s.host.setMigration.mockClear();
			expect(await applyTranslation(s.archive, s.registry, durable, s.host, true)).toEqual(
				committed
			);
			expect(stage).not.toHaveBeenCalled();
			expect(s.host.assertSourceUnchanged).not.toHaveBeenCalled();
			expect(s.host.setMigration).not.toHaveBeenCalled();
			expect(s.host.commit).toHaveBeenCalledTimes(1);
			expect(await readFile(file, 'utf8')).toBe(later);
			expect(await s.archive.read('agent', s.journal.plan.id)).toEqual(durable);
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it.each([
		'planned',
		'staging',
		'staged',
		'committing',
		'failed',
		'recovery-required',
		'rolled-back',
	] as const)('refuses to replay a %s operation with existing native artifacts', async (state) => {
		const s = await scenario();
		try {
			s.host.commit.mockRejectedValueOnce(new Error('synthetic commit failure'));
			await applyTranslation(s.archive, s.registry, s.journal, s.host, true);
			s.journal.state = state;
			await s.archive.write(s.journal);
			const durable = await s.archive.read('agent', s.journal.plan.id);
			const before = structuredClone(durable);
			const stage = vi.spyOn(s.registry.get('claude-code')!, 'stage');
			s.host.assertSourceUnchanged.mockClear();
			s.host.setMigration.mockClear();
			const result = await applyTranslation(s.archive, s.registry, durable, s.host, true);
			expect(result.state).toBe('refused');
			expect(result.error).toContain('requires recovery or rollback');
			expect(result.mappings).toEqual(before.mappings);
			expect(stage).not.toHaveBeenCalled();
			expect(s.host.assertSourceUnchanged).not.toHaveBeenCalled();
			expect(s.host.setMigration).not.toHaveBeenCalled();
			expect(s.host.commit).toHaveBeenCalledTimes(1);
			expect(await s.archive.read('agent', s.journal.plan.id)).toEqual(before);
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it('refuses rollback of a committed journal after a later switch replaces its active ID', async () => {
		const s = await scenario();
		try {
			await applyTranslation(s.archive, s.registry, s.journal, s.host, true);
			const writes = [
				...s.journal.resourceWrites,
				...s.journal.mappings.flatMap((mapping) => mapping.artifacts),
			];
			const before = await Promise.all(writes.map((write) => readFile(write.path)));
			s.host.isCommitted.mockResolvedValue(false);
			s.host.setMigration.mockClear();
			await expect(recoverTranslation(s.archive, s.journal, s.host, true)).rejects.toThrow(
				'Committed migration cannot be deleted'
			);
			expect(await Promise.all(writes.map((write) => readFile(write.path)))).toEqual(before);
			expect(s.host.setMigration).not.toHaveBeenCalled();
			expect((await s.archive.read('agent', s.journal.plan.id)).state).toBe('committed');
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it('refuses unverified apply unless its actual limitations were accepted', async () => {
		const s = await scenario();
		try {
			expect((await applyTranslation(s.archive, s.registry, s.journal, s.host)).state).toBe(
				'refused'
			);
			expect(s.host.commit).not.toHaveBeenCalled();
			expect((await s.archive.read('agent', s.journal.plan.id)).result?.state).toBe('refused');
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it('persists accepted busy deferral before creating any native sessions', async () => {
		const s = await scenario();
		try {
			s.journal.plan.status = 'deferred';
			expect((await applyTranslation(s.archive, s.registry, s.journal, s.host, true)).state).toBe(
				'deferred'
			);
			expect(s.journal.mappings).toHaveLength(0);
			expect(s.host.setMigration).toHaveBeenCalledWith(
				expect.objectContaining({
					state: 'deferred',
					acceptLimitations: true,
					acceptedLimitationCodes: s.journal.plan.limitations.map(canonicalJson),
				})
			);
			expect(s.host.commit).not.toHaveBeenCalled();
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it('stages and reads back every tab before committing one mapping update', async () => {
		const s = await scenario();
		try {
			const result = await applyTranslation(s.archive, s.registry, s.journal, s.host, true);
			expect(result.state).toBe('committed');
			expect(result.mappings).toHaveLength(2);
			expect(s.host.commit).toHaveBeenCalledTimes(1);
			expect((await s.archive.read('agent', result.plan.id)).state).toBe('committed');
			expect((await s.archive.read('agent', result.plan.id)).destinationObserved).toEqual(
				s.journal.destinationObserved
			);
			expect((await s.archive.read('agent', result.plan.id)).resourceWrites).toContainEqual(
				expect.objectContaining({
					created: true,
					path: expect.stringContaining('knowledge-index.md'),
				})
			);
			expect((await s.archive.checkpoint('agent'))?.lineage).toBeDefined();
			expect(s.host.setMigration).toHaveBeenLastCalledWith(
				expect.objectContaining({ state: 'committed' })
			);
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it('keeps the source active on partial failure and refuses deletion of later work', async () => {
		const s = await scenario();
		try {
			s.host.assertSourceUnchanged
				.mockImplementationOnce(async () => {})
				.mockImplementationOnce(async () => {})
				.mockImplementationOnce(async () => {
					throw new Error('late source event');
				});
			const result = await applyTranslation(s.archive, s.registry, s.journal, s.host, true);
			expect(result.state).toBe('failed');
			expect(s.host.commit).not.toHaveBeenCalled();
			const file = result.mappings[0].artifacts[0].path;
			await writeFile(file, (await readFile(file)) + '\nnew native work');
			await expect(recoverTranslation(s.archive, s.journal, s.host, true)).rejects.toThrow(
				'Rollback refused'
			);
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it('recovers a fully staged operation whose mapping commit failed without rewriting native files', async () => {
		const s = await scenario();
		try {
			s.host.commit.mockRejectedValueOnce(new Error('store unavailable'));
			const result = await applyTranslation(s.archive, s.registry, s.journal, s.host, true);
			expect(result.state).toBe('failed');
			expect(s.journal.failurePhase).toBe('committing');
			const ids = result.mappings.map((m) => m.destinationSessionId);
			const recovered = await recoverTranslation(s.archive, s.journal, s.host);
			expect(recovered.state).toBe('committed');
			expect(recovered.mappings.map((m) => m.destinationSessionId)).toEqual(ids);
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});

	it('recovers after mapping commit without replaying the destination writer', async () => {
		const s = await scenario();
		try {
			await applyTranslation(s.archive, s.registry, s.journal, s.host, true);
			s.journal.state = 'committing';
			const result = await recoverTranslation(s.archive, s.journal, s.host);
			expect(result.state).toBe('committed');
			expect(s.host.commit).toHaveBeenCalledTimes(1);
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it('retains the staged checkpoint across a commit crash and later native edits and turns', async () => {
		const s = await scenario();
		try {
			vi.spyOn(s.archive, 'saveCheckpoint').mockRejectedValueOnce(new Error('disk unavailable'));
			expect((await applyTranslation(s.archive, s.registry, s.journal, s.host, true)).state).toBe(
				'recovery-required'
			);
			const mapping = s.journal.mappings[0];
			const file = mapping.artifacts[0].path;
			const row = JSON.parse((await readFile(file, 'utf8')).trim());
			const originalKey = nativeRecordKey(
				s.journal.plan.destination,
				mapping.destinationSessionId!,
				row.uuid
			);
			const originalHash = s.journal.destinationObserved![originalKey];
			row.message.content[0].text = 'later edit';
			const newRow = {
				...row,
				uuid: 'later-turn',
				parentUuid: row.uuid,
				message: { role: 'user', content: [{ type: 'text', text: 'later turn' }] },
			};
			await writeFile(file, `${JSON.stringify(row)}\n${JSON.stringify(newRow)}\n`);
			const durable = await s.archive.read('agent', s.journal.plan.id);
			expect((await recoverTranslation(s.archive, durable, s.host)).state).toBe('committed');
			const checkpoint = (await s.archive.checkpoint('agent'))!;
			expect(checkpoint.observed[originalKey]).toBe(originalHash);
			expect(
				checkpoint.observed[
					nativeRecordKey(s.journal.plan.destination, mapping.destinationSessionId!, 'later-turn')
				]
			).toBeUndefined();
			const incoming = extractNativeConversation(
				s.journal.plan.destination,
				mapping.tabId,
				mapping.destinationSessionId!,
				await readFile(file)
			);
			const delta = reconcileConversation(incoming, checkpoint);
			expect(delta.limitations).toContainEqual(
				expect.objectContaining({ code: 'edited-native-record', severity: 'block' })
			);
			expect(delta.newRecords).toBe(1);
			expect(s.host.commit).toHaveBeenCalledTimes(1);
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it('refuses committed recovery without a staged checkpoint instead of accepting current native bytes', async () => {
		const s = await scenario();
		try {
			await applyTranslation(s.archive, s.registry, s.journal, s.host, true);
			s.journal.state = 'committing';
			delete s.journal.destinationObserved;
			await expect(recoverTranslation(s.archive, s.journal, s.host)).rejects.toThrow(
				'Staged native checkpoint is missing'
			);
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it('refuses a Claude transcript parent symlink before writing outside the selected account', async () => {
		const s = await scenario();
		try {
			const external = path.join(s.root, 'external');
			await mkdir(external);
			await mkdir(s.journal.plan.destination.accountRoot);
			await symlink(external, path.join(s.journal.plan.destination.accountRoot, 'projects'), 'dir');
			const result = await applyTranslation(s.archive, s.registry, s.journal, s.host, true);
			expect(result.state).toBe('failed');
			expect(result.error).toContain('symlink');
			expect(s.host.commit).not.toHaveBeenCalled();
			expect(await readdir(external)).toEqual([]);
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it.each(['native projection', 'managed resource', 'knowledge index'] as const)(
		'refuses rollback ownership of a colliding %s even when its bytes match',
		async (kind) => {
			const s = await scenario();
			try {
				const directory = path.join(
					s.journal.plan.destination.projectRoot,
					'.maestro',
					'provider-knowledge',
					translationHash(s.journal.plan.agentId),
					s.journal.plan.id
				);
				const bytes = Buffer.from(kind === 'knowledge index' ? '' : 'selected synthetic knowledge');
				const file =
					kind === 'native projection'
						? path.join(s.journal.plan.destination.projectRoot, 'CLAUDE.md')
						: path.join(
								directory,
								kind === 'managed resource' ? 'memory/MEMORY.md' : 'knowledge-index.md'
							);
				if (kind === 'native projection')
					s.journal.projections = [
						{
							path: file,
							sha256: translationHash(bytes),
							created: true,
							expectedHash: null,
							bytesBase64: bytes.toString('base64'),
						},
					];
				if (kind === 'managed resource')
					s.journal.resources = [
						translationArtifact('memory', 'synthetic', 'memory/MEMORY.md', bytes),
					];
				const persist = s.archive.write.bind(s.archive);
				let collided = false;
				vi.spyOn(s.archive, 'write').mockImplementation(async (journal) => {
					await persist(journal);
					// Another writer creates the same bytes after intent, before exclusive creation.
					if (!collided && journal.resourceWrites.some((write) => write.path === file)) {
						collided = true;
						await mkdir(path.dirname(file), { recursive: true });
						await writeFile(file, bytes, { flag: 'wx' });
					}
				});
				const result = await applyTranslation(s.archive, s.registry, s.journal, s.host, true);
				expect(result.state).toBe('failed');
				expect(s.host.commit).not.toHaveBeenCalled();
				const durable = await s.archive.read('agent', s.journal.plan.id);
				expect(durable.resourceWrites.find((write) => write.path === file)?.created).toBe(false);
				await expect(recoverTranslation(s.archive, durable, s.host, true)).rejects.toThrow(
					'Rollback refused'
				);
				expect(await readFile(file)).toEqual(bytes);
			} finally {
				await rm(s.root, { recursive: true, force: true });
			}
		}
	);
	it('retains a dangling symlink when exclusive creation never established ownership', async () => {
		const s = await scenario();
		try {
			const file = path.join(s.journal.plan.destination.projectRoot, 'CLAUDE.md');
			await mkdir(path.dirname(file), { recursive: true });
			await symlink('missing-user-instructions.md', file);
			s.journal.resourceWrites.push({ path: file, sha256: translationHash(''), created: false });
			await expect(recoverTranslation(s.archive, s.journal, s.host, true)).rejects.toThrow(
				'creation ownership is unproved'
			);
			expect(await readlink(file)).toBe('missing-user-instructions.md');
			expect(s.host.commit).not.toHaveBeenCalled();
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it('restores a journaled deletion from its backup inside the selected project', async () => {
		const s = await scenario();
		try {
			const file = path.join(s.journal.plan.destination.projectRoot, 'CLAUDE.md');
			await mkdir(path.dirname(file), { recursive: true });
			const bytes = Buffer.from('original synthetic instructions');
			s.journal.resourceWrites.push({
				path: file,
				sha256: translationHash(''),
				created: false,
				deleted: true,
				backup: translationArtifact('instruction', file, 'CLAUDE.md', bytes),
			});
			expect((await recoverTranslation(s.archive, s.journal, s.host, true)).state).toBe(
				'rolled-back'
			);
			expect(await readFile(file)).toEqual(bytes);
			expect(s.host.commit).not.toHaveBeenCalled();
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it('refuses to restore a backed-up projection deleted after staging', async () => {
		const s = await scenario();
		try {
			const file = path.join(s.journal.plan.destination.projectRoot, 'CLAUDE.md');
			await mkdir(path.dirname(file), { recursive: true });
			const bytes = Buffer.from('original synthetic instructions');
			await writeFile(file, 'staged synthetic instructions');
			s.journal.resourceWrites.push({
				path: file,
				sha256: translationHash('staged synthetic instructions'),
				created: false,
				backup: translationArtifact('instruction', file, 'CLAUDE.md', bytes),
			});
			await rm(file);
			await expect(recoverTranslation(s.archive, s.journal, s.host, true)).rejects.toThrow(
				'deleted after staging'
			);
			await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
			expect(s.host.setMigration).not.toHaveBeenCalled();
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it('refuses backup restoration through a replaced parent even when the deleted file is absent', async () => {
		const s = await scenario();
		try {
			const directory = path.join(s.journal.plan.destination.projectRoot, '.claude');
			const file = path.join(directory, 'skills', 'synthetic', 'SKILL.md');
			const external = path.join(s.root, 'external');
			await mkdir(path.dirname(file), { recursive: true });
			await mkdir(path.join(external, 'skills', 'synthetic'), { recursive: true });
			const bytes = Buffer.from('original synthetic skill');
			s.journal.resourceWrites.push({
				path: file,
				sha256: translationHash(''),
				created: false,
				deleted: true,
				backup: translationArtifact('skill', file, '.claude/skills/synthetic/SKILL.md', bytes),
			});
			await rm(directory, { recursive: true });
			await symlink(external, directory, 'dir');
			await expect(recoverTranslation(s.archive, s.journal, s.host, true)).rejects.toThrow(
				'symlink'
			);
			expect(await readdir(path.join(external, 'skills', 'synthetic'))).toEqual([]);
			expect(s.host.setMigration).not.toHaveBeenCalled();
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it.each(['projection', 'resource-write', 'native-mapping'] as const)(
		'archives and validates %s backups on write and reload',
		async (location) => {
			const s = await scenario();
			try {
				const file = path.join(s.journal.plan.destination.projectRoot, 'CLAUDE.md');
				const bytes = Buffer.from('original synthetic backup');
				const backup = translationArtifact('instruction', file, 'CLAUDE.md', bytes);
				const write = {
					path: file,
					sha256: translationHash('staged synthetic instructions'),
					created: false,
					backup,
					bytesBase64: Buffer.from('staged synthetic instructions').toString('base64'),
					expectedHash: backup.sha256,
				};
				if (location === 'projection') s.journal.projections = [write];
				else if (location === 'resource-write') s.journal.resourceWrites.push(write);
				else
					s.journal.mappings.push({
						tabId: 'one',
						sourceSessionId: 'one',
						destinationSessionId: 'staged-one',
						artifacts: [write],
						lineage: {},
					});
				await s.archive.write(s.journal);
				const journalPath = s.archive.operationPath('agent', s.journal.plan.id);
				expect(
					await readFile(path.join(path.dirname(journalPath), `${backup.sha256}.bytes`))
				).toEqual(bytes);
				expect(await s.archive.read('agent', s.journal.plan.id)).toEqual(s.journal);
				const durable = await readFile(journalPath);
				backup.bytesBase64 = Buffer.from('corrupt backup').toString('base64');
				await expect(s.archive.write(s.journal)).rejects.toThrow('Archive hash mismatch');
				expect(await readFile(journalPath)).toEqual(durable);
				// Simulate journal corruption while its separate original-byte archive remains intact.
				await writeFile(journalPath, canonicalJson(s.journal));
				await expect(s.archive.read('agent', s.journal.plan.id)).rejects.toThrow(
					'Corrupt translation journal artifact'
				);
			} finally {
				await rm(s.root, { recursive: true, force: true });
			}
		}
	);
	it.each([false, true])(
		'refuses corrupt backups before any rollback mutation (deleted: %s)',
		async (deleted) => {
			const s = await scenario();
			try {
				const project = s.journal.plan.destination.projectRoot;
				await mkdir(project, { recursive: true });
				const first = path.join(project, 'first.md');
				const second = path.join(project, 'second.md');
				const staged = Buffer.from('staged synthetic instructions');
				await writeFile(first, staged);
				if (!deleted) await writeFile(second, staged);
				const original = Buffer.from('original synthetic instructions');
				const backup = translationArtifact('instruction', second, 'second.md', original);
				backup.bytesBase64 = Buffer.from('corrupt backup').toString('base64');
				s.journal.resourceWrites = [
					{
						path: first,
						sha256: translationHash(staged),
						created: false,
						backup: translationArtifact('instruction', first, 'first.md', original),
					},
					{ path: second, sha256: translationHash(staged), created: false, deleted, backup },
				];
				await expect(recoverTranslation(s.archive, s.journal, s.host, true)).rejects.toThrow(
					'backup hash mismatch'
				);
				expect(await readFile(first)).toEqual(staged);
				if (deleted) await expect(readFile(second)).rejects.toMatchObject({ code: 'ENOENT' });
				else expect(await readFile(second)).toEqual(staged);
				expect(s.host.commit).not.toHaveBeenCalled();
				expect(s.host.setMigration).not.toHaveBeenCalled();
			} finally {
				await rm(s.root, { recursive: true, force: true });
			}
		}
	);
	it('rejects unsafe archive IDs and corrupt bytes before journaling', async () => {
		const s = await scenario();
		try {
			expect(() => s.archive.operationPath('agent', '../unsafe')).toThrow('Unsafe');
			s.journal.conversations[0].artifacts[0].bytesBase64 =
				Buffer.from('corrupt').toString('base64');
			await expect(s.archive.write(s.journal)).rejects.toThrow('hash mismatch');
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
});
