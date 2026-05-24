import { describe, expect, it } from 'vitest';
import {
	countCheckedMarkdownTasks,
	countMarkdownTasks,
	countUncheckedMarkdownTasks,
	extractUncheckedMarkdownTasks,
	uncheckAllMarkdownTasks,
} from '../../shared/markdownTasks';

describe('markdownTasks', () => {
	it('counts checked and unchecked tasks outside fenced code blocks', () => {
		const content = `# Plan
- [ ] Real task
- [x] Done task

\`\`\`markdown
- [ ] Example task
- [x] Example done
\`\`\`

~~~md
- [ ] Tilde example
~~~

  - [ ] Nested real task`;

		expect(countUncheckedMarkdownTasks(content)).toBe(2);
		expect(countCheckedMarkdownTasks(content)).toBe(1);
		expect(countMarkdownTasks(content)).toEqual({ completed: 1, total: 3 });
	});

	it('extracts unchecked task text outside fenced code blocks', () => {
		const content = `- [ ] First task

\`\`\`
- [ ] Example task
\`\`\`

* [ ] Second task`;

		expect(extractUncheckedMarkdownTasks(content)).toEqual(['First task', 'Second task']);
	});

	it('unchecks completed tasks without modifying fenced examples', () => {
		const content = `- [x] Real task
- [X] Another real task

\`\`\`markdown
- [x] Example task
\`\`\``;

		expect(uncheckAllMarkdownTasks(content)).toBe(`- [ ] Real task
- [ ] Another real task

\`\`\`markdown
- [x] Example task
\`\`\``);
	});
});
