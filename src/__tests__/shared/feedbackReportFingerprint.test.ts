import { describe, expect, it } from 'vitest';
import { feedbackReportFingerprint } from '../../shared/feedback';

const base = {
	category: 'bug_report' as const,
	summary: 'Player stuck',
	expectedBehavior: 'It moves',
	actualBehavior: 'It does not',
};

describe('feedbackReportFingerprint', () => {
	it('is stable across line-ending and surrounding-whitespace differences', () => {
		const first = feedbackReportFingerprint({
			...base,
			reproductionSteps: '1. Open\r\n2. Click',
			additionalContext: '  context  ',
		});
		const second = feedbackReportFingerprint({
			...base,
			reproductionSteps: '1. Open\n2. Click',
			additionalContext: 'context',
		});
		expect(first).toBe(second);
	});

	it('changes when the user changes the report', () => {
		expect(feedbackReportFingerprint({ ...base, summary: 'Other' })).not.toBe(
			feedbackReportFingerprint(base)
		);
		expect(feedbackReportFingerprint({ ...base, includeDebugPackage: true })).not.toBe(
			feedbackReportFingerprint(base)
		);
	});

	it('includes attachment names', () => {
		const withScreenshot = feedbackReportFingerprint({
			...base,
			attachments: [{ name: 'shot.png' }],
		});
		expect(withScreenshot).not.toBe(feedbackReportFingerprint(base));
		expect(feedbackReportFingerprint({ ...base, attachments: [{ name: 'shot.png' }] })).toBe(
			withScreenshot
		);
	});
});
