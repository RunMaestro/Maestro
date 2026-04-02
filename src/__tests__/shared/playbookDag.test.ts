import { describe, expect, it } from 'vitest';
import {
	buildImplicitTaskGraph,
	DEFAULT_AUTORUN_SKILLS,
	normalizePlaybookDagFields,
	normalizePlaybookSkills,
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

	it('rejects duplicate node ids, missing dependencies, same-document refs, cycles, and invalid maxParallelism', () => {
		const result = validatePlaybookDag(
			[{ filename: 'phase-01.md' }, { filename: 'phase-02.md' }],
			{
				nodes: [
					{ id: 'dup', documentIndex: 0, dependsOn: ['dup'] },
					{ id: 'dup', documentIndex: 0, dependsOn: ['missing'] },
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
