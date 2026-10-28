/**
 * The Local Models `unavailable` notice: logged every time, toasted once per
 * task and agent, and re-armed by a later success.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearLocalTaskNotice,
	reportLocalTaskUnavailable,
	resetLocalTaskNotices,
} from '../../../main/local-models/task-notices';
import type { LocalTaskUnavailable } from '../../../main/local-models/task-router';
import { logger } from '../../../main/utils/logger';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const verdict: LocalTaskUnavailable = {
	status: 'unavailable',
	source: { type: 'endpoint', endpointId: 'ollama', model: 'llama3.2' },
	reason: 'Ollama is not running. Start it and try again.',
	code: 'network',
};

describe('reportLocalTaskUnavailable', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetLocalTaskNotices();
	});

	it('sends a yellow toast titled with the task label and the reason', () => {
		const safeSend = vi.fn();

		const sent = reportLocalTaskUnavailable({
			safeSend,
			taskId: 'tab-naming',
			verdict,
			sessionId: 'agent-1',
		});

		expect(sent).toBe(true);
		expect(safeSend).toHaveBeenCalledWith('remote:notifyToast', {
			title: 'Tab naming skipped',
			message: verdict.reason,
			color: 'yellow',
			sessionId: 'agent-1',
		});
	});

	it('toasts once per task and agent but logs every time', () => {
		const safeSend = vi.fn();
		const report = (taskId: 'tab-naming' | 'tab-summary', sessionId?: string) =>
			reportLocalTaskUnavailable({ safeSend, taskId, verdict, sessionId });

		expect(report('tab-naming', 'agent-1')).toBe(true);
		expect(report('tab-naming', 'agent-1')).toBe(false);
		expect(report('tab-naming', 'agent-2')).toBe(true);
		expect(report('tab-summary', 'agent-1')).toBe(true);
		expect(report('tab-naming')).toBe(true);
		expect(report('tab-naming')).toBe(false);

		expect(safeSend).toHaveBeenCalledTimes(4);
		expect(logger.warn).toHaveBeenCalledTimes(6);
	});

	it('omits the session from an app-wide notice', () => {
		const safeSend = vi.fn();
		reportLocalTaskUnavailable({ safeSend, taskId: 'ai-command', verdict });
		expect(safeSend.mock.calls[0][1]).not.toHaveProperty('sessionId');
	});

	it('re-arms after clearLocalTaskNotice', () => {
		const safeSend = vi.fn();
		const report = () =>
			reportLocalTaskUnavailable({ safeSend, taskId: 'tab-naming', verdict, sessionId: 'a' });

		report();
		clearLocalTaskNotice('tab-naming', 'a');
		report();

		expect(safeSend).toHaveBeenCalledTimes(2);
	});

	it('logs without toasting when there is no broadcast channel', () => {
		expect(reportLocalTaskUnavailable({ safeSend: undefined, taskId: 'tab-naming', verdict })).toBe(
			false
		);
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});
});
