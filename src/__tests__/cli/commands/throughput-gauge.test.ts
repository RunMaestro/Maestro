/**
 * Tests for the `maestro-cli throughput-gauge` verbs.
 *
 * The CLI's own half: `set` flags become a validated patch before any round
 * trip (with `--window` typed in seconds and sent in milliseconds), every verb
 * prints the status the desktop answered with, and any failure exits non-zero
 * with the desktop's own error text.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

import {
	buildThroughputGaugePatch,
	describeThroughputGaugeStatus,
	throughputGaugeFlagChoices,
	throughputGaugeHide,
	throughputGaugeResetPeak,
	throughputGaugeSet,
	throughputGaugeShow,
	throughputGaugeStatus,
	throughputGaugeToggle,
} from '../../../cli/commands/throughput-gauge';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { DEFAULT_THROUGHPUT_GAUGE_SETTINGS } from '../../../shared/throughputGauge';
import {
	THROUGHPUT_GAUGE_DISABLED_ERROR,
	type ThroughputGaugeStatus,
} from '../../../shared/throughputGaugeCommands';

const STATUS: ThroughputGaugeStatus = {
	enabled: true,
	visible: true,
	settings: { ...DEFAULT_THROUGHPUT_GAUGE_SETTINGS },
	rates: { in: 40, out: 142, combined: 182 },
	peak: { in: 100, out: 540, combined: 640 },
	windowMs: 10000,
};

/** Every message the command sent, in order. */
let sent: Array<Record<string, unknown>>;

function stubDesktop(reply: Record<string, unknown> = { success: true, status: STATUS }): void {
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((msg: Record<string, unknown>, type: string) => {
				sent.push({ ...msg, responseType: type });
				return reply;
			}),
		} as never)
	);
}

describe('maestro-cli throughput-gauge', () => {
	let exitSpy: MockInstance;
	let logSpy: MockInstance;
	let errorSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		sent = [];
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		// `failCommand` never returns in production; throw so control flow matches.
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('process.exit');
		});
		stubDesktop();
	});

	async function expectExit(run: Promise<void>): Promise<void> {
		await expect(run).rejects.toThrow('process.exit');
		expect(exitSpy).toHaveBeenCalledWith(1);
	}

	it.each([
		['show', throughputGaugeShow],
		['hide', throughputGaugeHide],
		['toggle', throughputGaugeToggle],
		['reset-peak', throughputGaugeResetPeak],
		['status', throughputGaugeStatus],
	] as const)('%s sends its action on the one message type', async (action, run) => {
		await run({});
		expect(sent).toEqual([
			{
				type: 'throughput_gauge_command',
				action,
				responseType: 'throughput_gauge_command_result',
			},
		]);
	});

	it('prints a compact human summary', async () => {
		await throughputGaugeStatus({});
		expect(logSpy).toHaveBeenCalledWith(
			'Visible, Combined over 10s, all agents: 182 tok/s (peak 640)'
		);
	});

	it('--json prints the status itself', async () => {
		await throughputGaugeShow({ json: true });
		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual(STATUS);
	});

	it('status reports the enable hint when the feature is off', () => {
		expect(describeThroughputGaugeStatus({ ...STATUS, enabled: false })).toBe(
			THROUGHPUT_GAUGE_DISABLED_ERROR
		);
	});

	it('exits non-zero with the desktop error text', async () => {
		stubDesktop({ success: false, error: THROUGHPUT_GAUGE_DISABLED_ERROR });
		await expectExit(throughputGaugeShow({}));
		expect(errorSpy.mock.calls[0][0]).toContain(THROUGHPUT_GAUGE_DISABLED_ERROR);
	});

	it('exits non-zero with JSON when --json is set', async () => {
		stubDesktop({ success: false, error: 'Maestro window is not available' });
		await expectExit(throughputGaugeHide({ json: true }));
		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
			success: false,
			error: 'Maestro window is not available',
		});
	});

	describe('set', () => {
		it('converts --window seconds to milliseconds and sends only the named fields', async () => {
			await throughputGaugeSet({ window: '30', style: 'lcd' });
			expect(sent[0]).toMatchObject({
				type: 'throughput_gauge_command',
				action: 'set',
				patch: { style: 'lcd', windowMs: 30000 },
			});
			expect(Object.keys(sent[0].patch as object).sort()).toEqual(['style', 'windowMs']);
		});

		it('refuses a window that is not offered, without a round trip', async () => {
			await expectExit(throughputGaugeSet({ window: '7' }));
			expect(sent).toHaveLength(0);
			expect(errorSpy.mock.calls[0][0]).toContain('5, 10, 30, 60 (seconds)');
		});

		it('refuses an invalid value through the shared validator', async () => {
			await expectExit(throughputGaugeSet({ style: 'neon' }));
			expect(sent).toHaveLength(0);
			expect(errorSpy.mock.calls[0][0]).toContain('dial, vu, lcd, sparkline');
		});

		it('refuses a set with no flags', async () => {
			await expectExit(throughputGaugeSet({}));
			expect(sent).toHaveLength(0);
		});

		it('builds a patch for every flag', () => {
			expect(
				buildThroughputGaugePatch({
					scope: 'active',
					metric: 'out',
					layout: 'all',
					style: 'vu',
					window: '60',
				})
			).toEqual({
				ok: true,
				patch: { scope: 'active', metric: 'out', layout: 'all', style: 'vu', windowMs: 60000 },
			});
		});
	});

	it('lists flag choices from the shared option lists', () => {
		expect(throughputGaugeFlagChoices('scope')).toEqual(['all', 'active']);
		expect(throughputGaugeFlagChoices('style')).toEqual(['dial', 'vu', 'lcd', 'sparkline']);
		expect(throughputGaugeFlagChoices('windowMs')).toEqual(['5', '10', '30', '60']);
	});
});
