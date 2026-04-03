import { describe, expect, it } from 'vitest';
import {
	buildImplicitTaskGraph,
	DEFAULT_AUTORUN_SKILLS,
	doesPlaybookTaskGraphMatchDocuments,
	normalizePlaybookDagFields,
	normalizePlaybookSkills,
	resolvePlaybookTaskGraph,
	validatePlaybookDag,
} from '../../shared/playbookDag';

describe('playbookDag helpers', () => {
	it('builds an implicit linear graph from documents', () => {
		const graph = buildImplicitTaskGraph([
			{ filename: 'phase-01.md' },
			{ filename: 'phase-02.md' },
			{ filename: 'phase-03.md' },
		]);

		expect(graph.nodes).toEqual([
			{ id: 'phase-01', documentIndex: 0, dependsOn: [] },
			{ id: 'phase-02', documentIndex: 1, dependsOn: ['phase-01'] },
			{ id: 'phase-03', documentIndex: 2, dependsOn: ['phase-02'] },
		]);
	});

	it('derives stable node ids for duplicate legacy document filenames', () => {
		const graph = buildImplicitTaskGraph([
			{ filename: 'phase-01.md' },
			{ filename: 'phase-01.md' },
			{ filename: 'nested/phase-01.md' },
		]);

		expect(graph.nodes).toEqual([
			{ id: 'phase-01', documentIndex: 0, dependsOn: [] },
			{ id: 'phase-01-2', documentIndex: 1, dependsOn: ['phase-01'] },
			{ id: 'nested-phase-01', documentIndex: 2, dependsOn: ['phase-01-2'] },
		]);
	});

	it('normalizes playbook skills and always prepends Auto Run defaults once', () => {
		expect(normalizePlaybookSkills(['gitnexus', 'custom-skill', 'Context-And-Impact'])).toEqual([
			...DEFAULT_AUTORUN_SKILLS,
			'custom-skill',
		]);
	});

	it('normalizes missing graph and maxParallelism for persisted playbooks', () => {
		const normalized = normalizePlaybookDagFields({
			documents: [{ filename: 'phase-01.md' }, { filename: 'phase-02.md' }],
			skills: [],
			maxParallelism: null,
		});

		expect(normalized.maxParallelism).toBe(1);
		expect(normalized.skills).toEqual([...DEFAULT_AUTORUN_SKILLS]);
		expect(normalized.taskGraph.nodes).toHaveLength(2);
		expect(normalized.taskGraph.nodes[1]).toMatchObject({
			documentIndex: 1,
			dependsOn: [normalized.taskGraph.nodes[0].id],
		});
	});

	it('falls back to the implicit graph when an existing graph no longer matches the document set', () => {
		const documents = [{ filename: 'phase-01.md' }, { filename: 'phase-02.md' }];
		const staleGraph = {
			nodes: [{ id: 'phase-01', documentIndex: 0, dependsOn: [] }],
		};

		expect(doesPlaybookTaskGraphMatchDocuments(documents, staleGraph)).toBe(false);
		expect(resolvePlaybookTaskGraph(documents, staleGraph)).toEqual(
			buildImplicitTaskGraph(documents)
		);
	});

	it('rejects duplicate node ids, missing dependencies, same-document refs, cycles, illegal forward links, and invalid maxParallelism', () => {
		const result = validatePlaybookDag(
			[{ filename: 'phase-01.md' }, { filename: 'phase-02.md' }, { filename: 'phase-03.md' }],
			{
				nodes: [
					{ id: 'dup', documentIndex: 0, dependsOn: ['dup', 'phase-03'] },
					{ id: 'dup', documentIndex: 0, dependsOn: ['missing'] },
					{ id: 'phase-03', documentIndex: 2, dependsOn: [] },
				],
			},
			0
		);

		expect(result.valid).toBe(false);
		expect(result.errors).toEqual(
			expect.arrayContaining([
				'maxParallelism must be a positive integer.',
				'Duplicate taskGraph node id: dup',
				'Multiple taskGraph nodes reference documentIndex 0.',
				'Missing taskGraph node for documentIndex 1.',
				'Node "dup" has an illegal cross-document dependency on "phase-03" that points forward in document order.',
				'Node "dup" cannot depend on itself.',
				'Node "dup" depends on missing node "missing".',
				'taskGraph contains a dependency cycle.',
			])
		);
	});

	it('accepts an explicit DAG with fan-out dependencies', () => {
		const result = validatePlaybookDag(
			[{ filename: 'phase-01.md' }, { filename: 'phase-02.md' }, { filename: 'phase-03.md' }],
			{
				nodes: [
					{ id: 'root', documentIndex: 0, dependsOn: [] },
					{ id: 'left', documentIndex: 1, dependsOn: ['root'] },
					{ id: 'right', documentIndex: 2, dependsOn: ['root'] },
				],
			},
			2
		);

		expect(result).toEqual({ valid: true, errors: [] });
	});
});
