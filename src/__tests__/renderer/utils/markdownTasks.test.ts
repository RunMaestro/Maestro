import { describe, it, expect } from 'vitest';
import { toggleTaskCheckboxAtLine } from '../../../renderer/utils/markdownTasks';

describe('toggleTaskCheckboxAtLine', () => {
	it('checks an open task and reports the new state', () => {
		const result = toggleTaskCheckboxAtLine('# Notes\n- [ ] call the clerk\n', 2);
		expect(result).toEqual({ content: '# Notes\n- [x] call the clerk\n', checked: true });
	});

	it('unchecks a closed task, accepting an uppercase marker', () => {
		const result = toggleTaskCheckboxAtLine('- [X] shipped\n', 1);
		expect(result).toEqual({ content: '- [ ] shipped\n', checked: false });
	});

	it('preserves indentation, bullet style, and spacing', () => {
		const result = toggleTaskCheckboxAtLine('\t\t*   [ ]  nested task', 1);
		expect(result?.content).toBe('\t\t*   [x]  nested task');
	});

	it('toggles ordered-list tasks', () => {
		const result = toggleTaskCheckboxAtLine('1. [ ] first step', 1);
		expect(result?.content).toBe('1. [x] first step');
	});

	it('leaves CRLF line endings intact', () => {
		const result = toggleTaskCheckboxAtLine('- [ ] a\r\n- [ ] b\r\n', 2);
		expect(result?.content).toBe('- [ ] a\r\n- [x] b\r\n');
	});

	it('only rewrites the requested line when the text repeats', () => {
		const content = '- [ ] same text\n- [ ] same text\n- [ ] same text';
		expect(toggleTaskCheckboxAtLine(content, 2)?.content).toBe(
			'- [ ] same text\n- [x] same text\n- [ ] same text'
		);
	});

	it('returns null for a line with no task marker', () => {
		expect(toggleTaskCheckboxAtLine('# Notes\n- plain bullet\n', 2)).toBeNull();
		expect(toggleTaskCheckboxAtLine('a [ ] not a task', 1)).toBeNull();
	});

	it('returns null for out-of-range and invalid line numbers', () => {
		expect(toggleTaskCheckboxAtLine('- [ ] only line', 2)).toBeNull();
		expect(toggleTaskCheckboxAtLine('- [ ] only line', 0)).toBeNull();
		expect(toggleTaskCheckboxAtLine('- [ ] only line', 1.5)).toBeNull();
	});
});
