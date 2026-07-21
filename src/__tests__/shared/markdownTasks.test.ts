import { describe, expect, it } from 'vitest';
import {
	countCheckedMarkdownTasks,
	countMarkdownTasks,
	countUncheckedMarkdownTasks,
	extractUncheckedMarkdownTasks,
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
});
