import { describe, expect, it } from 'vitest';
import { buildPrefilledIssueUrl, MAX_PREFILLED_ISSUE_URL_LENGTH } from '../../shared/feedback';

describe('buildPrefilledIssueUrl', () => {
	it('prefills title, body, and label on the new-issue page', () => {
		const url = new URL(buildPrefilledIssueUrl('Bug: thing', 'line one\nline & two'));
		expect(url.origin + url.pathname).toBe('https://github.com/RunMaestro/Maestro/issues/new');
		expect(url.searchParams.get('title')).toBe('Bug: thing');
		expect(url.searchParams.get('body')).toBe('line one\nline & two');
		expect(url.searchParams.get('labels')).toBe('Maestro-feedback');
	});

	it('cuts a long body to fit, keeps the title, and says it was cut', () => {
		// Multi-byte text encodes to several escapes per character, which is
		// what makes a naive length check overshoot.
		const body = 'déjà vu 😀 '.repeat(5000);
		const result = buildPrefilledIssueUrl('Bug: long', body);
		expect(result.length).toBeLessThanOrEqual(MAX_PREFILLED_ISSUE_URL_LENGTH);
		const url = new URL(result);
		expect(url.searchParams.get('title')).toBe('Bug: long');
		expect(url.searchParams.get('body')).toContain('Truncated to fit in a URL');
		expect(body.startsWith(url.searchParams.get('body')!.split('\n\n_(Truncated')[0])).toBe(true);
	});
});
