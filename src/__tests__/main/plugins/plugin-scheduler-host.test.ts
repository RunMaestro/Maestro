import { describe, it, expect, vi } from 'vitest';
import { PluginSchedulerHost } from '../../../main/plugins/plugin-scheduler-host';
import { schedulerNowFromDate } from '../../../shared/plugins/plugin-scheduler';
import { evaluateScheduledDispatch } from '../../../shared/plugins/plugin-dispatch-gate';
import type { CueTriggerContribution } from '../../../shared/plugins/contributions';

// A daily-time trigger whose times include the current AND next clock minute, so
// it is due on the very first tick() regardless of a minute rollover mid-test.
function dueTrigger(over: Partial<CueTriggerContribution> = {}): CueTriggerContribution {
	const d = new Date();
	const cur = schedulerNowFromDate(d).hhmm;
	const next = schedulerNowFromDate(new Date(d.getTime() + 60_000)).hhmm;
	return {
		id: 'p/t',
		localId: 't',
		pluginId: 'p',
		title: 'T',
		schedule: { kind: 'dailyTimes', times: [cur, next] },
		action: 'dispatch',
		payload: 'post a friendly summary',
		...over,
	};
}

// Production-equivalent gate: low/medium risk is necessary but not sufficient;
// dispatch also requires a live agents:dispatch grant naming the target agent,
// a trusted signature, AND the separate unattended consent (scheduler ticks are
// no-user-present execution).
const gate = (
	t: CueTriggerContribution,
	ctx: { hasDispatchGrant: boolean; trusted: boolean; hasUnattendedConsent: boolean } = {
		hasDispatchGrant: true,
		trusted: true,
		hasUnattendedConsent: true,
	}
) => evaluateScheduledDispatch(t.payload, ctx);

describe('PluginSchedulerHost dispatch gating', () => {
	it('auto-dispatches an eligible (non-high-risk) trigger when a sink is wired', () => {
		const notify = vi.fn();
		const dispatch = vi.fn();
		const h = new PluginSchedulerHost({
			isEnabled: () => true,
			getTriggers: () => [dueTrigger()],
			notify,
			dispatch,
			evaluateDispatch: gate,
		});
		h.tick();
		expect(dispatch).toHaveBeenCalledTimes(1);
		expect(notify).not.toHaveBeenCalled();
	});

	it('surfaces (notifies) a high-risk trigger instead of auto-dispatching', () => {
		const notify = vi.fn();
		const dispatch = vi.fn();
		const h = new PluginSchedulerHost({
			isEnabled: () => true,
			getTriggers: () => [
				dueTrigger({ payload: 'delete the production database and drop all tables' }),
			],
			notify,
			dispatch,
			evaluateDispatch: gate,
		});
		h.tick();
		expect(dispatch).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it('surfaces an otherwise eligible trigger when the plugin is untrusted', () => {
		const notify = vi.fn();
		const dispatch = vi.fn();
		const h = new PluginSchedulerHost({
			isEnabled: () => true,
			getTriggers: () => [dueTrigger()],
			notify,
			dispatch,
			evaluateDispatch: (trigger) => gate(trigger, { hasDispatchGrant: true, trusted: false }),
		});
		h.tick();
		expect(dispatch).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it('surfaces an otherwise eligible trigger when the agents:dispatch grant is absent', () => {
		const notify = vi.fn();
		const dispatch = vi.fn();
		const h = new PluginSchedulerHost({
			isEnabled: () => true,
			getTriggers: () => [dueTrigger()],
			notify,
			dispatch,
			evaluateDispatch: (trigger) => gate(trigger, { hasDispatchGrant: false, trusted: true }),
		});
		h.tick();
		expect(dispatch).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it('surfaces an otherwise eligible trigger without the separate UNATTENDED consent (notify-only fallback)', () => {
		const notify = vi.fn();
		const dispatch = vi.fn();
		const h = new PluginSchedulerHost({
			isEnabled: () => true,
			getTriggers: () => [dueTrigger()],
			notify,
			dispatch,
			evaluateDispatch: (trigger) =>
				gate(trigger, { hasDispatchGrant: true, trusted: true, hasUnattendedConsent: false }),
		});
		h.tick();
		expect(dispatch).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it('skips loudly (does not crash the tick) when the dispatch sink throws for a missing target', () => {
		const notify = vi.fn();
		const dispatch = vi.fn(() => {
			throw new Error('target agent "agent-a" is not running');
		});
		const h = new PluginSchedulerHost({
			isEnabled: () => true,
			getTriggers: () => [dueTrigger({ agentId: 'agent-a' })],
			notify,
			dispatch,
			evaluateDispatch: gate,
		});
		expect(() => h.tick()).not.toThrow();
		expect(dispatch).toHaveBeenCalledTimes(1);
	});

	it('surfaces an eligible trigger when no dispatch sink is wired (auto-exec off)', () => {
		const notify = vi.fn();
		const h = new PluginSchedulerHost({
			isEnabled: () => true,
			getTriggers: () => [dueTrigger()],
			notify,
			evaluateDispatch: gate,
		});
		h.tick();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it('runs a notify-action trigger directly', () => {
		const notify = vi.fn();
		const dispatch = vi.fn();
		const h = new PluginSchedulerHost({
			isEnabled: () => true,
			getTriggers: () => [dueTrigger({ action: 'notify', payload: 'hello' })],
			notify,
			dispatch,
			evaluateDispatch: gate,
		});
		h.tick();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(dispatch).not.toHaveBeenCalled();
	});
});
