import { describe, it, expect } from 'vitest';
import { describeModelsRefresh, summarizeModelsRefresh } from '../../shared/agentModelsRefresh';

describe('summarizeModelsRefresh', () => {
	it('reports the new total and which models came and went', () => {
		expect(
			summarizeModelsRefresh(['ollama/a', 'ollama/b'], ['ollama/a', 'ollama/c', 'ollama/d'])
		).toEqual({ total: 3, added: ['ollama/c', 'ollama/d'], removed: ['ollama/b'] });
	});

	it('does not count the "" agent-default sentinel as a model', () => {
		expect(summarizeModelsRefresh([''], ['', 'ollama/a'])).toEqual({
			total: 1,
			added: ['ollama/a'],
			removed: [],
		});
	});
});

describe('describeModelsRefresh', () => {
	it('names only the changes that happened', () => {
		expect(describeModelsRefresh({ total: 14, added: [], removed: [] })).toBe('14 models');
		expect(describeModelsRefresh({ total: 1, added: ['a'], removed: [] })).toBe('1 model, 1 new');
		expect(describeModelsRefresh({ total: 3, added: ['a', 'b'], removed: ['c'] })).toBe(
			'3 models, 2 new, 1 gone'
		);
	});
});
