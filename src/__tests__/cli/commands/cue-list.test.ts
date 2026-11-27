/**
 * @file cue-list.test.ts
 * @description `cue list` must say when a subscription is failing, in text and
 * JSON, instead of printing the same check mark as a healthy one.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

import { cueList } from '../../../cli/commands/cue-list';
import { withMaestroClient } from '../../../cli/services/maestro-client';

const subscriptions = [
	{
		id: 'agent-1::Ops::sms-poll',
		name: 'sms-poll',
		eventType: 'time.heartbeat',
		sessionId: 'agent-1',
		sessionName: 'Pedsidian',
		enabled: true,
		triggerCount: 134,
		health: 'failing',
		failureStreak: {
			consecutiveFailures: 134,
			firstFailedAt: '2026-11-17T03:32:35.000Z',
			lastFailedAt: '2026-11-17T10:32:35.000Z',
			lastStatus: 'failed',
			lastError: 'No, exit',
			alertThreshold: 3,
		},
	},
	{
		id: 'agent-1::Ops::flaky',
		name: 'flaky',
		eventType: 'time.heartbeat',
		sessionId: 'agent-1',
		sessionName: 'Pedsidian',
		enabled: true,
		triggerCount: 4,
		health: 'ok',
		failureStreak: {
			consecutiveFailures: 1,
			firstFailedAt: '2026-11-17T10:00:00.000Z',
			lastFailedAt: '2026-11-17T10:00:00.000Z',
			lastStatus: 'timeout',
			alertThreshold: 3,
		},
	},
	{
		id: 'agent-1::Ops::fine',
		name: 'fine',
		eventType: 'time.heartbeat',
		sessionId: 'agent-1',
		sessionName: 'Pedsidian',
		enabled: true,
		triggerCount: 9,
		health: 'ok',
	},
];

describe('cueList command', () => {
	let consoleSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		vi.mocked(withMaestroClient).mockImplementation(async (fn) =>
			fn({
				sendCommand: vi.fn().mockResolvedValue({ type: 'cue_subscriptions', subscriptions }),
			} as any)
		);
	});

	it('passes health and failureStreak through to --json', async () => {
		await cueList({ json: true });
		const printed = JSON.parse(consoleSpy.mock.calls[0][0] as string);
		expect(printed[0]).toMatchObject({
			name: 'sms-poll',
			health: 'failing',
			failureStreak: { consecutiveFailures: 134, lastError: 'No, exit' },
		});
		expect(printed[2]).toMatchObject({ name: 'fine', health: 'ok' });
	});

	it('marks a failing subscription in text output and describes its streak', async () => {
		await cueList({});
		const text = consoleSpy.mock.calls[0][0] as string;
		expect(text).toContain('  ✓  sms-poll  [FAILING]');
		expect(text).toContain('failing: 134 failed runs in a row - last error: No, exit');
	});

	it('keeps the disabled mark on a failing subscription', async () => {
		vi.mocked(withMaestroClient).mockImplementation(async (fn) =>
			fn({
				sendCommand: vi.fn().mockResolvedValue({
					type: 'cue_subscriptions',
					subscriptions: [{ ...subscriptions[0], enabled: false }],
				}),
			} as any)
		);
		await cueList({});
		const text = consoleSpy.mock.calls[0][0] as string;
		expect(text).toContain('  ✗  sms-poll  [FAILING]');
	});

	it('shows a streak below the threshold without calling it failing', async () => {
		await cueList({});
		const text = consoleSpy.mock.calls[0][0] as string;
		expect(text).toContain('  ✓  flaky\n');
		expect(text).toContain('failures: 1 failed run in a row');
		expect(text).toContain('  ✓  fine\n');
	});
});
