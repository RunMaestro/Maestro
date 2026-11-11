/**
 * Turning an Auto Run prompt template into the text a task turn starts from.
 *
 * Both engines do this: the desktop's `useDocumentProcessor` and the shared engine's
 * `runPlaybook`. Each used to splice the task-selection block in by hand, which is how they could
 * drift, so the rule lives here.
 *
 * A playbook's own prompt (an Exchange manifest's `prompt`, or one a user saved) replaces the
 * default Auto Run prompt whole. The default carries the two things a run depends on: which tasks
 * to work (`{{TASK_SELECTION_BLOCK}}`) and which file they are in (`{{DOCUMENT_PATH}}`, in the
 * `autorun-document` block). Where the document is not pasted into the prompt, a custom prompt
 * that never names `{{DOCUMENT_PATH}}` sent the agent off with no task document and no instruction
 * to check boxes: on the Agent Memory Exchange playbook the run ticked 0 of 74 tasks, then stalled.
 *
 * So a custom prompt ADDS to the default's task plumbing instead of silently replacing it:
 *
 * - A template that names `{{DOCUMENT_PATH}}` was written for the run. It is left as it is.
 * - One that does not gets the selection block (unless it already has its own placeholder) and
 *   the document block appended, after a rule.
 *
 * Variables inside the result (`{{DOCUMENT_PATH}}` and the rest) are left for the caller's
 * template-variable pass, which runs after this.
 */

const TASK_SELECTION_PLACEHOLDER = /\{\{TASK_SELECTION_BLOCK\}\}/i;
const DOCUMENT_PATH_PLACEHOLDER = /\{\{DOCUMENT_PATH\}\}/i;

export interface AutoRunPromptBlocks {
	/** The resolved task-selection block for the run's mode (`autorun-per-task` / `-per-document`). */
	selectionBlock: string;
	/**
	 * The `autorun-document` block, which names `{{DOCUMENT_PATH}}`. `null` when the engine puts
	 * the document in the prompt itself (the CLI policy's `inlineDocument`): nothing is appended.
	 */
	documentBlock: string | null;
}

/** Whether a prompt template tells the agent which document to work. */
export function namesAutoRunDocument(template: string): boolean {
	return DOCUMENT_PATH_PLACEHOLDER.test(template);
}

export function resolveAutoRunPromptTemplate(
	template: string,
	{ selectionBlock, documentBlock }: AutoRunPromptBlocks
): string {
	const hasSelectionPlaceholder = TASK_SELECTION_PLACEHOLDER.test(template);
	// A replacer function, so a `$` in a customized block is never read as a replacement pattern.
	const resolved = template.replace(
		new RegExp(TASK_SELECTION_PLACEHOLDER.source, 'gi'),
		() => selectionBlock
	);
	if (documentBlock === null || namesAutoRunDocument(template)) return resolved;

	const missing = [hasSelectionPlaceholder ? '' : selectionBlock, documentBlock]
		.map((block) => block.trim())
		.filter(Boolean);
	if (missing.length === 0) return resolved;
	return `${resolved.trimEnd()}\n\n---\n\n${missing.join('\n\n')}\n`;
}
