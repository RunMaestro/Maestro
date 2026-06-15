import { describe, it, expect } from 'vitest';
import { thinkingLogsRecorded } from '../../../../../../renderer/hooks/agent/internal/helpers/thinkingLogs';

describe('thinkingLogsRecorded', () => {
	it('records when thinking is on', () => {
		expect(thinkingLogsRecorded('on')).toBe(true);
	});

	it('records when thinking is sticky', () => {
		expect(thinkingLogsRecorded('sticky')).toBe(true);
	});

	it('does not record when thinking is off', () => {
		expect(thinkingLogsRecorded('off')).toBe(false);
	});

	it('does not record when thinking is undefined', () => {
		expect(thinkingLogsRecorded(undefined)).toBe(false);
	});

	// Legacy persisted shapes that predate the ThinkingMode string union.
	it('records for legacy boolean true', () => {
		expect(thinkingLogsRecorded(true)).toBe(true);
	});

	it('does not record for legacy boolean false', () => {
		expect(thinkingLogsRecorded(false)).toBe(false);
	});
});
