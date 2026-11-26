/**
 * @file hosted-turn-feed.test.ts
 * @description `dispatch <agent> --notify-on-complete` fires the same callback for a local, an SSH,
 * and a hosted agent (M8). A local or SSH turn feeds the registry from its process; a hosted turn
 * runs on its host, and the peer mirror's turn events for the hosted record's tab feed it instead.
 */

import { describe, expect, it } from 'vitest';

import {
	DispatchCallbackRegistry,
	buildProcessSessionId,
} from '../../../main/dispatch-callbacks/dispatch-callback-registry';
import { feedHostedTurnToDispatchCallbacks } from '../../../main/dispatch-callbacks/hosted-turn-feed';
import type { DispatchCallbackFire } from '../../../main/dispatch-callbacks/types';
import type { MirrorPush } from '../../../shared/maestro-lib/client/peer-mirror';
import type { TurnEvent } from '../../../shared/maestro-lib/client/types';
import { AGENT_MODES, agentModeFields } from '../../helpers/mockSession';

const ROW = 'row-1';
const TAB = 'tab-1';

function harness() {
	const fires: DispatchCallbackFire[] = [];
	const pending: Array<() => void> = [];
	const registry = new DispatchCallbackRegistry({
		now: () => 1_000_000,
		generateId: () => 'cb_1',
		autoRunRunningSince: () => undefined,
		onFire: (fire) => fires.push(fire),
		graceMs: 3000,
		setTimeoutFn: ((fn: () => void) => {
			pending.push(fn);
			return pending.length as unknown as ReturnType<typeof setTimeout>;
		}) as never,
		clearTimeoutFn: (() => undefined) as never,
	});
	registry.register({
		targetAgentId: ROW,
		targetTabId: TAB,
		callerAgentId: 'agent-caller',
		timeoutMs: 60_000,
		prompt: 'do the thing',
	});
	return {
		registry,
		fires,
		runTimers: () => pending.splice(0).forEach((fn) => fn()),
	};
}

const turn = (event: TurnEvent, agentId = 'h1', peerId = 'box'): MirrorPush => ({
	peerId,
	event: { type: 'turn', agentId, tabId: TAB, event },
});

describe('feedHostedTurnToDispatchCallbacks', () => {
	it.each(AGENT_MODES)(
		'%s: a dispatched turn that answers and ends fires the same callback',
		(mode) => {
			const h = harness();
			const record = { id: ROW, ...agentModeFields(mode) };
			if (mode === 'hosted') {
				// The turn runs on the host: its mirrored events are the process here.
				const feed = (push: MirrorPush) =>
					feedHostedTurnToDispatchCallbacks(push, () => [record], h.registry);
				feed(turn({ kind: 'started', at: 1 }));
				feed(turn({ kind: 'text', at: 2, text: 'All done.' }));
				feed(turn({ kind: 'outcome', at: 3, outcome: 'completed', exitCode: 0 }));
			} else {
				// What `setupDispatchCallbackListener()` hears from the turn's process.
				const id = buildProcessSessionId(ROW, TAB);
				h.registry.noteSpawn(id);
				h.registry.noteData(id, 'All done.');
				h.registry.noteExit(id, 0);
			}
			h.runTimers();
			expect(h.fires).toHaveLength(1);
			expect(h.fires[0]).toMatchObject({ status: 'completed', exitCode: 0 });
			expect(JSON.stringify(h.fires[0])).toContain('All done.');
		}
	);

	it("leaves the registry alone for another peer's agent, an agent no record points at, and other events", () => {
		const h = harness();
		const record = { id: ROW, ...agentModeFields('hosted') };
		const feed = (push: MirrorPush) =>
			feedHostedTurnToDispatchCallbacks(push, () => [record], h.registry);
		feed(turn({ kind: 'started', at: 1 }, 'h1', 'other-peer'));
		feed(turn({ kind: 'started', at: 1 }, 'someone-else'));
		feed(turn({ kind: 'gap', at: 1 }));
		feed({ peerId: 'box', event: { type: 'tab.stale', agentId: 'h1', tabId: TAB } });
		feed(turn({ kind: 'outcome', at: 3, outcome: 'completed', exitCode: 0 }, 'someone-else'));
		h.runTimers();
		expect(h.fires).toEqual([]);
		// No registry (the service is not up): nothing to feed, nothing thrown.
		expect(() =>
			feedHostedTurnToDispatchCallbacks(turn({ kind: 'started', at: 1 }), () => [record], null)
		).not.toThrow();
	});

	it('reports a failed hosted turn as the local exit code reports it', () => {
		const h = harness();
		const record = { id: ROW, ...agentModeFields('hosted') };
		const feed = (push: MirrorPush) =>
			feedHostedTurnToDispatchCallbacks(push, () => [record], h.registry);
		feed(turn({ kind: 'started', at: 1 }));
		feed(turn({ kind: 'outcome', at: 3, outcome: 'crashed', exitCode: 1 }));
		h.runTimers();
		expect(h.fires[0]).toMatchObject({ status: 'failed', exitCode: 1 });
	});
});
