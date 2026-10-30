import { describe, expect, it } from 'vitest';
import {
	buildMemoryPacket,
	formatMemoryContext,
	type ContextualMemory,
} from '../../../shared/pianola/memory';
import {
	shortlistMemoryCandidates,
	rankRelevantMemoryCandidates,
	memoryCosineSimilarity,
	compareMemoryCandidatesByGuardedPrior,
} from '../../../main/pianola/memory-ranking';
const memory = (id = 'one'): ContextualMemory => ({
	id,
	userId: 'synthetic',
	projectId: null,
	kind: 'project',
	text: 'Use SQLite for local storage',
	rationale: '',
	alternatives: [],
	support: 'observed',
	status: 'current',
	validFrom: null,
	validTo: null,
	learnedAt: 1,
	pinned: false,
	related: [],
	supersedes: null,
	evidence: [
		{
			id: 'e',
			sourceId: 'explicit:synthetic',
			messageId: 'm',
			role: 'tool',
			text: 'SQLite confirmed',
			quote: 'SQLite confirmed',
			start: 0,
			end: 16,
			timestamp: null,
			attribution: 'automated',
		},
	],
});
describe('memory context quality', () => {
	it('preserves cited speaker roles instead of presenting tool evidence as user evidence', () => {
		const rows = formatMemoryContext([memory()])
			.trim()
			.split('\n')
			.slice(1)
			.map((line) => JSON.parse(line));
		expect(rows[0].sources[0].role).toBe('tool');
	});
	it('makes a row which cannot fit observable instead of silently dropping it', () => {
		const row = memory();
		row.text = 'x'.repeat(5000);
		const context = formatMemoryContext([row], 512);
		expect(context.length).toBeLessThanOrEqual(512);
		const footer = JSON.parse(context.trim().split('\n').at(-1)!);
		expect(footer.overflow).toMatchObject({ rows: 1, evidence: 1, truncated: 0 });
	});
	it('reports omitted IDs and clips admitted rows without losing roles', () => {
		const row = memory();
		row.text = 'x'.repeat(5000);
		row.alternatives = Array(7).fill('a');
		const small = buildMemoryPacket([row], 'synthetic', 256);
		expect(small.memories).toEqual([]);
		expect(small.overflow.omissions).toEqual([{ id: 'one', reason: 'context-budget' }]);
		const packet = buildMemoryPacket([row], 'synthetic');
		expect(packet.memories[0].text.length).toBeLessThan(row.text.length);
		expect(packet.overflow.rowTruncatedIds).toEqual(['one']);
		expect(packet.overflow.omittedAlternatives).toBe(
			row.alternatives.length - packet.memories[0].alternatives.length
		);
		expect(packet.memories[0].evidence[0].role).toBe('tool');
	});
	it('rejects budgets too small for trustworthy framing', () => {
		expect(() => buildMemoryPacket([memory()], 'synthetic', 32)).toThrow('budget');
	});
});
const candidate = (id: string, text: string, pinned = false) => ({
	memory: { ...memory(id), text, pinned },
	cosineDistance: 0.1,
});
describe('candidate retrieval versus answerability', () => {
	it('retains lexical-free candidates without treating similarity or pins as factual proof', () => {
		const unsupported = candidate('backup', 'The database exports logs nightly', true);
		const answer = candidate('cipher', 'Persisted records are sealed using AES-256-GCM');
		const shortlist = shortlistMemoryCandidates(
			[unsupported, answer],
			'Which database encryption cipher?'
		);
		expect(shortlist.map((row) => row.memory.id)).toEqual(['backup', 'cipher']);
		expect(
			rankRelevantMemoryCandidates(shortlist, [{ id: 'cipher', relevance: 2 }]).map(
				(row) => row.memory.id
			)
		).toEqual(['cipher']);
		expect(rankRelevantMemoryCandidates(shortlist, [])).toEqual([]);
	});
	it('preserves exact file, directory and drive identity despite vector similarity', () => {
		const rows = [
			candidate('sibling', 'src/archive-writer.ts'),
			candidate('exact', 'src/archive-reader.ts'),
		];
		expect(
			shortlistMemoryCandidates(rows, 'What reads src/archive-reader.ts?').map(
				(row) => row.memory.id
			)
		).toEqual(['exact']);
		expect(
			shortlistMemoryCandidates([candidate('wrong-drive', 'C:/src/reader.ts')], 'D:/src/reader.ts')
		).toEqual([]);
		expect(
			shortlistMemoryCandidates([candidate('wrong-case', '/opt/Reader.ts')], '/opt/reader.ts')
		).toEqual([]);
		expect(
			shortlistMemoryCandidates(
				[candidate('absolute', 'C:/project/src/reader.ts')],
				'src/reader.ts'
			).map((row) => row.memory.id)
		).toEqual(['absolute']);
		expect(
			shortlistMemoryCandidates(
				[
					candidate('child', 'src/renderer/View.tsx'),
					candidate('sibling', 'src/renderer-legacy/View.tsx'),
				],
				'src/renderer/'
			).map((row) => row.memory.id)
		).toEqual(['child']);
	});
	it('matches requested identity in canonical rationale and alternatives without admitting sibling paths', () => {
		const rationale = {
			...candidate('rationale', 'Prefer a thin archive adapter'),
			memory: {
				...memory('rationale'),
				text: 'Prefer a thin archive adapter',
				rationale: 'src/archive-reader.ts must remain independent of networking.',
			},
		};
		const alternative = {
			...candidate('alternative', 'The previous adapter was not selected'),
			memory: {
				...memory('alternative'),
				text: 'The previous adapter was not selected',
				alternatives: ['src/archive-reader.ts'],
			},
		};
		const sibling = {
			...candidate('sibling', 'Prefer a thin archive adapter'),
			memory: {
				...memory('sibling'),
				text: 'Prefer a thin archive adapter',
				rationale: 'src/archive-writer.ts controls exports.',
			},
		};
		const evidenceOnly = candidate('evidence-only', 'Prefer a thin archive adapter', true);
		evidenceOnly.memory.evidence[0].sourceId = 'src/archive-reader.ts';
		expect(
			shortlistMemoryCandidates(
				[sibling, evidenceOnly, rationale, alternative],
				'src/archive-reader.ts'
			).map((row) => row.memory.id)
		).toEqual(['rationale', 'alternative']);
		expect(
			rankRelevantMemoryCandidates([rationale, alternative], []).map((row) => row.memory.id)
		).toEqual([]);
	});
	it('preserves both requested files and treats units as semantic content, not paths', () => {
		const rows = [
			candidate('read', 'src/read.ts reads'),
			candidate('write', 'src/write.ts writes'),
		];
		expect(
			shortlistMemoryCandidates(rows, 'Compare src/read.ts and src/write.ts').map(
				(row) => row.memory.id
			)
		).toEqual(['read', 'write']);
		expect(
			shortlistMemoryCandidates(
				[candidate('rate', 'Permit sixty calls per minute')],
				'60 requests/min'
			).map((row) => row.memory.id)
		).toEqual(['rate']);
	});
	it('orders semantic evidence ahead of pinned background and uses metadata only for equal relevance', () => {
		const direct = candidate('direct', 'Choose an embedded store');
		direct.memory.status = 'proposed';
		const facet = candidate('facet', 'The store needs offline operation', true);
		expect(
			rankRelevantMemoryCandidates(
				[facet, direct],
				[
					{ id: 'facet', relevance: 1 },
					{ id: 'direct', relevance: 2 },
				],
				1
			).map((row) => row.memory.id)
		).toEqual(['direct']);
		expect(
			rankRelevantMemoryCandidates(
				[facet, direct],
				[
					{ id: 'facet', relevance: 2 },
					{ id: 'direct', relevance: 2 },
				],
				1
			).map((row) => row.memory.id)
		).toEqual(['facet']);
	});
	it('orders by rerank within relevance without admitting unselected candidates', () => {
		const direct = { ...candidate('direct', 'Use SQLite', true), rerankScore: 0.1 };
		const better = { ...candidate('better', 'Use the embedded SQLite store'), rerankScore: 0.9 };
		const facet = { ...candidate('facet', 'Storage must work offline'), rerankScore: 1 };
		expect(
			rankRelevantMemoryCandidates(
				[direct, better, facet],
				[
					{ id: 'direct', relevance: 2 },
					{ id: 'better', relevance: 2 },
					{ id: 'facet', relevance: 1 },
				]
			).map((row) => row.memory.id)
		).toEqual(['better', 'direct', 'facet']);
		expect(
			rankRelevantMemoryCandidates([direct, better], [{ id: 'direct', relevance: 2 }]).map(
				(row) => row.memory.id
			)
		).toEqual(['direct']);
	});
	it('deduplicates qualified assertions before final top-k without merging scopes, modalities or path case', () => {
		const first = candidate('first', 'SQLite storage', true);
		const duplicate = candidate('duplicate', 'SQLITE STORAGE');
		const project = candidate('project', 'SQLite storage');
		project.memory.projectId = 'synthetic-project';
		const proposed = candidate('proposed', 'SQLite storage');
		proposed.memory.status = 'proposed';
		const rows = [first, duplicate, project, proposed];
		expect(
			rankRelevantMemoryCandidates(
				rows,
				rows.map((row) => ({ id: row.memory.id, relevance: 2 as const })),
				3
			).map((row) => row.memory.id)
		).toEqual(['first', 'project', 'proposed']);
		const files = [
			candidate('upper', 'Use /opt/Reader.ts'),
			candidate('lower', 'Use /opt/reader.ts'),
		];
		expect(
			rankRelevantMemoryCandidates(
				files,
				files.map((row) => ({ id: row.memory.id, relevance: 2 as const }))
			).map((row) => row.memory.text)
		).toEqual(['Use /opt/Reader.ts', 'Use /opt/reader.ts']);
	});
	it('does not collapse distinct canonical reasons or alternatives behind the same decision text', () => {
		const offline = candidate('offline', 'Choose SQLite');
		offline.memory.rationale = 'Works without a network connection';
		const cost = candidate('cost', 'Choose SQLite');
		cost.memory.rationale = 'Avoids subscription fees';
		const alternative = candidate('alternative', 'Choose SQLite');
		alternative.memory.rationale = offline.memory.rationale;
		alternative.memory.alternatives = ['DuckDB'];
		const rows = [offline, cost, alternative];
		expect(
			rankRelevantMemoryCandidates(
				rows,
				rows.map((row) => ({ id: row.memory.id, relevance: 2 as const })),
				3
			).map((row) => row.memory.id)
		).toEqual(['offline', 'cost', 'alternative']);
	});
	it('lets exact-term evidence break a near-tie the embedding cannot separate', () => {
		// Two candidates the embedding places almost together. The lexical channel's
		// BM25 score is the real measure: the row that matched every query term
		// scores far better than the row that matched one.
		const exact = {
			...candidate('exact', 'Shared package helpers require lab-specific prefixes'),
			lexicalRank: 0,
			lexicalScore: -26.6,
			cosineDistance: 0.16,
		};
		const vague = {
			...candidate('vague', 'Shared package helper naming convention notes'),
			lexicalRank: 9,
			lexicalScore: -8.5,
			vectorRank: 0,
			cosineDistance: 0.1501,
		};
		expect(
			rankRelevantMemoryCandidates(
				[vague, exact],
				[
					{ id: 'vague', relevance: 2 },
					{ id: 'exact', relevance: 2 },
				],
				1
			).map((row) => row.memory.id)
		).toEqual(['exact']);
	});
	it('preserves intermediate lexical scores when normalizing the candidate spread', () => {
		const middle = {
			...candidate('middle'),
			cosineDistance: 0.21,
			lexicalScore: -20,
		};
		const weakest = {
			...candidate('weakest'),
			cosineDistance: 0.209,
			lexicalScore: -10,
		};
		// Cosine similarity is 1 - distance. The middle lexical score must break the near-tie.
		expect(compareMemoryCandidatesByGuardedPrior(middle, weakest, 0.8, -30, -10)).toBeLessThan(0);
	});
	it('keeps a clearly better embedding ahead of a weak lexical hit', () => {
		// The contract: a vector-only hit the embedding is confident about must not
		// be demoted below a weak mixed-channel lexical match.
		const strong = {
			...candidate('strong', 'Invented relay policy for delivery'),
			vectorRank: 0,
			cosineDistance: 0.0,
		};
		const weak = {
			...candidate('weak', 'Cobalt forwarding queue dashboard reference'),
			lexicalRank: 0,
			lexicalScore: -8.5,
			vectorRank: 7,
			cosineDistance: 1.8,
		};
		expect(
			rankRelevantMemoryCandidates(
				[weak, strong],
				[
					{ id: 'weak', relevance: 2 },
					{ id: 'strong', relevance: 2 },
				],
				1
			).map((row) => row.memory.id)
		).toEqual(['strong']);
	});
	it('rejects unknown/duplicate selections and malformed final limits rather than hydrating arbitrary IDs', () => {
		const rows = [candidate('one', 'SQLite storage')];
		expect(() => rankRelevantMemoryCandidates(rows, [{ id: 'invented', relevance: 2 }])).toThrow(
			'selection'
		);
		expect(() =>
			rankRelevantMemoryCandidates(rows, [
				{ id: 'one', relevance: 2 },
				{ id: 'one', relevance: 1 },
			])
		).toThrow('selection');
		expect(() => rankRelevantMemoryCandidates(rows, [], 0)).toThrow('limit');
		expect(memoryCosineSimilarity({ ...rows[0], cosineDistance: 1.8 })).toBeCloseTo(-0.8);
	});
	it('semantically merges all eligible candidates before the shortlist cap', () => {
		const lexical = Array.from({ length: 41 }, (_, index) => ({
			...candidate('lexical-' + index, 'Dashboard row ' + index, true),
			lexicalRank: index,
			cosineDistance: 0.8,
		}));
		const vectorOnly = {
			...candidate('vector-only', 'Relay handoff policy'),
			vectorRank: 0,
			cosineDistance: 0.01,
		};
		expect(
			shortlistMemoryCandidates([...lexical, vectorOnly], 'handoff policy', 1).map(
				(row) => row.memory.id
			)
		).toEqual(['vector-only']);
	});
	it('uses mixed-channel rank fusion only after semantic ties and does not spend slots on repeated assertions', () => {
		const first = {
			...candidate('first', 'Relay handoff policy', true),
			lexicalRank: 0,
			vectorRank: 0,
		};
		const duplicate = { ...candidate('duplicate', 'RELAY HANDOFF POLICY'), vectorRank: 0 };
		const vectorOnly = { ...candidate('vector-only', 'Relay retry window'), vectorRank: 1 };
		const rows = [duplicate, vectorOnly, first];
		expect(
			rankRelevantMemoryCandidates(
				rows,
				rows.map((row) => ({ id: row.memory.id, relevance: 1 as const })),
				2
			).map((row) => row.memory.id)
		).toEqual(['first', 'vector-only']);
	});
});
