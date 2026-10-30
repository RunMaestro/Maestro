// @vitest-environment node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryEngine } from '../../../main/pianola/memory-engine';
import { MemoryDatabase } from '../../../main/pianola/memory-database';
import { EXTRACTION_VERSION } from '../../../main/pianola/memory-models';
import { sourceHash } from '../../../main/storage/historical-inventory';
import { registerSessionStorage, clearStorageRegistry } from '../../../main/agents/session-storage';
import { OmpSessionStorage } from '../../../main/storage/omp-session-storage';
import type { MemoryEvidence, MemorySource } from '../../../shared/pianola/memory';

const directories: string[] = [];
const databases: MemoryDatabase[] = [];
afterEach(async () => {
	for (const db of databases.splice(0)) if (db.db.open) db.close();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	clearStorageRegistry();
	await Promise.all(
		directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
	);
});
async function fixture(
	count: number,
	version = EXTRACTION_VERSION,
	evidenceText?: (index: number) => string | string[]
) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pianola-concurrency-'));
	directories.push(directory);
	const engine = new MemoryEngine(directory);
	databases.push(engine.database);
	vi.stubGlobal('fetch', () => {
		throw new Error('Network forbidden in concurrency fixtures');
	});
	const initial = engine.database.config();
	const config = {
		...initial,
		enabled: true,
		ongoing: false,
		roots: [
			{
				path: directory,
				provider: 'omp',
				userId: initial.userId,
				enabled: true,
				authorship: 'human' as const,
			},
		],
	};
	engine.database.set('config', config);
	engine.database.set('paused', false);
	const source: MemorySource = {
		id: 'source',
		provider: 'omp',
		root: directory,
		host: 'local',
		sessionId: 'synthetic',
		projectId: 'project',
		projectPath: directory,
		filePath: path.join(directory, 'never-read.jsonl'),
		revision: 'synthetic',
		size: 1,
		modifiedAt: 1,
		userId: config.userId,
		authorship: 'human',
		cursor: 0,
		state: 'pending',
	};
	engine.database.upsertSource(source);
	const jobs = Array.from({ length: count }, (_, index) => {
		const texts = evidenceText?.(index) ?? 'I always prefer synthetic editor option ' + index + '.';
		const evidence: MemoryEvidence[] = (Array.isArray(texts) ? texts : [texts]).map(
			(text, part) => ({
				id: 'event-' + index + (part ? ':' + part : ''),
				sourceId: source.id,
				messageId: 'turn-' + index + (part ? ':' + part : ''),
				role: 'user',
				text,
				timestamp: null,
				attribution: 'human',
				provenance: 'conversation',
			})
		);
		const id = sourceHash(
			config.userId +
				':' +
				source.projectId +
				':' +
				version +
				':' +
				evidence.map((event) => event.id).join(':')
		);
		const job = {
			id,
			source,
			config,
			evidence,
			nearby: [],
			cursor: index === count - 1 ? 100 : 0,
			complete: index === count - 1,
		};
		engine.database.enqueue(id, source.id, JSON.stringify(job));
		return job;
	});
	vi.spyOn(engine.models, 'embed').mockResolvedValue(
		Float32Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0))
	);
	return { engine, jobs, directory };
}
interface RequestGate {
	promise: Promise<void>;
	resolve: () => void;
}
function gate(): RequestGate {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

it('defers polling an incomplete provider batch until the next tick without resubmission', async () => {
	const { engine, jobs } = await fixture(1);
	let polled = false;
	const batchIds: (string | undefined)[] = [];
	const extract = vi
		.spyOn(engine.models, 'extract')
		.mockImplementation(async (_config, _input, _id, saveBatch, batchId) => {
			if (polled) throw new Error('Provider batch was polled repeatedly without yielding');
			polled = true;
			batchIds.push(batchId);
			if (!batchId) saveBatch('pending-batch');
			return { pending: true };
		});
	await engine.tick();
	expect(extract).toHaveBeenCalledTimes(1);
	expect(engine.database.get('paused')).toBe(false);
	expect(engine.database.hasEpisode(jobs[0].id)).toBe(false);
	expect(engine.database.queueProgress().claimed).toBe(0);
	const charge = engine.database.db.prepare('SELECT * FROM usage').all();
	polled = false;
	await engine.tick();
	expect(batchIds).toEqual([undefined, 'pending-batch']);
	expect(engine.database.db.prepare('SELECT * FROM usage').all()).toEqual(charge);
});

it('fences competing connections at five durable claims and preserves healthy reservations on open and crashed reservations on restart', async () => {
	const { engine, directory } = await fixture(8);
	const other = new MemoryDatabase(path.join(directory, 'pianola-memory.sqlite'));
	databases.push(other);
	const claimed = Array.from(
		{ length: 5 },
		(_, index) =>
			(index % 2 ? other : engine.database).claimQueued('owner-' + index, engine.transportOwner)!
	);
	expect(new Set(claimed.map((job) => job.id)).size).toBe(5);
	expect(other.claimQueued('sixth', engine.transportOwner)).toBeUndefined();
	expect(() => other.saveWork({ id: claimed[0].id }, 'intruder')).toThrow('claim lost');
	const job = JSON.parse(claimed[0].data);
	job.sent = true;
	job.reservation = 'in-flight';
	engine.database.reserve('in-flight', 10, 10, engine.database.config());
	engine.database.saveWork(job, 'owner-0');
	const usage = engine.database.db.prepare('SELECT * FROM usage').all();
	const claims = engine.database.db.prepare('SELECT * FROM ingestion_work ORDER BY id').all();
	const third = new MemoryDatabase(path.join(directory, 'pianola-memory.sqlite'));
	databases.push(third);
	expect(third.db.prepare('SELECT * FROM usage').all()).toEqual(usage);
	expect(third.db.prepare('SELECT * FROM ingestion_work ORDER BY id').all()).toEqual(claims);
	third.close();
	other.close();
	engine.database.close();
	const restart = new MemoryDatabase(path.join(directory, 'pianola-memory.sqlite'));
	databases.push(restart);
	expect(restart.claimQueued('restart', engine.transportOwner)).toBeUndefined();
	expect(restart.db.prepare('SELECT * FROM usage').all()).toEqual(usage);
	expect(restart.db.prepare('SELECT * FROM ingestion_work ORDER BY id').all()).toEqual(claims);
});

it('feeds independent native sources around an unknown permit and drains before returning', async () => {
	const { engine, jobs, directory } = await fixture(1);
	registerSessionStorage(new OmpSessionStorage());
	const claimed = engine.database.claimQueued('held', engine.transportOwner)!;
	const held = { ...jobs[0], sent: true, reservation: 'held-reservation' };
	engine.database.db.transaction(() => {
		const scope = engine.database.transport.begin(
			engine.transportOwner,
			claimed.id,
			'held',
			'extract',
			held.reservation,
			() => true
		)!;
		engine.database.reserve(held.reservation, 10, 10, engine.database.config());
		engine.database.saveWork(held, 'held');
		const request = engine.database.transport.startRequest(scope.id, 'hosted-chat', () => true);
		engine.database.transport.unknown(scope.id, request);
		engine.database.db
			.prepare("UPDATE usage SET state='uncertain' WHERE id=?")
			.run(held.reservation);
		engine.database.transport.endClaim('held', true);
	})();
	const before = engine.database.db.prepare('SELECT * FROM ingestion_work WHERE id=?').get(held.id);
	const charge = engine.database.db.prepare('SELECT * FROM usage WHERE id=?').get(held.reservation);
	for (let i = 0; i < 8; i++) {
		const filePath = path.join(directory, 'native-' + i + '.jsonl');
		await fs.writeFile(
			filePath,
			[
				{ type: 'session', id: 'native-' + i, cwd: directory },
				{
					type: 'message',
					id: 'turn-' + i,
					timestamp: '2026-10-01T00:00:00Z',
					message: {
						role: 'user',
						content: [
							{ type: 'text', text: 'I always prefer editor option ' + i + ' for this project.' },
						],
					},
				},
			]
				.map((record) => JSON.stringify(record))
				.join('\n') + '\n'
		);
		const stat = await fs.stat(filePath);
		engine.database.upsertSource({
			...jobs[0].source,
			id: 'native-' + i,
			sessionId: 'native-' + i,
			filePath,
			revision: stat.size + ':' + stat.mtimeMs,
			size: stat.size,
			modifiedAt: 100 - i,
		});
	}
	const calls: string[] = [];
	const gates: RequestGate[] = [];
	vi.spyOn(engine.models, 'extract').mockImplementation(async (_config, _input, id) => {
		calls.push(id);
		const hold = gate();
		gates.push(hold);
		await hold.promise;
		return { pending: false, records: [], inputTokens: 3, outputTokens: 2 };
	});
	const work = engine.tick();
	let drained = false;
	let drain: Promise<void> | undefined;
	try {
		await vi.waitFor(() => expect(calls).toHaveLength(4));
		expect(engine.database.transport.status().activePermits).toBe(5);
		expect(engine.database.db.prepare('SELECT COUNT(*) n FROM ingestion_queue').get()).toEqual({
			n: 5,
		});
		expect(engine.database.source('native-0')?.cursor).toBe(0);
		gates[0].resolve();
		await vi.waitFor(() => expect(calls).toHaveLength(5));
		expect(engine.database.source('native-0')?.state).toBe('complete');
		expect(engine.database.source('native-1')?.cursor).toBe(0);
		engine.pause();
		drain = engine.drain().then(
			() => {
				throw new Error('Unknown permit must prevent positive drain');
			},
			(error) => {
				expect(error.message).toBe('Owned work/transport has no positive terminal evidence');
				drained = true;
			}
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(drained).toBe(false);
	} finally {
		engine.pause();
		gates.forEach((hold) => hold.resolve());
		await work;
		await drain;
	}
	expect(drained).toBe(true);
	expect(calls).toHaveLength(5);
	expect(engine.database.transport.status().activePermits).toBe(1);
	expect(
		engine.database.db
			.prepare("SELECT COUNT(*) n FROM memory_transport_claims WHERE state='working'")
			.get()
	).toEqual({ n: 0 });
	expect(
		engine.database.db.prepare('SELECT * FROM ingestion_work WHERE id=?').get(held.id)
	).toEqual(before);
	expect(
		engine.database.db.prepare('SELECT * FROM usage WHERE id=?').get(held.reservation)
	).toEqual(charge);
});

it('runs eleven episodes with a shared five-request ceiling, extraction before verification and independent settlement without advancing an incomplete window', async () => {
	const { engine, jobs } = await fixture(11);
	const configBefore = engine.database.db
		.prepare("SELECT value FROM metadata WHERE key='config'")
		.get();
	const calls: string[] = [];
	const gates: RequestGate[] = [];
	let gated = true,
		active = 0,
		maxActive = 0;
	vi.spyOn(engine.models, 'extract').mockImplementation(async (_config, input, id) => {
		calls.push(id);
		active++;
		maxActive = Math.max(maxActive, active);
		if (gated) {
			const hold = gate();
			gates.push(hold);
			await hold.promise;
		} else await new Promise<void>((resolve) => setImmediate(resolve));
		active--;
		const records =
			input.verificationCount === undefined
				? [
						{
							text: jobs.find((job) => id.startsWith(job.id))!.evidence[0].text,
							kind: 'preference',
							rationale: 'Direct human preference',
							alternatives: [],
							support: 'explicit',
							status: 'current',
							global: false,
							evidence: [
								{ id: input.citationSpans![0].evidenceId, quote: input.citationSpans![0].quote },
							],
							contradicts: [],
							supersedes: null,
							duplicateOf: null,
							validFrom: null,
							validTo: null,
						},
					]
				: [
						{
							index: 0,
							supported: true,
							rationaleSupported: true,
							authoredByUser: true,
							correctionSupported: false,
							duplicateSupported: false,
							validitySupported: false,
							observedEvidenceSupported: false,
							scope: 'target-project',
							durability: 'durable',
						},
					];
		return { pending: false, records, inputTokens: 3, outputTokens: 2 };
	});
	const first = engine.tick();
	try {
		await vi.waitFor(() => expect(calls).toHaveLength(5));
		gates[0].resolve();
		await vi.waitFor(() => expect(calls).toHaveLength(6));
		expect(active).toBe(5);
		expect(calls[5]).toBe(jobs[0].id + ':verify');
		expect(engine.database.totals().inputTokens).toBe(3);
		gates[5].resolve();
		// A free lane must take another episode while its original siblings remain blocked.
		await vi.waitFor(() => expect(calls).toHaveLength(7));
		expect(active).toBe(5);
		expect(engine.database.source('source')?.cursor).toBe(0);
	} finally {
		gated = false;
		gates.forEach((hold) => hold.resolve());
		await first;
	}
	expect(maxActive).toBe(5);
	expect(calls).toHaveLength(22);
	expect(new Set(calls).size).toBe(22);
	for (const job of jobs) {
		expect(calls.indexOf(job.id + ':extract')).toBeLessThan(calls.indexOf(job.id + ':verify'));
		expect(
			engine.database.db.prepare('SELECT data FROM ingestion_queue WHERE id=?').get(job.id)
		).toEqual({ data: JSON.stringify(job) });
	}
	expect(engine.database.queueProgress()).toMatchObject({
		committed: 11,
		remaining: 0,
		claimed: 0,
	});
	expect(engine.database.totals()).toMatchObject({
		inputTokens: 66,
		outputTokens: 44,
		reservedTokens: 0,
	});
	expect(
		engine.database.db.prepare("SELECT COUNT(*) n FROM usage WHERE state='settled'").get()
	).toEqual({ n: 22 });
	expect(engine.database.source('source')).toMatchObject({ cursor: 100, state: 'complete' });
	expect(engine.database.db.prepare("SELECT value FROM metadata WHERE key='config'").get()).toEqual(
		configBefore
	);
});

it('does not spend semantic verification on deterministically inadmissible session evidence', async () => {
	const { engine, jobs } = await fixture(
		1,
		EXTRACTION_VERSION,
		() => 'For this response only, omit diagrams.'
	);
	const verificationInputs: number[] = [];
	const extract = vi.spyOn(engine.models, 'extract').mockImplementation(async (_config, input) => {
		if (input.verificationCount !== undefined) {
			verificationInputs.push(input.verificationCount);
			return {
				pending: false,
				records: [
					{
						index: 0,
						supported: true,
						rationaleSupported: true,
						authoredByUser: true,
						correctionSupported: false,
						duplicateSupported: false,
						validitySupported: false,
						observedEvidenceSupported: false,
						scope: 'target-project',
						durability: 'durable',
					},
				],
				inputTokens: 3,
				outputTokens: 2,
			};
		}
		return {
			pending: false,
			records: [
				{
					text: 'Omit diagrams.',
					kind: 'preference',
					rationale: '',
					alternatives: [],
					support: 'explicit',
					status: 'current',
					global: false,
					evidence: [
						{
							id: input.citationSpans![0].evidenceId,
							quote: input.citationSpans![0].quote,
						},
					],
					contradicts: [],
					supersedes: null,
					duplicateOf: null,
					validFrom: null,
					validTo: null,
				},
			],
			inputTokens: 3,
			outputTokens: 2,
		};
	});
	await engine.tick();
	expect(extract).toHaveBeenCalledTimes(1);
	expect(verificationInputs).toEqual([]);
	expect(engine.database.hasEpisode(jobs[0].id)).toBe(true);
	expect(engine.database.list(jobs[0].source.userId!, jobs[0].source.projectId)).toEqual([]);
});

it('keeps durable candidate indices aligned when session candidates are preflight rejected', async () => {
	const { engine } = await fixture(1, EXTRACTION_VERSION, () => [
		'I always prefer spaces for indentation.',
		'For this response only, omit diagrams.',
	]);
	const verifiedTexts: string[][] = [];
	vi.spyOn(engine.models, 'extract').mockImplementation(async (_config, input) => {
		if (input.verificationCount !== undefined) {
			const payload = JSON.parse(input.user) as { candidates: { text: string }[] };
			verifiedTexts.push(payload.candidates.map((candidate) => candidate.text));
			return {
				pending: false,
				records: [
					{
						index: 0,
						supported: true,
						rationaleSupported: true,
						authoredByUser: true,
						correctionSupported: false,
						duplicateSupported: false,
						validitySupported: false,
						observedEvidenceSupported: false,
						scope: 'target-project',
						durability: 'durable',
					},
				],
				inputTokens: 3,
				outputTokens: 2,
			};
		}
		const candidate = (text: string, span: number) => ({
			text,
			kind: 'preference',
			rationale: '',
			alternatives: [],
			support: 'explicit',
			status: 'current',
			global: false,
			evidence: [
				{
					id: input.citationSpans![span].evidenceId,
					quote: input.citationSpans![span].quote,
				},
			],
			contradicts: [],
			supersedes: null,
			duplicateOf: null,
			validFrom: null,
			validTo: null,
		});
		return {
			pending: false,
			records: [candidate('Use spaces for indentation.', 0), candidate('Omit diagrams.', 1)],
			inputTokens: 3,
			outputTokens: 2,
		};
	});
	await engine.tick();
	expect(verifiedTexts).toEqual([['Use spaces for indentation.']]);
	expect(
		engine.database.list(engine.database.config().userId, 'project').map((memory) => memory.text)
	).toEqual(['Use spaces for indentation.']);
});

it('reuses a legacy full verification result after preflight filtering is introduced', async () => {
	const { engine, jobs } = await fixture(1, EXTRACTION_VERSION, () => [
		'I always prefer spaces for indentation.',
		'For this response only, omit diagrams.',
	]);
	const claimed = engine.database.claimQueued('legacy-owner', engine.transportOwner)!;
	const job = JSON.parse(claimed.data);
	const candidate = (text: string, evidenceIndex: number) => ({
		text,
		kind: 'preference',
		rationale: '',
		alternatives: [],
		support: 'explicit',
		status: 'current',
		global: false,
		evidence: [
			{
				id: job.evidence[evidenceIndex].id,
				quote: job.evidence[evidenceIndex].text,
			},
		],
		contradicts: [],
		supersedes: null,
		duplicateOf: null,
		validFrom: null,
		validTo: null,
	});
	const judgment = (index: number) => ({
		index,
		supported: true,
		rationaleSupported: true,
		authoredByUser: true,
		correctionSupported: false,
		duplicateSupported: false,
		validitySupported: false,
		observedEvidenceSupported: false,
		scope: 'target-project',
		durability: 'durable',
	});
	job.extracted = {
		pending: false,
		records: [candidate('Use spaces for indentation.', 0), candidate('Omit diagrams.', 1)],
		inputTokens: 3,
		outputTokens: 2,
	};
	job.verified = {
		pending: false,
		records: [judgment(0), judgment(1)],
		inputTokens: 3,
		outputTokens: 2,
	};
	engine.database.saveWork(job, 'legacy-owner');
	engine.database.releaseWork(job.id, 'legacy-owner');
	engine.database.transport.endClaim('legacy-owner', false);
	const extract = vi.spyOn(engine.models, 'extract');
	await engine.tick();
	expect(extract).not.toHaveBeenCalled();
	expect(engine.database.hasEpisode(jobs[0].id)).toBe(true);
	expect(
		engine.database
			.list(jobs[0].source.userId!, jobs[0].source.projectId)
			.map((memory) => memory.text)
	).toEqual(['Use spaces for indentation.']);
});

it('retains an ambiguous sent outcome across retry and restart without a second provider call or released reservation', async () => {
	const { engine, directory, jobs } = await fixture(1);
	const extract = vi
		.spyOn(engine.models, 'extract')
		.mockRejectedValue(new Error('Synthetic ambiguous transport failure'));
	await engine.tick();
	expect(extract).toHaveBeenCalledTimes(1);
	const checkpoint = engine.database.db.prepare('SELECT * FROM ingestion_work').get();
	const usage = engine.database.db.prepare('SELECT * FROM usage').get();
	const totals = engine.database.totals();
	expect(totals.reservedTokens).toBeGreaterThan(0);
	vi.spyOn(engine, 'start').mockImplementation(() => engine.database.set('paused', false));
	await engine.request({ action: 'retry' });
	await engine.tick();
	expect(extract).toHaveBeenCalledTimes(1);
	expect(engine.database.db.prepare('SELECT * FROM ingestion_work').get()).toEqual(checkpoint);
	engine.database.close();
	const restart = new MemoryEngine(directory);
	databases.push(restart.database);
	const restartedExtract = vi
		.spyOn(restart.models, 'extract')
		.mockRejectedValue(new Error('Duplicate forbidden'));
	restart.database.set('paused', false);
	await restart.tick();
	expect(restartedExtract).not.toHaveBeenCalled();
	expect(restart.database.totals()).toEqual(totals);
	expect(restart.database.db.prepare('SELECT * FROM usage').get()).toEqual(usage);
	expect(restart.database.hasEpisode(jobs[0].id)).toBe(false);
	expect(
		restart.database.db.prepare('SELECT data FROM ingestion_queue WHERE id=?').get(jobs[0].id)
	).toEqual({ data: JSON.stringify(jobs[0]) });
});

it('resumes preserved v10 jobs beside an isolated legacy sent checkpoint without replay or accounting changes', async () => {
	const version = 'contextual-evidence-v10-housekeeping-provenance';
	const { engine, directory, jobs } = await fixture(3, version);
	const checkpoint = { ...jobs[0], sent: true, reservation: 'legacy-uncertain' };
	engine.database.set('pendingExtraction', checkpoint);
	engine.database.db
		.prepare('INSERT INTO usage VALUES(?,?,?,?,?,?,?)')
		.run('legacy-uncertain', 0, 0, 0, 17103, 0, 'reserved');
	const usage = engine.database.db.prepare('SELECT * FROM usage').all();
	const originalQueue = engine.database.db
		.prepare('SELECT * FROM ingestion_queue ORDER BY id')
		.all();
	engine.database.close();
	const restart = new MemoryEngine(directory);
	databases.push(restart.database);
	vi.spyOn(restart.models, 'embed').mockResolvedValue(
		Float32Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0))
	);
	const calls: string[] = [];
	vi.spyOn(restart.models, 'extract').mockImplementation(async (_config, _input, id) => {
		calls.push(id);
		return { pending: false, records: [], inputTokens: 1, outputTokens: 0 };
	});
	// A raw legacy checkpoint has no positive drain or per-job no-replay evidence.
	await restart.tick();
	expect(calls).toEqual([]);
	for (const job of jobs) expect(restart.database.hasEpisode(job.id)).toBe(false);
	expect(restart.database.source('source')?.cursor).toBe(0);
	expect(restart.database.get('pendingExtraction')).toEqual(checkpoint);
	expect(
		restart.database.db.prepare('SELECT * FROM usage WHERE id=?').all('legacy-uncertain')
	).toEqual(usage);
	expect(restart.database.db.prepare('SELECT * FROM ingestion_queue ORDER BY id').all()).toEqual(
		originalQueue
	);
	const retained = restart.database.db
		.prepare('SELECT * FROM ingestion_work WHERE id=?')
		.get(jobs[0].id);
	restart.database.close();
	const again = new MemoryEngine(directory);
	databases.push(again.database);
	const extract = vi.spyOn(again.models, 'extract');
	await again.tick();
	expect(extract).not.toHaveBeenCalled();
	expect(
		again.database.db.prepare('SELECT * FROM ingestion_work WHERE id=?').get(jobs[0].id)
	).toEqual(retained);
});

it('counts unassociated uncertain reservations against the shared five rather than freeing them on restart', async () => {
	const { engine, directory } = await fixture(1);
	for (let i = 0; i < 5; i++)
		engine.database.db
			.prepare('INSERT INTO usage VALUES(?,?,?,?,?,?,?)')
			.run('orphan-' + i, 0, 0, 0, 100, 0, 'uncertain');
	const usage = engine.database.db.prepare('SELECT * FROM usage ORDER BY id').all();
	engine.database.close();
	const restart = new MemoryEngine(directory);
	databases.push(restart.database);
	expect(restart.database.claimQueued('new-owner', restart.transportOwner)).toBeUndefined();
	expect(restart.database.db.prepare('SELECT * FROM usage ORDER BY id').all()).toEqual(usage);
	expect(restart.database.totals().reservedTokens).toBe(500);
});
