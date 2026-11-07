// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	mkdtemp,
	readFile,
	readlink,
	rename,
	rm,
	writeFile,
	mkdir,
	symlink,
	readdir,
	realpath,
} from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { remapTranslationFs } from '../../helpers/translationFs';
import { canonicalJson } from '../../../shared/canonicalJson';
import { limitationsNeedingAcceptance } from '../../../shared/maestro-lib/translation/limitations';
import {
	TranslationArchive,
	type TranslationJournal,
} from '../../../shared/maestro-lib/translation/archive';
import {
	applyTranslation,
	applyTabTranslation,
	recoverTranslation,
} from '../../../shared/maestro-lib/translation/transaction';
import { createTranslationRegistry } from '../../../shared/maestro-lib/translation/adapters';
import { extractNativeConversation } from '../../../shared/maestro-lib/translation/native-records';
import {
	planTranslation,
	planTabTranslation,
} from '../../../shared/maestro-lib/translation/registry';
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
		knowledgeRoot: path.join(root, 'data', 'provider-knowledge'),
		resolveProjectGit: vi.fn(
			async (): Promise<{ root: string; commonDirectory: string } | undefined> => undefined
		),
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
	it.each(['unknown', 'changed'] as const)(
		'rolls back owned files while preserving a retained native artifact with a %s hash',
		async (hashState) => {
			const s = await scenario();
			try {
				s.host.commit.mockRejectedValueOnce(new Error('commit interrupted'));
				expect((await applyTranslation(s.archive, s.registry, s.journal, s.host, true)).state).toBe(
					'failed'
				);
				const durable = await s.archive.read('agent', s.journal.plan.id);
				const retained = durable.mappings[0].artifacts[0];
				retained.cleanup = 'retain';
				if (hashState === 'unknown') retained.sha256 = '';
				await writeFile(retained.path, 'provider-owned content after interruption');
				await s.archive.write(durable);
				expect((await recoverTranslation(s.archive, durable, s.host, true)).state).toBe(
					'rolled-back'
				);
				expect(await readFile(retained.path, 'utf8')).toBe(
					'provider-owned content after interruption'
				);
				await expect(readFile(durable.mappings[1].artifacts[0].path)).rejects.toMatchObject({
					code: 'ENOENT',
				});
			} finally {
				await rm(s.root, { recursive: true, force: true });
			}
		}
	);
	it.each(['commit', 'recover', 'rollback'] as const)(
		'keeps the archive local and native writes on the injected port during %s',
		async (action) => {
			const s = await scenario();
			try {
				const virtualRoot = path.join(s.root, 'virtual');
				const backingRoot = path.join(await realpath(s.root), 'backing');
				const { nativeFs } = remapTranslationFs(virtualRoot, backingRoot);
				s.journal.plan.destination.accountRoot = path.join(virtualRoot, 'claude');
				s.journal.plan.destination.projectRoot = path.join(virtualRoot, 'project');
				s.host.knowledgeRoot = path.join(virtualRoot, 'knowledge');
				const host = { ...s.host, nativeFs };
				const file = path.join(virtualRoot, 'project/.claude/skills/example/SKILL.md');
				await nativeFs.mkdir(path.dirname(file), { recursive: true });
				await nativeFs.mkdir(host.knowledgeRoot, { recursive: true });
				await nativeFs.createExclusive(file, 'original');
				s.journal.plan.scope.projectResourcesIntoRepo = true;
				s.journal.projections = [
					{
						path: file,
						sha256: translationHash('incoming'),
						created: false,
						expectedHash: translationHash('original'),
						bytesBase64: Buffer.from('incoming').toString('base64'),
						resourceKey: '.claude/skills/example/SKILL.md',
						format: 'markdown',
						backup: translationArtifact(
							'skill',
							file,
							'.claude/skills/example/SKILL.md',
							Buffer.from('original')
						),
					},
				];
				s.journal.resources = [
					translationArtifact(
						'memory',
						'synthetic',
						'memory/MEMORY.md',
						Buffer.from('Remember exactly this.\r\n')
					),
				];
				if (action !== 'commit') host.commit.mockRejectedValueOnce(new Error('commit interrupted'));
				const result = await applyTranslation(s.archive, s.registry, s.journal, host, true);
				expect(result.state).toBe(action === 'commit' ? 'committed' : 'failed');
				const journal = await s.archive.read(s.journal.plan.agentId, s.journal.plan.id);
				expect(journal.mappings).toHaveLength(2);
				expect(journal.resourceWrites.length).toBeGreaterThan(1);
				expect(await nativeFs.readFile(file)).toEqual(Buffer.from('incoming'));
				await expect(
					readFile(s.archive.operationPath(journal.plan.agentId, journal.plan.id))
				).resolves.toBeInstanceOf(Buffer);
				await expect(readFile(journal.mappings[0].artifacts[0].path)).rejects.toMatchObject({
					code: 'ENOENT',
				});
				if (action !== 'commit') {
					const recovered = await recoverTranslation(
						s.archive,
						journal,
						host,
						action === 'rollback'
					);
					expect(recovered.state).toBe(action === 'rollback' ? 'rolled-back' : 'committed');
				}
				if (action === 'rollback') {
					expect(await nativeFs.readFile(file)).toEqual(Buffer.from('original'));
					expect(await nativeFs.exists(journal.mappings[0].artifacts[0].path)).toBe(false);
					expect(nativeFs.unlink).toHaveBeenCalledWith(journal.mappings[0].artifacts[0].path);
				} else {
					expect(
						await nativeFs.readFile(path.join(journal.knowledgeDirectory!, 'memory/MEMORY.md'))
					).toEqual(Buffer.from('Remember exactly this.\r\n'));
				}
				expect(nativeFs.atomicWrite).toHaveBeenCalled();
				expect(nativeFs.realpath).toHaveBeenCalled();
			} finally {
				await rm(s.root, { recursive: true, force: true });
			}
		}
	);
	it('journals a native transport failure locally and never retries through local fs', async () => {
		const s = await scenario();
		try {
			const { nativeFs } = remapTranslationFs(
				path.join(s.root, 'virtual'),
				path.join(s.root, 'backing')
			);
			nativeFs.lstat.mockRejectedValue(
				Object.assign(new Error('transport disconnected'), { code: 'ECONNRESET' })
			);
			const result = await applyTranslation(
				s.archive,
				s.registry,
				s.journal,
				{ ...s.host, nativeFs },
				true
			);
			expect(result).toMatchObject({ state: 'failed', error: 'transport disconnected' });
			expect(nativeFs.createExclusive).not.toHaveBeenCalled();
			expect((await s.archive.read(s.journal.plan.agentId, s.journal.plan.id)).error).toBe(
				'transport disconnected'
			);
			expect(s.host.commit).not.toHaveBeenCalled();
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it.each([false, true])(
		'retains deferred checkpoints and resources across sequential scopes (agent-wide: %s)',
		async (agentWide) => {
			const s = await scenario();
			try {
				const conversations = s.journal.conversations;
				const resources = [
					translationArtifact(
						'memory',
						'synthetic',
						'memory/MEMORY.md',
						Buffer.from('Remember exactly this')
					),
				];
				const stage = vi.spyOn(s.registry.get('claude-code')!, 'stage');
				for (const conversation of conversations) {
					const checkpoint = await s.archive.checkpoint('agent');
					const plan = planTabTranslation({
						...s.journal.plan,
						tabId: conversation.tabId,
						conversations,
						registry: s.registry,
						resources,
					});
					if (agentWide) {
						delete plan.tabId;
						plan.deferredTabs = conversations
							.filter((c) => c.tabId !== conversation.tabId)
							.map((c) => ({ id: c.tabId, agentSessionId: c.nativeSessionId }));
					}
					s.journal = {
						schemaVersion: 1,
						plan,
						state: 'planned',
						conversations: [conversation],
						resources,
						checkpoint,
						mappings: [],
						resourceWrites: [],
					};
					const result = await (agentWide ? applyTranslation : applyTabTranslation)(
						s.archive,
						s.registry,
						s.journal,
						s.host,
						true
					);
					expect(result.state).toBe('committed');
					expect(result.mappings.map((mapping) => mapping.tabId)).toEqual([conversation.tabId]);
					if (checkpoint) {
						expect(s.journal.resourceWrites).toEqual([]);
						expect(s.journal.resourceImport).toEqual(checkpoint.resourceImport);
						const merged = (await s.archive.checkpoint('agent'))!;
						expect(merged.conversations.map((c) => c.tabId)).toEqual(['one', 'two']);
						expect(merged.lineage).toMatchObject(checkpoint.lineage);
						const imported = extractNativeConversation(
							plan.destination,
							conversation.tabId,
							s.journal.mappings[0].destinationSessionId!,
							await readFile(s.journal.mappings[0].artifacts[0].path)
						);
						// Native lineage identities, not repeated text, prevent re-imported records.
						expect(reconcileConversation(imported, merged).newRecords).toBe(0);
					} else expect(s.journal.resourceWrites).toHaveLength(2);
				}
				expect(stage).toHaveBeenCalledTimes(2);
				expect(
					await readdir(path.join(s.host.knowledgeRoot, translationHash('agent')))
				).toHaveLength(1);
			} finally {
				await rm(s.root, { recursive: true, force: true });
			}
		}
	);
	it('recovers a single-tab commit without restaging and refuses committed rollback', async () => {
		const s = await scenario();
		try {
			s.journal.plan = planTabTranslation({
				...s.journal.plan,
				tabId: 'one',
				conversations: s.journal.conversations,
				registry: s.registry,
			});
			s.journal.conversations = s.journal.conversations.filter((c) => c.tabId === 'one');
			vi.spyOn(s.archive, 'saveCheckpoint').mockRejectedValueOnce(
				new Error('crash after host commit')
			);
			const stage = vi.spyOn(s.registry.get('claude-code')!, 'stage');
			expect(
				(await applyTabTranslation(s.archive, s.registry, s.journal, s.host, true)).state
			).toBe('recovery-required');
			const recovered = await recoverTranslation(
				s.archive,
				await s.archive.read('agent', s.journal.plan.id),
				s.host
			);
			expect(recovered.state).toBe('committed');
			expect(recovered.mappings.map((m) => m.tabId)).toEqual(['one']);
			expect(stage).toHaveBeenCalledTimes(1);
			await expect(recoverTranslation(s.archive, s.journal, s.host, true)).rejects.toThrow(
				'Committed migration'
			);
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it('refuses a scoped journal containing an unrelated conversation before mutation', async () => {
		const s = await scenario();
		try {
			s.journal.plan = planTabTranslation({
				...s.journal.plan,
				tabId: 'one',
				conversations: s.journal.conversations,
				registry: s.registry,
			});
			await expect(
				applyTabTranslation(s.archive, s.registry, s.journal, s.host, true)
			).rejects.toThrow('unrelated conversation');
			expect(s.host.commit).not.toHaveBeenCalled();
			expect(s.host.setMigration).not.toHaveBeenCalled();
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it('rejects stale tab plans and rolls back a failed tab without deleting shared memory', async () => {
		const s = await scenario();
		try {
			s.journal.resources = [
				translationArtifact(
					'memory',
					'synthetic',
					'memory/MEMORY.md',
					Buffer.from('Shared memory survives rollback')
				),
			];
			const all = s.journal.conversations;
			const makePlan = (tabId: string) =>
				planTabTranslation({ ...s.journal.plan, tabId, conversations: all, registry: s.registry });
			const stale: TranslationJournal = {
				...structuredClone(s.journal),
				plan: makePlan('two'),
				conversations: [all[1]],
			};
			s.journal.plan = makePlan('one');
			s.journal.conversations = [all[0]];
			expect(
				(await applyTabTranslation(s.archive, s.registry, s.journal, s.host, true)).state
			).toBe('committed');
			const first = await s.archive.checkpoint('agent');
			s.host.setMigration.mockClear();
			expect((await applyTabTranslation(s.archive, s.registry, stale, s.host, true)).state).toBe(
				'refused'
			);
			expect(s.host.setMigration).not.toHaveBeenCalled();
			expect(await s.archive.checkpoint('agent')).toEqual(first);
			stale.checkpoint = first;
			s.host.commit.mockRejectedValueOnce(new Error('stop before commit'));
			s.host.isCommitted.mockImplementation(async (id?: string) => id === s.journal.plan.id);
			expect((await applyTabTranslation(s.archive, s.registry, stale, s.host, true)).state).toBe(
				'failed'
			);
			expect(stale.resourceWrites).toEqual([]);
			const rolledBack = await recoverTranslation(
				s.archive,
				await s.archive.read('agent', stale.plan.id),
				s.host,
				true
			);
			expect(rolledBack.state).toBe('rolled-back');
			expect(
				await readFile(path.join(s.journal.knowledgeDirectory!, 'memory/MEMORY.md'), 'utf8')
			).toBe('Shared memory survives rollback');
			await expect(readFile(stale.mappings[0].artifacts[0].path)).rejects.toMatchObject({
				code: 'ENOENT',
			});
			expect(await readFile(s.journal.mappings[0].artifacts[0].path, 'utf8')).toContain(
				'synthetic'
			);
			expect(await s.archive.checkpoint('agent')).toEqual(first);
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it('ignores another tab block but retains agent-wide limitations in a scoped plan', async () => {
		const s = await scenario();
		try {
			const options = {
				...s.journal.plan,
				tabId: 'one',
				conversations: s.journal.conversations,
				registry: s.registry,
			};
			expect(
				planTabTranslation({
					...options,
					limitations: [
						{ code: 'blocked-tab', tabId: 'two', severity: 'block', message: 'Unrelated' },
					],
				}).status
			).toBe('ready');
			expect(
				planTabTranslation({
					...options,
					limitations: [
						{ code: 'blocked-resource', severity: 'block', message: 'Shared resource conflict' },
					],
				}).status
			).toBe('blocked');
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it.each([false, true])('writes native files only with opt-in (enabled: %s)', async (enabled) => {
		const s = await scenario();
		try {
			const file = path.join(
				s.journal.plan.destination.projectRoot,
				'.claude/skills/test/SKILL.md'
			);
			const bytes = Buffer.from('Synthetic skill');
			s.journal.projections = [
				{
					path: file,
					sha256: translationHash(bytes),
					created: true,
					expectedHash: null,
					bytesBase64: bytes.toString('base64'),
				},
			];
			s.journal.plan.scope.projectResourcesIntoRepo = enabled;
			const result = await applyTranslation(s.archive, s.registry, s.journal, s.host, true);
			expect(result.state).toBe('committed');
			if (enabled) {
				expect(await readFile(file, 'utf8')).toBe('Synthetic skill');
				expect(result.plan.limitations).toContainEqual(
					expect.objectContaining({ code: 'resource-git-exclude-unavailable', severity: 'info' })
				);
			} else
				await expect(readdir(s.journal.plan.destination.projectRoot)).rejects.toMatchObject({
					code: 'ENOENT',
				});
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it.each([
		{ existing: false, inside: false },
		{ existing: true, inside: false },
		{ existing: true, inside: true },
	])(
		'journals and rolls back only its git exclude lines ($existing, $inside)',
		async ({ existing, inside }) => {
			const s = await scenario();
			try {
				const project = s.journal.plan.destination.projectRoot;
				const repo = path.dirname(project);
				const commonDirectory = path.join(s.root, 'git-common');
				const file = path.join(project, '.claude/skills/test [one]/SKILL.md');
				const bytes = Buffer.from('Synthetic skill');
				const exclude = path.join(commonDirectory, 'info/exclude');
				await mkdir(path.dirname(exclude), { recursive: true });
				const original = existing ? '# User rules\n/user-cache' : '';
				if (existing) await writeFile(exclude, original);
				s.journal.projections = [
					{
						path: file,
						sha256: translationHash(bytes),
						created: true,
						expectedHash: null,
						bytesBase64: bytes.toString('base64'),
					},
				];
				s.journal.plan.scope.projectResourcesIntoRepo = true;
				const host = {
					...s.host,
					resolveProjectGit: vi.fn(async () => ({ root: repo, commonDirectory })),
				};
				host.commit.mockRejectedValueOnce(new Error('Synthetic commit failure'));
				const result = await applyTranslation(s.archive, s.registry, s.journal, host, true);
				expect(result.state).toBe('failed');
				expect(await readFile(file, 'utf8')).toBe('Synthetic skill');
				const written = await readFile(exclude, 'utf8');
				expect(written).toContain(`/project/.claude/skills/test\\ \\[one\\]/SKILL.md`);
				expect(written).toContain(`# Maestro provider resources ${s.journal.plan.id} begin`);
				const edited = inside
					? written.replace(
							`# Maestro provider resources ${s.journal.plan.id} end`,
							`/inside-user-rule\n# Maestro provider resources ${s.journal.plan.id} end`
						)
					: written;
				await writeFile(
					exclude,
					Buffer.concat([Buffer.from(edited + '/later-user-rule\n'), Buffer.from([0xff])])
				);
				const durable = await s.archive.read('agent', s.journal.plan.id);
				expect(
					durable.resourceWrites.find((w) => w.path === exclude)?.gitExcludeBlock
				).toBeTruthy();
				expect((await recoverTranslation(s.archive, durable, host, true)).state).toBe(
					'rolled-back'
				);
				expect(await readFile(exclude)).toEqual(
					Buffer.concat([
						Buffer.from(original + (inside ? '\n/inside-user-rule\n' : '') + '/later-user-rule\n'),
						Buffer.from([0xff]),
					])
				);
				await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
			} finally {
				await rm(s.root, { recursive: true, force: true });
			}
		}
	);
	it('never removes an unowned exclude file that collides after the journal records intent', async () => {
		const s = await scenario();
		try {
			const commonDirectory = path.join(s.root, 'git-common');
			await mkdir(path.join(commonDirectory, 'info'), { recursive: true });
			const exclude = path.join(commonDirectory, 'info/exclude');
			const file = path.join(s.journal.plan.destination.projectRoot, 'CLAUDE.md');
			const bytes = Buffer.from('Synthetic instructions');
			s.journal.plan.scope.projectResourcesIntoRepo = true;
			s.journal.projections = [
				{
					path: file,
					sha256: translationHash(bytes),
					created: true,
					expectedHash: null,
					bytesBase64: bytes.toString('base64'),
				},
			];
			const host = {
				...s.host,
				resolveProjectGit: vi.fn(async () => ({ root: s.root, commonDirectory })),
			};
			const persist = s.archive.write.bind(s.archive);
			let collision = '';
			vi.spyOn(s.archive, 'write').mockImplementation(async (journal) => {
				await persist(journal);
				const intent = journal.resourceWrites.find((w) => w.gitExcludeBlock);
				if (intent && !collision) {
					collision = intent.gitExcludeBlock!;
					await writeFile(exclude, collision, { flag: 'wx' });
				}
			});
			expect((await applyTranslation(s.archive, s.registry, s.journal, host, true)).state).toBe(
				'failed'
			);
			await expect(
				recoverTranslation(s.archive, await s.archive.read('agent', s.journal.plan.id), host, true)
			).rejects.toThrow('ownership is unproved');
			expect(await readFile(exclude, 'utf8')).toBe(collision);
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it('refuses an exclude symlink outside git metadata before writing project resources', async () => {
		const s = await scenario();
		try {
			const commonDirectory = path.join(s.root, 'git-common');
			await mkdir(path.join(commonDirectory, 'info'), { recursive: true });
			const external = path.join(s.root, 'user-exclude');
			await writeFile(external, '/user-rule\n');
			await symlink(external, path.join(commonDirectory, 'info/exclude'));
			const file = path.join(s.journal.plan.destination.projectRoot, 'CLAUDE.md');
			const bytes = Buffer.from('Synthetic instructions');
			s.journal.plan.scope.projectResourcesIntoRepo = true;
			s.journal.projections = [
				{
					path: file,
					sha256: translationHash(bytes),
					created: true,
					expectedHash: null,
					bytesBase64: bytes.toString('base64'),
				},
			];
			const host = {
				...s.host,
				resolveProjectGit: vi.fn(async () => ({ root: s.root, commonDirectory })),
			};
			const result = await applyTranslation(s.archive, s.registry, s.journal, host, true);
			expect(result.error).toContain('symlink');
			expect(s.host.commit).not.toHaveBeenCalled();
			expect(await readFile(external, 'utf8')).toBe('/user-rule\n');
			await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it.each(['info', 'warning', 'block'] as const)(
		'applies info without acceptance, while preserving the %s tier gate',
		async (severity) => {
			const s = await scenario();
			try {
				s.journal.plan.limitations = [
					{ code: 'synthetic', severity, message: 'Synthetic limitation' },
				];
				s.journal.plan.status = severity === 'block' ? 'blocked' : 'ready';
				expect(limitationsNeedingAcceptance(s.journal.plan.limitations)).toHaveLength(
					severity === 'warning' ? 1 : 0
				);
				const result = await applyTranslation(s.archive, s.registry, s.journal, s.host);
				expect(result.state).toBe(severity === 'info' ? 'committed' : 'refused');
				expect(s.host.commit).toHaveBeenCalledTimes(severity === 'info' ? 1 : 0);
			} finally {
				await rm(s.root, { recursive: true, force: true });
			}
		}
	);
	it('stores only warnings when a mixed-tier plan is deferred', async () => {
		const s = await scenario();
		try {
			s.journal.plan.status = 'deferred';
			const warning = {
				code: 'unverified-native-resume',
				severity: 'warning' as const,
				message: 'Unverified',
			};
			s.journal.plan.limitations = [
				{ code: 'native-cwd-drift', severity: 'info', message: 'Source evidence' },
				warning,
			];
			expect((await applyTranslation(s.archive, s.registry, s.journal, s.host, true)).state).toBe(
				'deferred'
			);
			expect(s.host.setMigration).toHaveBeenCalledWith(
				expect.objectContaining({ acceptedLimitationCodes: [canonicalJson(warning)] })
			);
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
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
			s.journal.resources.push(
				translationArtifact('memory', 'synthetic', 'memory/MEMORY.md', Buffer.from('Selected fact'))
			);
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
			const directory = path.join(s.host.knowledgeRoot, translationHash('agent'), result.plan.id);
			expect(s.journal.knowledgeDirectory).toBe(directory);
			expect(await readFile(path.join(directory, 'memory/MEMORY.md'), 'utf8')).toBe(
				'Selected fact'
			);
			await expect(readdir(s.journal.plan.destination.projectRoot)).rejects.toMatchObject({
				code: 'ENOENT',
			});
			expect(s.host.setMigration).toHaveBeenLastCalledWith(
				expect.objectContaining({ state: 'committed' })
			);
		} finally {
			await rm(s.root, { recursive: true, force: true });
		}
	});
	it.each(['recover', 'rollback', 'rollback-symlink'] as const)(
		'can %s an archived legacy in-repo knowledge journal',
		async (action) => {
			const s = await scenario();
			try {
				s.host.commit.mockRejectedValueOnce(new Error('interrupted commit'));
				await applyTranslation(s.archive, s.registry, s.journal, s.host, true);
				const oldDirectory = s.journal.knowledgeDirectory!;
				const legacyDirectory = path.join(
					s.journal.plan.destination.projectRoot,
					'.maestro/provider-knowledge',
					translationHash('agent'),
					s.journal.plan.id
				);
				await mkdir(legacyDirectory, { recursive: true });
				for (const write of s.journal.resourceWrites) {
					const bytes = await readFile(write.path);
					await rm(write.path);
					write.path = path.join(legacyDirectory, path.relative(oldDirectory, write.path));
					await writeFile(write.path, bytes);
				}
				s.journal.knowledgeDirectory = legacyDirectory;
				await s.archive.write(s.journal);
				const durable = await s.archive.read('agent', s.journal.plan.id);
				expect(durable.knowledgeDirectory).toBe(legacyDirectory);
				if (action === 'rollback-symlink') {
					const legacyRoot = path.join(
						s.journal.plan.destination.projectRoot,
						'.maestro/provider-knowledge'
					);
					const external = path.join(s.root, 'external');
					await rename(legacyRoot, external);
					await symlink(external, legacyRoot, 'dir');
					await expect(recoverTranslation(s.archive, durable, s.host, true)).rejects.toThrow(
						'symlink'
					);
					expect(await readFile(path.join(legacyDirectory, 'knowledge-index.md'), 'utf8')).toBe('');
					return;
				}
				const result = await recoverTranslation(s.archive, durable, s.host, action === 'rollback');
				expect(result.state).toBe(action === 'rollback' ? 'rolled-back' : 'committed');
				if (action === 'rollback')
					await expect(
						readFile(path.join(legacyDirectory, 'knowledge-index.md'))
					).rejects.toMatchObject({ code: 'ENOENT' });
				else expect(s.host.commit).toHaveBeenLastCalledWith(durable);
			} finally {
				await rm(s.root, { recursive: true, force: true });
			}
		}
	);
	it('refuses managed writes through a redirected agent directory', async () => {
		const s = await scenario();
		try {
			const external = path.join(s.root, 'external');
			await mkdir(s.host.knowledgeRoot, { recursive: true });
			await mkdir(external);
			await symlink(external, path.join(s.host.knowledgeRoot, translationHash('agent')), 'dir');
			const result = await applyTranslation(s.archive, s.registry, s.journal, s.host, true);
			expect(result.state).toBe('failed');
			expect(result.error).toContain('symlink');
			expect(s.host.commit).not.toHaveBeenCalled();
			expect(await readdir(external)).toEqual([]);
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
					s.host.knowledgeRoot,
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
				if (kind === 'native projection') s.journal.plan.scope.projectResourcesIntoRepo = true;
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
