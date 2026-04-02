import { autorunDefaultPrompt } from '../prompts';
import type { PlaybookPromptProfile } from './types';

export const FULL_AUTORUN_PROMPT = autorunDefaultPrompt;

export const COMPACT_CODE_AUTORUN_PROMPT = `You are running in Maestro Auto Run for a coding task.

Complete only the next active unchecked task.

Rules:
- Read files on disk as needed; do not rely only on the inlined context.
- Make the smallest change that fully satisfies the task.
- Run the lightest relevant verification after editing.
- Update the Auto Run document by checking the completed task or adding a brief blocker note.
- Stop after finishing the active task.`;

export const COMPACT_DOC_AUTORUN_PROMPT = `You are running in Maestro Auto Run for a documentation task.

Complete only the next active unchecked task.

Rules:
- Keep the change scoped to the active task.
- Preserve existing structure and terminology unless the task requires changes.
- Update the Auto Run document by checking the completed task or adding a brief blocker note.
- Stop after finishing the active task.`;

export function getDefaultPlaybookPrompt(
	profile: PlaybookPromptProfile = 'compact-code'
): string {
	switch (profile) {
		case 'full':
			return FULL_AUTORUN_PROMPT;
		case 'compact-doc':
			return COMPACT_DOC_AUTORUN_PROMPT;
		case 'compact-code':
		default:
			return COMPACT_CODE_AUTORUN_PROMPT;
	}
}

export function getPlaybookPromptForExecution(
	prompt: string | null | undefined,
	profile: PlaybookPromptProfile = 'compact-code'
): string {
	if (prompt && prompt.trim()) {
		return prompt;
	}

	return getDefaultPlaybookPrompt(profile);
}

export function inferPlaybookPromptProfile(
	prompt: string | null | undefined
): PlaybookPromptProfile {
	const trimmedPrompt = prompt?.trim();
	if (!trimmedPrompt) {
		return 'compact-code';
	}

	if (trimmedPrompt === FULL_AUTORUN_PROMPT.trim()) {
		return 'full';
	}

	if (trimmedPrompt === COMPACT_DOC_AUTORUN_PROMPT.trim()) {
		return 'compact-doc';
	}

	if (trimmedPrompt === COMPACT_CODE_AUTORUN_PROMPT.trim()) {
		return 'compact-code';
	}

	return 'full';
}

export function normalizePlaybookPromptForStorage(
	prompt: string | null | undefined,
	profile: PlaybookPromptProfile = 'compact-code'
): string {
	const rawPrompt = prompt ?? '';
	const trimmedPrompt = rawPrompt.trim();
	if (!trimmedPrompt) {
		return '';
	}

	return trimmedPrompt === getDefaultPlaybookPrompt(profile).trim() ? '' : rawPrompt;
}
