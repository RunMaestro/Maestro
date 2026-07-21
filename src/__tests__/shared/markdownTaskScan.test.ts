import { describe, expect, it } from 'vitest';
import {
	countMarkdownTasks,
	extractUncheckedMarkdownTasks,
	forEachMarkdownLine,
	uncheckAllMarkdownTasks,
} from '../../shared/markdownTaskScan';

describe('markdownTaskScan', () => {
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

		expect(countMarkdownTasks(content)).toEqual({ checked: 1, unchecked: 2, total: 3 });
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

		expect(countMarkdownTasks(content)).toEqual({ checked: 2, unchecked: 1, total: 3 });
		expect(extractUncheckedMarkdownTasks(content)).toEqual(['Plus task']);
		expect(uncheckAllMarkdownTasks(content)).toBe(
			['+ [ ] Plus task', '+ [ ] Checked task', '* [ ] Heavy checked task'].join('\n')
		);
	});

	it('normalizes CRLF and lone CR line endings for classification', () => {
		const content = '- [ ] First\r\n+ [x] Second\r* [ ] Third';

		const lines: string[] = [];
		forEachMarkdownLine(content, (line) => {
			lines.push(line);
		});

		expect(lines).toEqual(['- [ ] First', '+ [x] Second', '* [ ] Third']);
		expect(countMarkdownTasks(content)).toEqual({ checked: 1, unchecked: 2, total: 3 });
	});

	it('visits only lines outside fences with normalized line indexes', () => {
		const visited: Array<{ line: string; index: number }> = [];
		const content = '- [ ] Before\r\n```\r- [x] Example\n```\r\n+ [✓] After';

		forEachMarkdownLine(content, (line, index) => {
			visited.push({ line, index });
		});

		expect(visited).toEqual([
			{ line: '- [ ] Before', index: 0 },
			{ line: '+ [✓] After', index: 4 },
		]);
	});

	it('requires CommonMark indentation and valid backtick info strings', () => {
		const content = [
			'    ```markdown',
			'- [ ] Not fenced by four-space indent',
			'```bad`info',
			'- [ ] Not fenced by invalid info string',
		].join('\n');

		expect(extractUncheckedMarkdownTasks(content)).toEqual([
			'Not fenced by four-space indent',
			'Not fenced by invalid info string',
		]);
	});

	it('does not close a fence when the delimiter has an info string', () => {
		const content = ['```markdown', '- [ ] Fenced', '```still-open', '- [ ] Also fenced'].join(
			'\n'
		);

		expect(countMarkdownTasks(content)).toEqual({ checked: 0, unchecked: 0, total: 0 });
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
