import { describe, expect, it } from 'vitest';
import {
	buildImageInsertion,
	continueMarkdownList,
	insertCheckboxAtCursor,
	insertTextAtSelection,
} from '../../../../../renderer/components/Wizard/shared/DocumentEditor';

describe('DocumentEditor command helpers', () => {
	it('inserts text at a selection and returns the next cursor position', () => {
		expect(insertTextAtSelection('hello world', 6, 11, 'Maestro')).toEqual({
			content: 'hello Maestro',
			cursorPosition: 13,
		});
	});

	it('inserts checkboxes on empty and populated lines', () => {
		expect(insertCheckboxAtCursor('', 0)).toEqual({
			content: '- [ ] ',
			cursorPosition: 6,
		});
		expect(insertCheckboxAtCursor('# Heading', 9)).toEqual({
			content: '# Heading\n- [ ] ',
			cursorPosition: 16,
		});
	});

	it('continues task lists and unordered lists', () => {
		expect(continueMarkdownList('- [ ] First', 11)).toEqual({
			content: '- [ ] First\n- [ ] ',
			cursorPosition: 18,
		});
		expect(continueMarkdownList('  * Item', 8)).toEqual({
			content: '  * Item\n  * ',
			cursorPosition: 13,
		});
		expect(continueMarkdownList('plain text', 10)).toBeNull();
	});

	it('inserts image markdown with newlines only when needed', () => {
		expect(buildImageInsertion('# Hi', 4, 'a.png', 'images/a.png')).toEqual({
			content: '# Hi\n![a.png](images/a.png)',
			cursorPosition: 27,
		});
		expect(buildImageInsertion('# Hi\n', 5, 'a.png', 'images/a.png')).toEqual({
			content: '# Hi\n![a.png](images/a.png)',
			cursorPosition: 27,
		});
		expect(buildImageInsertion('beforeafter', 6, 'a.png', 'images/a.png')).toEqual({
			content: 'before\n![a.png](images/a.png)\nafter',
			cursorPosition: 30,
		});
	});
});
