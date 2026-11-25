import { describe, it, expect } from 'vitest';
import { buildSideQuestionPrompt, parseSideQuestion } from '../../shared/sideQuestion';

describe('parseSideQuestion', () => {
	it('returns the question after /btw', () => {
		expect(parseSideQuestion('/btw what did we rename?')).toBe('what did we rename?');
		expect(parseSideQuestion('  /btw   spaced out  ')).toBe('spaced out');
		expect(parseSideQuestion('/btw\nmulti\nline')).toBe('multi\nline');
	});

	it('returns an empty question for a bare /btw', () => {
		expect(parseSideQuestion('/btw')).toBe('');
	});

	it('ignores anything that is not the /btw command', () => {
		expect(parseSideQuestion('/btwx hello')).toBeNull();
		expect(parseSideQuestion('btw hello')).toBeNull();
		expect(parseSideQuestion('/history')).toBeNull();
	});
});

describe('buildSideQuestionPrompt', () => {
	it('frames the question so a mid-task session answers instead of resuming work', () => {
		const prompt = buildSideQuestionPrompt('which test failed?');
		expect(prompt).toContain('<side-question>');
		expect(prompt).toContain('Do not use tools');
		expect(prompt.endsWith('which test failed?')).toBe(true);
	});
});
