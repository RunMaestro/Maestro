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
import {
	createTranslationRegistry,
	readGrokSessionSnapshot,
} from '../../../shared/maestro-lib/translation/adapters';
import {
	encodeGrokCwdDirname,
	extractGrokConversation,
	extractNativeConversation,
} from '../../../shared/maestro-lib/translation/native-records';
import { TRANSLATION_PROVIDER_VERSIONS } from '../../../shared/maestro-lib/translation/support';
import type {
	PortableConversation,
	TranslationIdentity,
	TranslationRpc,
} from '../../../shared/maestro-lib/translation/types';
import { encodeClaudeProjectPath } from '../../../shared/pathUtils';
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

// Grok carry-over transactions. Deterministic fixture tests only: synthetic
// accounts under a temp root and a fake Codex import channel. They prove the shared
// transaction's apply, retry, crash, rollback and round-trip rules for Grok; they do not
// qualify any real Grok, Claude or Codex binary or certify a direction.
describe('Grok carry-over transactions (deterministic fixtures, not native qualification)', () => {
	const GROK_MODEL = 'synthetic-grok-model';
	const SECRET = 'SYNTHETIC-GROK-CREDENTIAL';
	async function grokWorld() {
		const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'maestro-grok-txn-')));
		const projectRoot = path.join(root, 'project');
		await mkdir(projectRoot);
		// The selected Grok accounts exist (a sessions root under a missing account is refused).
		for (const name of ['grok-a', 'grok-b']) await mkdir(path.join(root, name));
		const grok = (name: string): TranslationIdentity => ({
			provider: 'grok',
			version: TRANSLATION_PROVIDER_VERSIONS.grok.testedVersions[0],
			accountRoot: path.join(root, name),
			nativeSessionRoot: path.join(root, name, 'sessions'),
			projectRoot,
		});
		const claude: TranslationIdentity = {
			provider: 'claude-code',
			version: TRANSLATION_PROVIDER_VERSIONS['claude-code'].testedVersions[0],
			accountRoot: path.join(root, 'claude'),
			projectRoot,
		};
		const codex: TranslationIdentity = {
			provider: 'codex',
			version: TRANSLATION_PROVIDER_VERSIONS.codex.testedVersions[0],
			accountRoot: path.join(root, 'codex'),
			projectRoot,
		};
		// A Codex app-server double: it creates a rollout inside the selected account and
		// persists injected items with provider-assigned IDs, as the real channel does.
		let threads = 0;
		const rollouts = new Map<string, string>();
		const codexRpc: TranslationRpc = {
			request: (async (method: string, params: any) => {
				if (method === 'thread/start') {
					const id = `synthetic-thread-${++threads}`;
					const file = path.join(codex.accountRoot, 'sessions', `${id}.jsonl`);
					await mkdir(path.dirname(file), { recursive: true });
					await writeFile(file, '');
					rollouts.set(id, file);
					return { thread: { id, path: file } };
				}
				if (method === 'thread/inject_items') {
					const rows = params.items.map((item: object, i: number) =>
						JSON.stringify({
							type: 'response_item',
							payload: { ...item, id: `msg_${params.threadId}_${i}` },
						})
					);
					await writeFile(rollouts.get(params.threadId)!, rows.join('\n') + '\n', { flag: 'a' });
					return {};
				}
				throw new Error(`unexpected ${method}`);
			}) as TranslationRpc['request'],
			onNotification: () => () => {},
		};
		const committed = new Set<string>();
		const host = {
			knowledgeRoot: path.join(root, 'data', 'provider-knowledge'),
			resolveProjectGit: vi.fn(
				async (): Promise<{ root: string; commonDirectory: string } | undefined> => undefined
			),
			assertSourceUnchanged: vi.fn(async (_journal: TranslationJournal) => {}),
			setMigration: vi.fn(async () => {}),
			commit: vi.fn(async (journal: TranslationJournal) => {
				committed.add(journal.plan.id);
			}),
			isCommitted: vi.fn(async (id: string) => committed.has(id)),
			destinationModel: vi.fn((_tabId: string) => GROK_MODEL as string | undefined),
			codex: codexRpc,
		};
		const archive = new TranslationArchive(path.join(root, 'private'));
		const registry = createTranslationRegistry();
		const writeGrokSession = async (identity: TranslationIdentity, id: string, marker: string) => {
			const dir = path.join(
				identity.accountRoot,
				'sessions',
				encodeGrokCwdDirname(projectRoot)!,
				id
			);
			await mkdir(dir, { recursive: true });
			await writeFile(
				path.join(dir, 'summary.json'),
				JSON.stringify({ info: { id, cwd: projectRoot }, chat_format_version: 1 })
			);
			const rows = [
				{ type: 'system', content: 'SYNTHETIC-SYSTEM-PROMPT' },
				{ type: 'user', content: `<user_query>${marker} question</user_query>` },
				{
					type: 'assistant',
					content: 'reading',
					model_id: 'SYNTHETIC-MODEL-ID',
					reasoning: { encrypted_content: 'SYNTHETIC-ENCRYPTED' },
					tool_calls: [{ id: `call_${marker}`, name: 'read_file', arguments: '{"path":"a"}' }],
				},
				{ type: 'tool_result', tool_call_id: `call_${marker}`, content: `${marker} file body` },
				{ type: 'assistant', content: `${marker} answer` },
			];
			await writeFile(
				path.join(dir, 'chat_history.jsonl'),
				rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
			);
		};
		const readGrok = async (identity: TranslationIdentity, tabId: string, id: string) =>
			extractGrokConversation(
				identity,
				tabId,
				id,
				(await readGrokSessionSnapshot(identity, id)).bytes
			);
		const readNative = async (identity: TranslationIdentity, tabId: string, id: string) => {
			if (identity.provider === 'grok') return readGrok(identity, tabId, id);
			const file =
				identity.provider === 'codex'
					? path.join(identity.accountRoot, 'sessions', `${id}.jsonl`)
					: path.join(
							identity.accountRoot,
							'projects',
							encodeClaudeProjectPath(projectRoot),
							`${id}.jsonl`
						);
			return extractNativeConversation(identity, tabId, id, await readFile(file));
		};
		const claudeConversation = (tabId: string, marker: string) =>
			extractNativeConversation(
				claude,
				tabId,
				`claude-${tabId}`,
				Buffer.from(
					[
						{
							type: 'user',
							uuid: `${tabId}-u`,
							message: { role: 'user', content: `${marker} ask` },
						},
						{
							type: 'assistant',
							uuid: `${tabId}-a`,
							message: { role: 'assistant', content: [{ type: 'text', text: `${marker} reply` }] },
						},
					]
						.map((row) => JSON.stringify(row))
						.join('\n')
				)
			);
		// A plan carries the agent's checkpoint as it read it, as a real preflight does: a
		// commit refuses when the archive's checkpoint moved since.
		const journalFor = async (
			source: TranslationIdentity,
			destination: TranslationIdentity,
			conversations: PortableConversation[],
			newRecords?: Record<string, number>
		): Promise<TranslationJournal> => ({
			schemaVersion: 1,
			checkpoint: structuredClone(await archive.checkpoint('agent')),
			plan: planTranslation({
				agentId: 'agent',
				source,
				destination,
				scope: { projectKnowledge: true, selectedUserResources: [] },
				conversations,
				registry,
				newRecords,
			}),
			state: 'planned',
			conversations,
			resources: [],
			mappings: [],
			resourceWrites: [],
		});
		const grokSessionDirs = async (identity: TranslationIdentity) =>
			(
				await readdir(
					path.join(identity.accountRoot, 'sessions', encodeGrokCwdDirname(projectRoot)!)
				)
			).sort();
		const tree = async (dir: string) => {
			const files: Record<string, string> = {};
			for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }))
				if (entry.isFile()) {
					const file = path.join(entry.parentPath, entry.name);
					files[path.relative(dir, file)] = await readFile(file, 'utf8');
				}
			return files;
		};
		const twoTabs = () => [claudeConversation('one', 'ALPHA'), claudeConversation('two', 'BETA')];
		return {
			root,
			grok,
			claude,
			codex,
			host,
			archive,
			registry,
			writeGrokSession,
			readGrok,
			readNative,
			claudeConversation,
			twoTabs,
			journalFor,
			grokSessionDirs,
			tree,
		};
	}
	const LATER_ROW = '{"type":"user","content":"later native turn"}\n';

	it('stages every tab as its own Grok session and a committed retry creates no duplicate', async () => {
		const w = await grokWorld();
		try {
			const destination = w.grok('grok-b');
			const journal = await w.journalFor(w.claude, destination, w.twoTabs());
			expect(journal.plan.status).toBe('ready');
			expect(journal.plan.verification).toBe('unverified');
			const result = await applyTranslation(w.archive, w.registry, journal, w.host, true);
			expect(result.state).toBe('committed');
			expect(w.host.destinationModel.mock.calls.map(([tab]) => tab)).toEqual(['one', 'two']);
			const ids = result.mappings.map((m) => m.destinationSessionId!);
			expect(new Set(ids).size).toBe(2);
			expect(await w.grokSessionDirs(destination)).toEqual([...ids].sort());
			// Each tab reads back from its own session with only its own history.
			for (const [index, marker] of ['ALPHA', 'BETA'].entries()) {
				const back = JSON.stringify(
					(await w.readGrok(destination, result.mappings[index].tabId, ids[index])).records
				);
				expect(back).toContain(`${marker} ask`);
				expect(back).not.toContain(index ? 'ALPHA' : 'BETA');
			}
			// Readback is keyed by Grok's own row identities, which a later Grok-source plan reconciles.
			const eventIds = Object.keys(journal.destinationObserved!).map(
				(key) => JSON.parse(key).eventId
			);
			expect(eventIds.sort()).toEqual(['line:0', 'line:0', 'line:1', 'line:1']);
			const durable = await w.archive.read('agent', journal.plan.id);
			const stage = vi.spyOn(w.registry.get('grok')!, 'stage');
			expect(await applyTranslation(w.archive, w.registry, durable, w.host, true)).toEqual(result);
			expect(stage).not.toHaveBeenCalled();
			expect(w.host.commit).toHaveBeenCalledTimes(1);
			expect(await w.grokSessionDirs(destination)).toEqual([...ids].sort());
		} finally {
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it('recovers a failed Grok mapping commit without restaging, and refuses recovery over a native edit', async () => {
		const w = await grokWorld();
		try {
			const destination = w.grok('grok-b');
			const journal = await w.journalFor(w.claude, destination, [
				w.claudeConversation('one', 'ALPHA'),
			]);
			w.host.commit.mockRejectedValueOnce(new Error('store unavailable'));
			const failed = await applyTranslation(w.archive, w.registry, journal, w.host, true);
			expect(failed.state).toBe('failed');
			expect(journal.failurePhase).toBe('committing');
			const ids = failed.mappings.map((m) => m.destinationSessionId);
			const stage = vi.spyOn(w.registry.get('grok')!, 'stage');
			const recovered = await recoverTranslation(
				w.archive,
				await w.archive.read('agent', journal.plan.id),
				w.host
			);
			expect(recovered.state).toBe('committed');
			expect(recovered.mappings.map((m) => m.destinationSessionId)).toEqual(ids);
			expect(stage).not.toHaveBeenCalled();
			expect(await w.grokSessionDirs(destination)).toEqual(ids);

			// A second operation whose staged transcript gained native work before recovery.
			stage.mockRestore();
			const second = await w.journalFor(w.claude, destination, [
				w.claudeConversation('one', 'GAMMA'),
			]);
			w.host.commit.mockRejectedValueOnce(new Error('store unavailable'));
			const pending = await applyTranslation(w.archive, w.registry, second, w.host, true);
			expect(pending.state).toBe('failed');
			const transcript = pending.mappings[0].artifacts[0].path;
			await writeFile(transcript, (await readFile(transcript, 'utf8')) + LATER_ROW);
			await expect(
				recoverTranslation(w.archive, await w.archive.read('agent', second.plan.id), w.host)
			).rejects.toThrow('Destination readback changed');
			expect(w.host.commit).toHaveBeenCalledTimes(3);
			expect(await readFile(transcript, 'utf8')).toContain('later native turn');
		} finally {
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it('rolls back an interrupted multi-tab Grok stage and keeps a conflicting or later native session', async () => {
		const w = await grokWorld();
		try {
			const destination = w.grok('grok-b');
			const persist = w.archive.write.bind(w.archive);
			// Crash: the durable journal holds tab one staged and tab two's intent when the process dies.
			const crash = await w.journalFor(w.claude, destination, w.twoTabs());
			let snapshot: TranslationJournal | undefined;
			const crashWrite = vi.spyOn(w.archive, 'write').mockImplementation(async (journal) => {
				await persist(journal);
				const two = journal.mappings.find((m) => m.tabId === 'two');
				if (!snapshot && two && two.artifacts.every((a) => !a.created)) {
					snapshot = structuredClone(journal);
					throw new Error('synthetic crash');
				}
			});
			await applyTranslation(w.archive, w.registry, crash, w.host, true);
			crashWrite.mockRestore();
			await w.archive.write(snapshot!);
			const durable = await w.archive.read('agent', crash.plan.id);
			expect(durable.state).toBe('staging');
			expect(await w.grokSessionDirs(destination)).toEqual([
				durable.mappings.find((m) => m.tabId === 'one')!.destinationSessionId,
			]);
			await expect(recoverTranslation(w.archive, durable, w.host)).rejects.toThrow(
				'uncertain writes are not retried'
			);
			expect((await recoverTranslation(w.archive, durable, w.host, true)).state).toBe(
				'rolled-back'
			);
			expect(await w.grokSessionDirs(destination)).toEqual([]);
			expect(w.host.commit).not.toHaveBeenCalled();

			// Conflict: another writer creates tab two's session directory after its intent is journaled.
			const conflict = await w.journalFor(w.claude, destination, w.twoTabs());
			let foreign: string | undefined;
			const conflictWrite = vi.spyOn(w.archive, 'write').mockImplementation(async (journal) => {
				await persist(journal);
				const two = journal.mappings.find((m) => m.tabId === 'two');
				if (!foreign && two && two.artifacts.every((a) => !a.created)) {
					foreign = path.dirname(two.artifacts[0].path);
					await mkdir(foreign, { recursive: true });
					await writeFile(path.join(foreign, 'updates.jsonl'), 'SYNTHETIC-FOREIGN\n');
				}
			});
			const result = await applyTranslation(w.archive, w.registry, conflict, w.host, true);
			conflictWrite.mockRestore();
			expect(result.state).toBe('failed');
			expect(w.host.commit).not.toHaveBeenCalled();
			const staged = await w.archive.read('agent', conflict.plan.id);
			expect(staged.mappings.find((m) => m.tabId === 'two')!.artifacts.some((a) => a.created)).toBe(
				false
			);
			expect((await recoverTranslation(w.archive, staged, w.host, true)).state).toBe('rolled-back');
			expect(await w.grokSessionDirs(destination)).toEqual([path.basename(foreign!)]);
			expect(await readFile(path.join(foreign!, 'updates.jsonl'), 'utf8')).toBe(
				'SYNTHETIC-FOREIGN\n'
			);

			// Later work: one tab's transcript changed, so nothing in the operation is deleted.
			await rm(foreign!, { recursive: true });
			const later = await w.journalFor(w.claude, destination, w.twoTabs());
			w.host.commit.mockRejectedValueOnce(new Error('store unavailable'));
			const pending = await applyTranslation(w.archive, w.registry, later, w.host, true);
			const [first, second] = pending.mappings;
			const edited = first.artifacts[0].path;
			const stagedBytes = await readFile(edited, 'utf8');
			await writeFile(edited, stagedBytes + LATER_ROW);
			const before = await w.tree(destination.accountRoot);
			await expect(
				recoverTranslation(w.archive, await w.archive.read('agent', later.plan.id), w.host, true)
			).rejects.toThrow('Rollback refused');
			expect(await w.tree(destination.accountRoot)).toEqual(before);
			// An untouched transcript beside a new native file: the files go, the directory stays.
			await writeFile(edited, stagedBytes);
			const extra = path.join(path.dirname(second.artifacts[0].path), 'updates.jsonl');
			await writeFile(extra, 'SYNTHETIC-LATER-NATIVE\n');
			expect(
				(
					await recoverTranslation(
						w.archive,
						await w.archive.read('agent', later.plan.id),
						w.host,
						true
					)
				).state
			).toBe('rolled-back');
			expect(await w.grokSessionDirs(destination)).toEqual([second.destinationSessionId]);
			expect(await readdir(path.dirname(extra))).toEqual(['updates.jsonl']);
		} finally {
			await rm(w.root, { recursive: true, force: true });
		}
	});

	it.each(['claude-code', 'codex'] as const)(
		'repeats Grok -> %s -> Grok round trips without duplicating history or crossing accounts',
		async (middleProvider) => {
			const w = await grokWorld();
			try {
				const grok = w.grok('grok-a');
				const other = w.grok('grok-b');
				const middle = middleProvider === 'codex' ? w.codex : w.claude;
				await w.writeGrokSession(grok, 'grok-source', 'ALPHA');
				await w.writeGrokSession(other, 'grok-source', 'OTHER');
				await writeFile(path.join(grok.accountRoot, 'auth.json'), SECRET);
				await writeFile(path.join(other.accountRoot, 'auth.json'), SECRET);
				const otherBefore = await w.tree(other.accountRoot);
				const original = await w.readGrok(grok, 'one', 'grok-source');
				const visible = original.records.filter((r) => r.role === 'user' || r.role === 'assistant');
				const origins = original.records.map((r) => r.origin);

				let current = { identity: grok, sessionId: 'grok-source' };
				for (let round = 0; round < 2; round++) {
					for (const destination of [middle, grok]) {
						const checkpoint = await w.archive.checkpoint('agent');
						const incoming = await w.readNative(current.identity, 'one', current.sessionId);
						const reconciled = reconcileConversation(incoming, checkpoint);
						expect(reconciled.limitations.filter((l) => l.severity === 'block')).toEqual([]);
						// Only the very first read is new; every echo maps back to its origin.
						expect(reconciled.newRecords).toBe(checkpoint ? 0 : original.records.length);
						expect(reconciled.conversation.records.map((r) => r.origin)).toEqual(origins);
						const journal = await w.journalFor(
							current.identity,
							destination,
							[reconciled.conversation],
							{
								one: reconciled.newRecords,
							}
						);
						expect(journal.plan.status).toBe('ready');
						expect(journal.plan.verification).toBe('unverified');
						const result = await applyTranslation(w.archive, w.registry, journal, w.host, true);
						expect(result.state).toBe('committed');
						expect(result.mappings).toHaveLength(1);
						current = {
							identity: destination,
							sessionId: result.mappings[0].destinationSessionId!,
						};
					}
					// One new Grok session per Grok-destination apply, all in the selected account.
					expect(await w.grokSessionDirs(grok)).toHaveLength(round + 2);
					const back = await w.readGrok(grok, 'one', current.sessionId);
					// Archived payloads (inline reasoning) stay in the checkpoint, never in the Grok rows.
					const shown = (records: typeof visible) =>
						records.map((r) => [r.role, r.blocks.filter((b) => b.kind !== 'opaque')]);
					expect(shown(back.records)).toEqual(shown(visible));
					expect(back.records.flatMap((r) => r.blocks).some((b) => b.kind === 'opaque')).toBe(
						false
					);
					const transcript = await readFile(
						(await readGrokSessionSnapshot(grok, current.sessionId)).transcriptPath,
						'utf8'
					);
					for (const internal of [
						'SYNTHETIC-SYSTEM-PROMPT',
						'SYNTHETIC-ENCRYPTED',
						'SYNTHETIC-MODEL-ID',
					])
						expect(transcript).not.toContain(internal);
				}
				// No write reached the unselected Grok account, and no credential left either account.
				expect(await w.tree(other.accountRoot)).toEqual(otherBefore);
				for (const [file, text] of Object.entries(await w.tree(w.root)))
					if (path.basename(file) !== 'auth.json') {
						expect(text).not.toContain(SECRET);
						expect(text).not.toContain(Buffer.from(SECRET).toString('base64'));
					}
				expect(w.host.commit).toHaveBeenCalledTimes(4);
			} finally {
				await rm(w.root, { recursive: true, force: true });
			}
		}
	);
});
