import { describe, it, expect } from 'vitest';
import {
	DEFAULT_CUE_FAILURE_ALERT_THRESHOLD,
	baseSubscriptionName,
	describeFailureStreak,
	failureStreakEscalationThreshold,
	isFailedRunStatus,
	resolveFailureAlertThreshold,
} from '../../../shared/cue/failure-streak';

describe('failure-streak rules', () => {
	it('counts failed and timeout as failures, nothing else', () => {
		expect(isFailedRunStatus('failed')).toBe(true);
		expect(isFailedRunStatus('timeout')).toBe(true);
		expect(isFailedRunStatus('completed')).toBe(false);
		expect(isFailedRunStatus('stopped')).toBe(false);
		expect(isFailedRunStatus('running')).toBe(false);
	});

	it('strips only a trailing :output suffix', () => {
		expect(baseSubscriptionName('poll:output')).toBe('poll');
		expect(baseSubscriptionName('poll')).toBe('poll');
		expect(baseSubscriptionName('a:output:b')).toBe('a:output:b');
	});

	it('resolves the threshold from settings, defaulting on unset or invalid values', () => {
		expect(DEFAULT_CUE_FAILURE_ALERT_THRESHOLD).toBe(3);
		expect(resolveFailureAlertThreshold(undefined)).toBe(3);
		expect(resolveFailureAlertThreshold({})).toBe(3);
		expect(resolveFailureAlertThreshold({ failure_alert_threshold: 5 })).toBe(5);
		expect(resolveFailureAlertThreshold({ failure_alert_threshold: 0 })).toBe(0);
		expect(resolveFailureAlertThreshold({ failure_alert_threshold: -1 })).toBe(3);
		expect(resolveFailureAlertThreshold({ failure_alert_threshold: 2.5 })).toBe(3);
		expect(resolveFailureAlertThreshold({ failure_alert_threshold: 5000 })).toBe(3);
	});

	it('escalates at ten times the threshold, never when alerts are off', () => {
		expect(failureStreakEscalationThreshold(3)).toBe(30);
		expect(failureStreakEscalationThreshold(0)).toBe(0);
	});

	it('describes a streak with and without an error', () => {
		expect(describeFailureStreak({ consecutiveFailures: 1 })).toBe('1 failed run in a row');
		expect(describeFailureStreak({ consecutiveFailures: 4, lastError: 'boom' })).toBe(
			'4 failed runs in a row - last error: boom'
		);
	});
});
