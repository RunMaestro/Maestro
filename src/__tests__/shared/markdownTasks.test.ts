import { describe, expect, it } from 'vitest';
import {
	countCheckedMarkdownTasks,
	countMarkdownTasks,
	countUncheckedMarkdownTasks,
	extractUncheckedMarkdownTasks,
	getMarkdownLines,
	uncheckAllMarkdownTasks,
} from '../../shared/markdownTasks';

describe('markdownTasks', () => {
	it('counts and extracts tasks only outside fenced code blocks', () => {
		const content = `# Plan
- [ ] Real task
- [x] Done task

\`\`\`markdown
- [ ] Backtick example
\`\`\`

~~~md
* [ ] Tilde example
~~~

* [ ] Another real task`;

		expect(countUncheckedMarkdownTasks(content)).toBe(2);
		expect(countCheckedMarkdownTasks(content)).toBe(1);
		expect(countMarkdownTasks(content)).toEqual({ completed: 1, total: 3 });
		expect(extractUncheckedMarkdownTasks(content)).toEqual(['Real task', 'Another real task']);
	});

	it('requires a closing fence to match the opener character and minimum length', () => {
		const content = `- [ ] Before
\`\`\`\`markdown
\`\`\`
- [ ] Still fenced
~~~
- [ ] Also fenced
\`\`\`\`
- [ ] After`;

		expect(extractUncheckedMarkdownTasks(content)).toEqual(['Before', 'After']);
	});

	it('accepts a closing fence longer than the opener', () => {
		const content = `~~~
- [ ] Fenced
~~~~
- [ ] Outside`;

		expect(extractUncheckedMarkdownTasks(content)).toEqual(['Outside']);
	});

	it('supports plus bullets and checkmark completion markers', () => {
		const content = ['+ [ ] Plus task', '+ [✓] Checked task', '* [✔] Heavy checked task'].join(
			'\n'
		);

		expect(countUncheckedMarkdownTasks(content)).toBe(1);
		expect(countCheckedMarkdownTasks(content)).toBe(2);
		expect(countMarkdownTasks(content)).toEqual({ completed: 2, total: 3 });
		expect(extractUncheckedMarkdownTasks(content)).toEqual(['Plus task']);
		expect(uncheckAllMarkdownTasks(content)).toBe(
			['+ [ ] Plus task', '+ [ ] Checked task', '* [ ] Heavy checked task'].join('\n')
		);
	});

	it('normalizes CRLF and lone CR line endings for classification', () => {
		const content = '- [ ] First\r\n+ [x] Second\r* [ ] Third';

		expect(getMarkdownLines(content).map(({ line }) => line)).toEqual([
			'- [ ] First',
			'+ [x] Second',
			'* [ ] Third',
		]);
		expect(countMarkdownTasks(content)).toEqual({ completed: 1, total: 3 });
	});

	it('exposes fence and task state for shared line consumers', () => {
		const content = ['- [ ] Before', '```', '- [x] Example', '```', '+ [✓] After'].join('\n');

		expect(
			getMarkdownLines(content).map(({ isOutsideFence, taskState }) => ({
				isOutsideFence,
				taskState,
			}))
		).toEqual([
			{ isOutsideFence: true, taskState: 'unchecked' },
			{ isOutsideFence: false, taskState: null },
			{ isOutsideFence: false, taskState: null },
			{ isOutsideFence: false, taskState: null },
			{ isOutsideFence: true, taskState: 'checked' },
		]);
	});

	it('does not uncheck completed tasks inside fenced code blocks', () => {
		const content = `- [x] Real task

\`\`\`
- [x] Example task
\`\`\``;

		expect(uncheckAllMarkdownTasks(content)).toBe(`- [ ] Real task

\`\`\`
- [x] Example task
\`\`\``);
	});

	it('preserves mixed line endings when unchecking tasks', () => {
		const content = '- [x] CRLF\r\n+ [✓] CR\r* [X] LF\n- [ ] Pending';

		expect(uncheckAllMarkdownTasks(content)).toBe(
			'- [ ] CRLF\r\n+ [ ] CR\r* [ ] LF\n- [ ] Pending'
		);
	});
});
