import { describe, expect, it } from 'vitest';
import {
	COMPACT_CODE_AUTORUN_PROMPT,
	COMPACT_DOC_AUTORUN_PROMPT,
	FULL_AUTORUN_PROMPT,
	getDefaultPlaybookPrompt,
	getPlaybookPromptForExecution,
	inferPlaybookPromptProfile,
	normalizePlaybookPromptForStorage,
} from '../../shared/playbookPromptUtils';

describe('playbookPromptUtils', () => {
	it('returns the correct default prompt for each profile', () => {
		expect(getDefaultPlaybookPrompt('full')).toBe(FULL_AUTORUN_PROMPT);
		expect(getDefaultPlaybookPrompt('compact-code')).toBe(COMPACT_CODE_AUTORUN_PROMPT);
		expect(getDefaultPlaybookPrompt('compact-doc')).toBe(COMPACT_DOC_AUTORUN_PROMPT);
	});

	it('falls back to the profile default when prompt is empty', () => {
		expect(getPlaybookPromptForExecution('', 'compact-code')).toBe(COMPACT_CODE_AUTORUN_PROMPT);
		expect(getPlaybookPromptForExecution('', 'compact-doc')).toBe(COMPACT_DOC_AUTORUN_PROMPT);
		expect(getPlaybookPromptForExecution('', 'full')).toBe(FULL_AUTORUN_PROMPT);
	});

	it('infers prompt profile from known default prompt bodies', () => {
		expect(inferPlaybookPromptProfile(FULL_AUTORUN_PROMPT)).toBe('full');
		expect(inferPlaybookPromptProfile(COMPACT_CODE_AUTORUN_PROMPT)).toBe('compact-code');
		expect(inferPlaybookPromptProfile(COMPACT_DOC_AUTORUN_PROMPT)).toBe('compact-doc');
		expect(inferPlaybookPromptProfile('Custom prompt')).toBe('full');
		expect(inferPlaybookPromptProfile('')).toBe('compact-code');
	});

	it('stores empty prompt when the prompt matches the selected profile default', () => {
		expect(normalizePlaybookPromptForStorage(FULL_AUTORUN_PROMPT, 'full')).toBe('');
		expect(normalizePlaybookPromptForStorage(COMPACT_CODE_AUTORUN_PROMPT, 'compact-code')).toBe('');
		expect(normalizePlaybookPromptForStorage(COMPACT_DOC_AUTORUN_PROMPT, 'compact-doc')).toBe('');
		expect(normalizePlaybookPromptForStorage('Custom prompt', 'compact-doc')).toBe('Custom prompt');
	});
});
