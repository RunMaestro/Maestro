/**
 * The instruction block a playbook's task-selection mode splices into `{{TASK_SELECTION_BLOCK}}`.
 *
 * Twin of `getTaskSelectionBlock` in the desktop's `batchUtils`. The block is spliced into the
 * middle of a numbered list, so it has to lose its trailing whitespace the same way: a trailing
 * newline would insert a blank line between step 2 and step 3. Defaults to per-task, which is what
 * a playbook that predates the setting was written against.
 */

import { describeSegmentLimit } from '../../autorunModelHints';
import { PROMPT_IDS, type PromptId } from '../../promptDefinitions';

export async function buildTaskSelectionBlock(
	loadPrompt: (id: PromptId) => Promise<string>,
	mode: 'task' | 'document' | undefined,
	segment?: { count: number; total: number }
): Promise<string> {
	const id = mode === 'document' ? PROMPT_IDS.AUTORUN_PER_DOCUMENT : PROMPT_IDS.AUTORUN_PER_TASK;
	const block = (await loadPrompt(id)).replace(/\s+$/, '');
	if (mode !== 'document') return block;
	return `${block}${describeSegmentLimit(segment)}`;
}
