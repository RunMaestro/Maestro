/**
 * A custom Auto Run prompt adds to the default's task plumbing instead of replacing it.
 *
 * The regression: an Exchange playbook's `prompt` named neither the selection block nor
 * `{{DOCUMENT_PATH}}`, the desktop does not paste the document in, and the agent got no task
 * document at all.
 */
import { describe, expect, it } from 'vitest';

import {
	namesAutoRunDocument,
	resolveAutoRunPromptTemplate,
} from '../../shared/autorunPromptTemplate';

const SELECTION = '2. Task Selection\n   Process the FIRST unchecked task.';
const DOCUMENT = '## Tasks\n\nProcess tasks from this document:\n\n{{DOCUMENT_PATH}}\n';
const blocks = { selectionBlock: SELECTION, documentBlock: DOCUMENT };

describe('resolveAutoRunPromptTemplate', () => {
	it('appends the selection and document blocks to a prompt that names neither', () => {
		const out = resolveAutoRunPromptTemplate('You are a memory curator.\n\n', blocks);
		expect(out).toBe(`You are a memory curator.\n\n---\n\n${SELECTION}\n\n${DOCUMENT.trim()}\n`);
	});

	it('appends only the document block when the prompt places its own selection block', () => {
		const out = resolveAutoRunPromptTemplate('Intro\n\n{{TASK_SELECTION_BLOCK}}\n\nOutro', blocks);
		expect(out).toBe(`Intro\n\n${SELECTION}\n\nOutro\n\n---\n\n${DOCUMENT.trim()}\n`);
	});

	it('leaves a prompt that names the document alone, apart from the selection splice', () => {
		const template = 'Step 1\n\n{{task_selection_block}}\n\nWork {{DOCUMENT_PATH}}.';
		expect(resolveAutoRunPromptTemplate(template, blocks)).toBe(
			`Step 1\n\n${SELECTION}\n\nWork {{DOCUMENT_PATH}}.`
		);
		// No selection placeholder either: the author took full control, so nothing is added.
		expect(resolveAutoRunPromptTemplate('Work {{document_path}}.', blocks)).toBe(
			'Work {{document_path}}.'
		);
	});

	it('appends nothing when the engine inlines the document itself', () => {
		expect(
			resolveAutoRunPromptTemplate('Custom prompt', {
				selectionBlock: SELECTION,
				documentBlock: null,
			})
		).toBe('Custom prompt');
	});

	it('appends nothing when both blocks are empty', () => {
		expect(
			resolveAutoRunPromptTemplate('Custom prompt', { selectionBlock: '', documentBlock: '' })
		).toBe('Custom prompt');
	});

	it('splices a block containing `$` patterns literally', () => {
		const out = resolveAutoRunPromptTemplate('{{TASK_SELECTION_BLOCK}} {{DOCUMENT_PATH}}', {
			selectionBlock: 'cost $& and $1',
			documentBlock: DOCUMENT,
		});
		expect(out).toBe('cost $& and $1 {{DOCUMENT_PATH}}');
	});
});

describe('namesAutoRunDocument', () => {
	it('matches the placeholder in any case', () => {
		expect(namesAutoRunDocument('read {{Document_Path}}')).toBe(true);
		expect(namesAutoRunDocument('read the document')).toBe(false);
	});
});
