// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '@huggingface/transformers';
import { createServer } from 'node:http';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { MemoryModels, ExtractionOutputError } from '../../../main/pianola/memory-models';
import type { MemoryEvidence } from '../../../shared/pianola/memory';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemoryDatabase } from '../../../main/pianola/memory-database';

async function ownedExtraction(
	models: MemoryModels,
	config: Parameters<MemoryModels['extract']>[0],
	input: Parameters<MemoryModels['extract']>[1],
	id: string
) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-evidence-transport-'));
	const db = new MemoryDatabase(path.join(directory, 'bank.sqlite'));
	let scope: ReturnType<typeof db.transport.begin> | undefined;
	try {
		db.set('config', { ...db.config(), ...config });
		db.set('paused', false);
		db.upsertSource({
			id: 'fixture-source',
			provider: 'omp',
			root: directory,
			host: 'local',
			sessionId: 'fixture',
			projectId: 'fixture-project',
			projectPath: directory,
			filePath: path.join(directory, 'never-read.jsonl'),
			revision: 'fixture',
			size: 1,
			modifiedAt: 1,
			userId: db.config().userId,
			authorship: 'human',
			cursor: 0,
			state: 'pending',
		});
		db.enqueue(id, 'fixture-source', JSON.stringify({ id }));
		const owner = db.transport.registerOwner();
		if (!db.claimQueued(id, owner)) throw new Error('Missing fixture claim');
		scope = db.db
			.transaction(() =>
				db.transport.begin(owner, id, id, 'extract', 'fixture-reservation', () => true)
			)
			.immediate();
		if (!scope) throw new Error('Missing fixture permit');
		return await models.extract(db.config(), input, id, () => {}, undefined, scope);
	} finally {
		scope?.finish();
		await models.drainTransport();
		db.close();
		await fs.rm(directory, { recursive: true, force: true });
	}
}
const cacheDir = env.cacheDir;
const allowLocalModels = env.allowLocalModels;
afterEach(() => {
	env.cacheDir = cacheDir;
	env.allowLocalModels = allowLocalModels;
	vi.restoreAllMocks();
});

const evidence: MemoryEvidence = {
	id: 'source-span',
	sourceId: 'native-session',
	messageId: 'request',
	role: 'user',
	text: 'Use SQLite because this application must work offline.',
	timestamp: '2024-01-01T00:00:00.000Z',
	attribution: 'human',
	provenance: 'conversation',
};
function claim(overrides: Record<string, unknown> = {}) {
	return {
		text: evidence.text,
		kind: 'decision',
		rationale: 'Offline operation',
		alternatives: ['PostgreSQL'],
		support: 'explicit',
		status: 'current',
		global: false,
		evidence: [{ id: evidence.id, quote: evidence.text }],
		contradicts: [],
		supersedes: null,
		duplicateOf: null,
		validFrom: null,
		validTo: null,
		...overrides,
	};
}

describe('Pianola evidence admission boundaries', () => {
	it('requires a judgment for every candidate and rejects unsupported claims', async () => {
		const models = new MemoryModels('unused-memory-test-cache');
		const candidates = [claim(), claim({ text: 'The user approved PostgreSQL.' })];
		const input = models.verificationInput([evidence], candidates, [], {
			projectId: 'project',
			projectPath: '/project',
		});
		const judgment = {
			supported: true,
			rationaleSupported: true,
			authoredByUser: true,
			correctionSupported: false,
			duplicateSupported: false,
			validitySupported: false,
			observedEvidenceSupported: false,
			scope: 'target-project',
			durability: 'durable',
		};
		const response = (memories: Record<string, unknown>) =>
			new Response(
				JSON.stringify({
					message: { content: JSON.stringify({ memories }) },
					prompt_eval_count: 1,
					eval_count: 1,
				})
			);
		const fetch = vi.spyOn(globalThis, 'fetch');
		fetch.mockResolvedValueOnce(response({ '0': judgment }));
		const config = {
			mode: 'local',
			endpoint: 'http://127.0.0.1:11434',
			model: 'fixture',
		} as Parameters<MemoryModels['extract']>[0];
		await expect(ownedExtraction(models, config, input, 'incomplete')).rejects.toThrow(
			/Incomplete semantic verification/
		);
		fetch.mockResolvedValueOnce(
			response({ '0': judgment, '1': { ...judgment, supported: false } })
		);
		const result = await ownedExtraction(models, config, input, 'complete');
		if (result.pending) throw new Error('Unexpected batch result');
		const accepted = models.validate(
			models.verified(candidates, result.records),
			[evidence],
			'owner',
			'project',
			[]
		);
		expect(accepted.map((memory) => memory.text)).toEqual([evidence.text]);
	});
	it('rejects invented or modified source citations', () => {
		const models = new MemoryModels('unused-memory-test-cache');
		expect(() =>
			models.validate(
				[claim({ evidence: [{ id: 'missing', quote: evidence.text }] })],
				[evidence],
				'owner',
				'project',
				[]
			)
		).toThrow(/unsupported source quote/);
		expect(() =>
			models.validate(
				[claim({ evidence: [{ id: evidence.id, quote: 'Use PostgreSQL.' }] })],
				[evidence],
				'owner',
				'project',
				[]
			)
		).toThrow(/unsupported source quote/);
	});

	it('rejects a model-selected source span absent from the original evidence', async () => {
		const models = new MemoryModels('unused-memory-test-cache');
		const original = {
			...evidence,
			text: evidence.text + '\n**Exact source**: `SQLite`\t🚀 — do not normalize.',
		};
		const input = models.input([original], [], { projectId: 'project', projectPath: '/project' });
		const response = (span: string) =>
			new Response(
				JSON.stringify({
					message: { content: JSON.stringify({ memories: [claim({ evidence: [{ span }] })] }) },
					prompt_eval_count: 1,
					eval_count: 1,
				})
			);
		const fetch = vi.spyOn(globalThis, 'fetch');
		const config = {
			mode: 'local',
			endpoint: 'http://127.0.0.1:11434',
			model: 'fixture',
		} as Parameters<MemoryModels['extract']>[0];
		fetch.mockResolvedValueOnce(response('s999'));
		await expect(ownedExtraction(models, config, input, 'unknown-citation')).rejects.toBeInstanceOf(
			ExtractionOutputError
		);
	});

	it.each(['unknown', 'automated'] as const)(
		'does not activate %s history as a global human preference',
		(attribution) => {
			const models = new MemoryModels('unused-memory-test-cache');
			const [memory] = models.validate(
				[claim({ kind: 'preference', global: true })],
				[{ ...evidence, attribution }],
				'owner',
				'project',
				[]
			);
			expect(memory).toMatchObject({
				projectId: 'project',
				support: 'unverified',
				status: 'proposed',
			});
		}
	);

	it('retains objective tool observations without promoting tool output to a human decision', () => {
		const models = new MemoryModels('unused-memory-test-cache');
		const tool = {
			...evidence,
			role: 'tool',
			attribution: 'automated' as const,
			text: 'SQLite connection succeeded for pianola-memory.sqlite.',
		};
		const observationClaim = {
			kind: 'project',
			support: 'explicit',
			global: true,
			text: 'The memory store uses SQLite.',
			rationale: 'The SQLite connection succeeded.',
			evidence: [{ id: tool.id, quote: tool.text }],
		};
		const judgments = [
			{
				index: 0,
				supported: true,
				rationaleSupported: true,
				authoredByUser: false,
				correctionSupported: false,
				duplicateSupported: false,
				validitySupported: false,
				observedEvidenceSupported: true,
				scope: 'target-project',
				durability: 'durable',
			},
		];
		const [observation] = models.validate(
			models.verified([claim(observationClaim)], judgments),
			[tool],
			'owner',
			'project',
			[]
		);
		expect(observation).toMatchObject({
			projectId: 'project',
			support: 'observed',
			status: 'current',
		});
		const [decision] = models.validate(
			models.verified([claim({ ...observationClaim, kind: 'decision' })], judgments),
			[tool],
			'owner',
			'project',
			[]
		);
		expect(decision).toMatchObject({ support: 'unverified', status: 'proposed' });
	});

	it.each(['pinned', 'newer', 'unknown date'] as const)(
		'keeps a %s decision authoritative over historical extraction',
		(reason) => {
			const models = new MemoryModels('unused-memory-test-cache');
			const [original] = models.validate([claim()], [evidence], 'owner', 'project', []);
			const authoritative = {
				...original,
				pinned: reason === 'pinned',
				validFrom: '2025-01-01T00:00:00.000Z',
			};
			const source = {
				...evidence,
				timestamp: reason === 'unknown date' ? null : '2024-01-01T00:00:00.000Z',
			};
			const [replacement] = models.validate(
				[claim({ text: 'Use SQLite for the historical project.', supersedes: authoritative.id })],
				[source],
				'owner',
				'project',
				[authoritative]
			);
			expect(replacement).toMatchObject({
				supersedes: null,
				status: 'contested',
				related: [authoritative.id],
			});
		}
	);
	it('allows a dated newer correction to supersede an unpinned historical decision', () => {
		const models = new MemoryModels('unused-memory-test-cache');
		const [original] = models.validate([claim()], [evidence], 'owner', 'project', []);
		const [replacement] = models.validate(
			[
				claim({
					text: 'Use SQLite after reconsidering the earlier decision.',
					supersedes: original.id,
				}),
			],
			[{ ...evidence, timestamp: '2025-01-01T00:00:00.000Z' }],
			'owner',
			'project',
			[original]
		);
		expect(replacement).toMatchObject({
			supersedes: original.id,
			status: 'current',
			validFrom: '2025-01-01T00:00:00.000Z',
		});
	});
	it('does not supersede a claim belonging to another project or person', () => {
		const models = new MemoryModels('unused-memory-test-cache');
		const [original] = models.validate([claim()], [evidence], 'owner', 'project', []);
		for (const foreign of [
			{ ...original, projectId: 'other-project' },
			{ ...original, userId: 'other-person' },
		]) {
			const [replacement] = models.validate(
				[claim({ supersedes: foreign.id })],
				[evidence],
				'owner',
				'project',
				[foreign]
			);
			expect(replacement.supersedes).toBeNull();
		}
	});
	it('waits for local model output beyond an unrelated global header timeout', async () => {
		const originalDispatcher = getGlobalDispatcher();
		const shortDispatcher = new Agent({ headersTimeout: 10 });
		const server = createServer((request, response) => {
			request.resume();
			setTimeout(() => {
				response.setHeader('Content-Type', 'application/json');
				response.end(
					JSON.stringify({
						message: { content: '{"memories":null}' },
						prompt_eval_count: 1,
						eval_count: 1,
					})
				);
			}, 1200);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		setGlobalDispatcher(shortDispatcher);
		try {
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('Missing loopback address');
			const models = new MemoryModels('unused-memory-test-cache');
			const result = ownedExtraction(
				models,
				{
					mode: 'local',
					endpoint: `http://127.0.0.1:${address.port}`,
					model: 'fixture',
				} as Parameters<MemoryModels['extract']>[0],
				models.input([evidence], [], { projectId: 'project', projectPath: '/project' }),
				'delayed-local-output'
			);
			// The received schema error must reach admission, not become an uncertain transport failure.
			await expect(result).rejects.toBeInstanceOf(ExtractionOutputError);
			await expect(result).rejects.toThrow('Invalid memory extraction schema');
		} finally {
			setGlobalDispatcher(originalDispatcher);
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await shortDispatcher.close();
		}
	});
	it('admits a verified standing preference beside a one-shot instruction without changing original evidence', () => {
		const models = new MemoryModels('unused-memory-test-cache');
		const text =
			'For this response only, omit diagrams. My standing preference is to require passing tests before declaring a change complete.';
		const original = { ...evidence, text, durability: 'session' as const };
		const quote =
			'My standing preference is to require passing tests before declaring a change complete.';
		const judgment = {
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
		};
		const [accepted] = models.validate(
			models.verified(
				[
					claim({
						text: quote,
						kind: 'preference',
						rationale: '',
						alternatives: [],
						evidence: [{ id: original.id, quote }],
					}),
				],
				[judgment]
			),
			[original],
			'owner',
			'project',
			[]
		);
		expect(accepted).toMatchObject({ text: quote, status: 'current' });
		expect(accepted.evidence[0]).toMatchObject({ quote, text, durability: 'durable' });
		expect(original.durability).toBe('session');
	});
	it('does not promote a one-shot source quote even when a semantic judgment incorrectly calls it durable', () => {
		const models = new MemoryModels('unused-memory-test-cache');
		const original = {
			...evidence,
			text: 'For this response only, omit diagrams.',
			durability: 'session' as const,
		};
		const candidate = claim({
			text: 'Omit diagrams.',
			kind: 'preference',
			rationale: '',
			alternatives: [],
			evidence: [{ id: original.id, quote: original.text }],
		});
		const judgment = {
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
		};
		expect(
			models.validate(models.verified([candidate], [judgment]), [original], 'owner', 'project', [])
		).toEqual([]);
	});
	it('rejects a source-supported preference when it belongs to another project', () => {
		const models = new MemoryModels('unused-memory-test-cache');
		const judgment = {
			index: 0,
			supported: true,
			rationaleSupported: true,
			authoredByUser: true,
			correctionSupported: false,
			duplicateSupported: false,
			validitySupported: false,
			observedEvidenceSupported: false,
			scope: 'other-project',
			durability: 'durable',
		};
		expect(models.verified([claim()], [judgment])).toEqual([]);
	});
	it('keeps inherited session scope when the selected sentence omits the original one-shot qualifier', () => {
		const models = new MemoryModels('unused-memory-test-cache');
		const judgment = {
			index: 0,
			supported: true,
			rationaleSupported: true,
			authoredByUser: true,
			correctionSupported: false,
			duplicateSupported: false,
			validitySupported: false,
			observedEvidenceSupported: false,
			scope: 'target-project',
			durability: 'session',
		};
		expect(models.verified([claim({ text: 'Omit diagrams.' })], [judgment])).toEqual([]);
	});
	it('uses verified general scope rather than the extractor flag for a standing preference', () => {
		const models = new MemoryModels('unused-memory-test-cache');
		const original = {
			...evidence,
			text: 'I always prefer concise review comments.',
			durability: 'durable' as const,
		};
		const candidate = claim({
			text: original.text,
			kind: 'preference',
			rationale: '',
			alternatives: [],
			global: false,
			evidence: [{ id: original.id, quote: original.text }],
		});
		const judgment = {
			index: 0,
			scope: 'global',
			durability: 'durable',
			supported: true,
			rationaleSupported: true,
			authoredByUser: true,
			correctionSupported: false,
			duplicateSupported: false,
			validitySupported: false,
			observedEvidenceSupported: false,
		};
		const [memory] = models.validate(
			models.verified([candidate], [judgment]),
			[original],
			'owner',
			'project',
			[]
		);
		expect(memory.projectId).toBeNull();
		expect(memory.text).toBe(original.text);
		expect(models.verified([candidate], [{ ...judgment, scope: 'unknown' }])).toEqual([]);
		expect(() => models.verified([candidate], [{ ...judgment, scope: undefined }])).toThrow(
			'Invalid semantic verification'
		);
		for (const invalid of [{ scope: ['other-project'] }, { durability: ['session'] }]) {
			expect(() => models.verified([candidate], [{ ...judgment, ...invalid }])).toThrow(
				'Invalid semantic verification'
			);
		}
	});
});
