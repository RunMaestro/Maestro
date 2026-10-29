import { embedSystemPromptInPrompt } from '../../../shared/embeddedSystemPrompt';
// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { env } from '@huggingface/transformers';
import { MemoryDatabase } from '../../../main/pianola/memory-database';
import { MemoryEngine } from '../../../main/pianola/memory-engine';
import { formatMemoryContext, type ContextualMemory } from '../../../shared/pianola/memory';
import { registerSessionStorage, clearStorageRegistry } from '../../../main/agents/session-storage';
import { OmpSessionStorage } from '../../../main/storage/omp-session-storage';
import {
	discoverHistoricalSources,
	HistoryExclusions,
} from '../../../main/storage/historical-inventory';

const directories: string[] = [];
const databases: MemoryDatabase[] = [];
const cacheDir = env.cacheDir;
const allowLocalModels = env.allowLocalModels;
afterEach(async () => {
	for (const db of databases.splice(0)) db.close();
	vi.restoreAllMocks();
	clearStorageRegistry();
	env.cacheDir = cacheDir;
	env.allowLocalModels = allowLocalModels;
	await Promise.all(
		directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
	);
});
async function database() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pianola-provenance-'));
	directories.push(dir);
	const db = new MemoryDatabase(path.join(dir, 'memory.sqlite'));
	databases.push(db);
	return db;
}
const vector = new Float32Array(384);
vector[0] = 1;
function memory(id: string, evidenceText: string): ContextualMemory {
	return {
		id,
		userId: 'owner',
		projectId: null,
		kind: 'preference',
		text: 'Prefer renderer formatting ' + id,
		rationale: '',
		alternatives: [],
		support: 'explicit',
		status: 'current',
		validFrom: null,
		validTo: null,
		learnedAt: 1,
		pinned: false,
		related: [],
		supersedes: null,
		evidence: [
			{
				id: 'evidence-' + id,
				sourceId: 'explicit:' + id,
				messageId: id,
				role: 'user',
				text: evidenceText,
				timestamp: null,
				attribution: 'human',
			},
		],
	};
}
it.each([
	[
		'wrapped system context',
		'<file name="maestro-prompt.txt">\n# Maestro System Context\nPrefer renderer formatting.\n</file>',
	],
	[
		'automatic synopsis',
		'Give a brief synopsis of what you just accomplished, in exactly this format:\nPrefer renderer formatting.',
	],
	[
		'wrapped tab-naming task',
		'<file name="C:\\Temp\\maestro-prompt-fixture.txt">\nGenerate a 2-4 word tab name for this coding task. Output ONLY the name.\n</file>',
	],
])(
	'retains %s evidence but excludes it from retrieval, direct lookup, and manager context',
	async (_label, evidenceText) => {
		const db = await database();
		const contaminated = memory('host', evidenceText);
		db.store(contaminated, vector);
		expect(
			db.db.prepare('SELECT data FROM memories WHERE uuid=?').get(contaminated.id)
		).toBeDefined();
		expect(
			db.db.prepare('SELECT data FROM evidence WHERE id=?').get('evidence-host')
		).toBeDefined();
		expect(db.find(contaminated.id)).toBeNull();
		expect(db.list('owner', undefined, true)).toEqual([]);
		expect(db.retrieve('owner', null, 'renderer formatting', vector, { mode: 'history' })).toEqual(
			[]
		);
		expect(formatMemoryContext([contaminated])).not.toContain(contaminated.text);
		expect(db.releaseQuarantine(contaminated.id, 'owner')).toBe(true);
		expect(db.find(contaminated.id)).toBeNull();
	}
);
it.each(['pending', 'queued'])(
	'does not submit or embed a retained %s fragment with lost original-turn provenance',
	async (mode) => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pianola-cached-provenance-'));
		directories.push(dir);
		const engine = new MemoryEngine(dir);
		databases.push(engine.database);
		const config = engine.database.config();
		const source = {
			id: 'source',
			provider: 'omp',
			root: dir,
			host: 'local',
			sessionId: 'session',
			projectPath: dir,
			projectId: 'project',
			filePath: path.join(dir, 'native.jsonl'),
			revision: 'fixture',
			size: 1,
			modifiedAt: 1,
			userId: config.userId,
			authorship: 'human',
			cursor: 0,
			state: 'pending',
		};
		engine.database.set('config', {
			...config,
			enabled: true,
			roots: [
				{ provider: 'omp', path: dir, userId: config.userId, authorship: 'human', enabled: true },
			],
			ongoing: false,
		});
		engine.database.db
			.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?,?)')
			.run(
				source.id,
				config.userId,
				source.projectId,
				source.revision,
				0,
				'pending',
				JSON.stringify(source),
				0
			);
		const job = {
			id: 'cached',
			source,
			config: engine.database.config(),
			cursor: 0,
			complete: false,
			evidence: [
				{
					id: 'fragment',
					sourceId: source.id,
					messageId: 'original:24000',
					role: 'user',
					text: 'Rich renderer features should always be preferred.',
					timestamp: null,
					attribution: 'human',
				},
			],
			nearby: [],
		};
		engine.database.db
			.prepare('INSERT INTO ingestion_queue(id,source_id,data) VALUES(?,?,?)')
			.run(job.id, source.id, JSON.stringify(job));
		if (mode === 'pending') engine.database.set('pendingExtraction', job);
		engine.database.set('paused', false);
		const extract = vi
			.spyOn(engine.models, 'extract')
			.mockRejectedValue(new Error('Cached host fragments must not reach extraction'));
		const embed = vi
			.spyOn(engine.models, 'embed')
			.mockRejectedValue(new Error('Cached host fragments must not reach neighborhood embedding'));
		await engine.tick();
		engine.stop();
		expect(extract).not.toHaveBeenCalled();
		expect(embed).not.toHaveBeenCalled();
		expect(
			engine.database.db.prepare('SELECT data FROM ingestion_queue WHERE id=?').get(job.id)
		).toEqual({ data: JSON.stringify(job) });
		expect(engine.database.get('pendingExtraction')).toEqual(mode === 'pending' ? job : undefined);
		expect(engine.database.transport.ready(engine.transportOwner)).toBe(false);
	}
);

it('quarantines only the selected owner record, retains its source/index data, and releases it explicitly across restart', async () => {
	const db = await database();
	db.set('config', { ...db.config(), userId: 'owner' });
	const selected = memory('selected', 'Prefer renderer formatting.');
	const unrelated = memory('unrelated', 'Prefer terminal tools.');
	db.store(selected, vector);
	db.store(unrelated, vector);
	expect(db.progress(false, 'fixture', null).memories).toBe(2);
	const snapshot = () => ({
		memories: db.db.prepare('SELECT * FROM memories ORDER BY id').all(),
		evidence: db.db.prepare('SELECT * FROM evidence ORDER BY id').all(),
		fts: db.db.prepare('SELECT rowid,text,scope FROM memory_fts ORDER BY rowid').all(),
		vectors: db.db.prepare('SELECT rowid,embedding,scope FROM memory_vectors ORDER BY rowid').all(),
	});
	const before = snapshot();
	expect(db.quarantine(selected.id, 'another-owner', 'Not authorized')).toBe(false);
	expect(db.quarantine(selected.id, 'owner', 'Review attribution')).toBe(true);
	expect(snapshot()).toEqual(before);
	expect(db.progress(false, 'fixture', null).memories).toBe(1);
	expect(db.find(selected.id)).toBeNull();
	expect(db.find(unrelated.id)?.text).toBe(unrelated.text);
	expect(
		db.retrieve('owner', null, 'renderer', vector, { mode: 'history' }).map((m) => m.id)
	).toEqual([unrelated.id]);
	const file = db.db.name;
	databases.splice(databases.indexOf(db), 1);
	db.close();
	const reopened = new MemoryDatabase(file);
	databases.push(reopened);
	expect(reopened.find(selected.id)).toBeNull();
	expect(reopened.releaseQuarantine(selected.id, 'another-owner')).toBe(false);
	expect(reopened.releaseQuarantine(selected.id, 'owner')).toBe(true);
	expect(reopened.find(selected.id)?.text).toBe(selected.text);
	expect(reopened.progress(false, 'fixture', null).memories).toBe(2);
	expect(
		reopened.retrieve('owner', null, 'renderer', vector, { mode: 'history' }).map((m) => m.id)
	).toContain(selected.id);
});

it('normalizes an entire long native OMP turn before chunking and retains only the actual human request', async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pianola-native-provenance-'));
	directories.push(dir);
	const root = path.join(dir, 'history');
	const sessionDirectory = path.join(root, 'agent', 'sessions', 'fixture-project');
	await fs.mkdir(sessionDirectory, { recursive: true });
	const human = 'Prefer focused behavior tests; do not infer permission from past approvals.';
	const host =
		'<file name="maestro-prompt.txt">\n# Maestro System Context\n' +
		'Injected renderer rule. '.repeat(1600) +
		'\n</file>\n';
	const file = path.join(sessionDirectory, '2026-10-01_fixture.jsonl');
	await fs.writeFile(
		file,
		[
			{ type: 'session', id: 'fixture', cwd: dir, timestamp: '2026-10-01T00:00:00Z' },
			{
				type: 'message',
				id: 'housekeeping',
				message: {
					role: 'user',
					content: [
						{
							type: 'text',
							text: 'Give a brief synopsis of what you just accomplished, in exactly this format:',
						},
					],
				},
			},
			{
				type: 'message',
				id: 'housekeeping-reply',
				message: {
					role: 'assistant',
					content: [{ type: 'text', text: 'The user always prefers renderer formatting.' }],
				},
			},
			{
				type: 'message',
				id: 'human-turn',
				timestamp: '2026-10-01T00:00:01Z',
				message: {
					role: 'user',
					content: [
						{
							type: 'text',
							text: embedSystemPromptInPrompt(
								'# Maestro System Context\nHost-only instructions.',
								host + human
							),
						},
					],
				},
			},
		]
			.map((event) => JSON.stringify(event))
			.join('\n') + '\n'
	);
	registerSessionStorage(new OmpSessionStorage());
	const engine = new MemoryEngine(path.join(dir, 'bank'));
	databases.push(engine.database);
	const config = engine.database.config();
	const scope = {
		provider: 'omp',
		path: await fs.realpath(root),
		userId: config.userId,
		authorship: 'human' as const,
		enabled: true,
	};
	engine.database.set('config', { ...config, enabled: true, roots: [scope], ongoing: false });
	const policy = await HistoryExclusions.create([]);
	for await (const source of discoverHistoricalSources(scope, policy))
		engine.database.upsertSource(source);
	engine.database.set('paused', false);
	// The contract is what the model is allowed to see, not that extraction is skipped:
	// the host turn must be normalized away before the evidence is chunked and sent.
	const captured: { user: string; system: string }[] = [];
	const extract = vi.spyOn(engine.models, 'extract').mockImplementation(async (_config, input) => {
		captured.push({ user: input.user, system: input.system });
		return { pending: false, records: [], inputTokens: 0, outputTokens: 0 };
	});
	// Wait for the extraction outcome, not a startup-specific tick count.
	for (let attempt = 0; attempt < 4 && extract.mock.calls.length === 0; attempt++) {
		await engine.tick();
	}
	engine.stop();
	const jobs = engine.database.db.prepare('SELECT data FROM ingestion_queue').all() as {
		data: string;
	}[];
	expect(
		jobs
			.flatMap((row) => JSON.parse(row.data).evidence)
			.map((e) => ({
				text: e.text,
				role: e.role,
				attribution: e.attribution,
				provenance: e.provenance,
			}))
	).toEqual([{ text: human, role: 'user', attribution: 'human', provenance: 'conversation' }]);
	// The oversized host turn is normalized before chunking, so the model receives the
	// human request alone and never the injected host context.
	expect(extract).toHaveBeenCalled();
	expect(captured).toHaveLength(1);
	expect(captured[0].user).toContain(human);
	expect(captured[0].user).not.toContain('Injected renderer rule');
	expect(captured[0].user).not.toContain('# Maestro System Context');
	expect(captured[0].user).not.toContain('Host-only instructions');
});

it('retains committed queue payloads without resubmitting them across restart', async () => {
	const db = await database();
	const source = { id: 'source', userId: 'owner', projectId: 'project' };
	db.set('config', { ...db.config(), userId: source.userId });
	db.db
		.prepare('INSERT INTO sources(id,user_id,project_id,revision,state,data) VALUES(?,?,?,?,?,?)')
		.run(source.id, source.userId, source.projectId, 'fixture', 'pending', JSON.stringify(source));
	const payload = JSON.stringify({ source, evidence: [], nearby: [] });
	db.db
		.prepare('INSERT INTO ingestion_queue(id,source_id,data) VALUES(?,?,?)')
		.run('completed-job', source.id, payload);
	expect(db.nextQueued()?.id).toBe('completed-job');
	db.db
		.prepare('INSERT INTO episodes VALUES(?,?,?,?,1)')
		.run('completed-job', source.userId, source.id, 'fixture');
	const file = db.db.name;
	db.close();
	databases.splice(databases.indexOf(db), 1);
	const reopened = new MemoryDatabase(file);
	databases.push(reopened);
	expect(reopened.nextQueued()).toBeUndefined();
	expect(
		reopened.db.prepare('SELECT data FROM ingestion_queue WHERE id=?').get('completed-job')
	).toEqual({ data: payload });
	reopened.db
		.prepare('INSERT INTO ingestion_queue(id,source_id,data) VALUES(?,?,?)')
		.run('new-job', source.id, payload);
	expect(reopened.nextQueued()?.id).toBe('new-job');
});

it('retains a received extraction during Pause and resumes without repeating the provider call', async () => {
	const { EXTRACTION_VERSION } = await import('../../../main/pianola/memory-models');
	const { sourceHash } = await import('../../../main/storage/historical-inventory');
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pianola-paused-receipt-'));
	directories.push(dir);
	const engine = new MemoryEngine(dir);
	databases.push(engine.database);
	const initial = engine.database.config();
	const config = {
		...initial,
		enabled: true,
		ongoing: false,
		roots: [
			{
				provider: 'omp',
				path: dir,
				userId: initial.userId,
				authorship: 'human' as const,
				enabled: true,
			},
		],
	};
	engine.database.set('config', config);
	const source = {
		id: 'source',
		provider: 'omp',
		root: dir,
		host: 'local',
		sessionId: 'fixture',
		projectPath: dir,
		projectId: 'project',
		filePath: path.join(dir, 'native.jsonl'),
		revision: 'fixture',
		size: 1,
		modifiedAt: 1,
		userId: config.userId,
		authorship: 'human' as const,
		cursor: 0,
		state: 'pending' as const,
	};
	engine.database.upsertSource(source);
	const evidence = [
		{
			id: 'event',
			sourceId: source.id,
			messageId: 'turn',
			role: 'user' as const,
			text: 'Hello.',
			timestamp: null,
			attribution: 'human' as const,
			provenance: 'conversation' as const,
		},
	];
	const id = sourceHash(
		config.userId + ':' + source.projectId + ':' + EXTRACTION_VERSION + ':event'
	);
	const job = { id, source, config, evidence, nearby: [], cursor: 1, complete: true };
	const payload = JSON.stringify(job);
	engine.database.enqueue(id, source.id, payload);
	engine.database.set('paused', false);
	vi.spyOn(engine.models, 'embed').mockResolvedValue(
		Float32Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0))
	);
	const extract = vi.spyOn(engine.models, 'extract').mockImplementation(async () => {
		engine.pause();
		return { pending: false, records: [], inputTokens: 1, outputTokens: 1 };
	});
	await engine.tick();
	expect(engine.database.hasEpisode(id)).toBe(false);
	expect(engine.database.source(source.id)?.cursor).toBe(0);
	expect(
		engine.database.workJob<{ extracted: { records: unknown[] } }>(id)?.extracted.records
	).toEqual([]);
	engine.database.set('paused', false);
	await engine.tick();
	expect(extract).toHaveBeenCalledTimes(1);
	expect(engine.database.hasEpisode(id)).toBe(true);
	expect(engine.database.source(source.id)?.state).toBe('complete');
	expect(engine.database.db.prepare('SELECT data FROM ingestion_queue WHERE id=?').get(id)).toEqual(
		{ data: payload }
	);
});
