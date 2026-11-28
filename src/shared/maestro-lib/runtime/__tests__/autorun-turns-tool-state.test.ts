import { describe, expect, it } from 'vitest';
import { toolStateOf } from '../autorun-turns';

describe('toolStateOf', () => {
	it("puts a call's raw arguments under input, as the desktop's tool events carry them", () => {
		expect(
			toolStateOf({ name: 'Read', status: 'running', detail: { file_path: '/w/a.ts' } })
		).toEqual({
			status: 'running',
			input: { file_path: '/w/a.ts' },
		});
		expect(toolStateOf({ name: 'Bash', status: 'running' })).toEqual({ status: 'running' });
	});

	it("keeps a provider's own state as it is", () => {
		const state = { status: 'completed', input: { command: 'ls' }, output: 'a' };
		expect(toolStateOf({ name: 'Bash', status: 'completed', detail: state })).toBe(state);
	});
});
