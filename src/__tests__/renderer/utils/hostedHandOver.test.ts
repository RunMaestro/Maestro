/**
 * Parity U2: between the end of a turn and the start of the next queued message, the tab stays
 * busy in every mode, so the Stop pill does not flicker away.
 *
 * A local and an SSH tab are busy from the moment the queue drain takes the message. A hosted tab
 * reads its host: a headless host runs the finished turn's History synopsis first, and the next
 * message waits in the host's queue until it ends (3 to 4 s with the live pass's provider). The
 * projection draws that wait as the hand-over it is, while the host says the message waits for
 * that tab alone (U6), and never longer than the host's own Stop could end it.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import type { QueuedTurn } from '../../../shared/maestro-lib/client/types';
import type { QueuedItem, Session } from '../../../renderer/types';
import {
	projectHostedSession,
	UNNAMED_HAND_OVER_MS,
	type HostedProjectionInput,
} from '../../../renderer/utils/hostedSession';
import {
	hostHandOverClock,
	nextHostHandOverDeadline,
	resetHostedTabLinesForTest,
} from '../../../renderer/utils/hostedTabLine';
import { HAND_OVER_MAX_MS } from '../../../shared/maestro-lib/turns/queue';
import { takeNextRunnableQueueItem } from '../../../renderer/utils/executionQueue';
import { markTabRunningQueuedItem } from '../../../renderer/utils/tabHelpers';
import { AGENT_MODES, createModeSession, type AgentMode } from '../../helpers';
import { createMockAITab } from '../../helpers/mockTab';

const NEXT = 'and then the tests';

const host = (tabState: 'idle' | 'busy' = 'idle', otherTab?: 'idle' | 'busy'): AgentRecord => ({
	id: 'h1',
	name: 'Docs',
	toolType: 'claude-code',
	activeTabId: 't1',
	aiTabs: [
		{ id: 't1', name: 'Main', agentSessionId: 's1', state: tabState },
		...(otherTab ? [{ id: 't2', name: 'Other', agentSessionId: 's2', state: otherTab }] : []),
	],
});

/** This machine's clock at each projection, unless a test moves it. */
const NOW = 600;

/** A message in the host's queue, as a host that says which one waits for its tab alone sends it. */
const waiting = (overrides: Partial<QueuedTurn> = {}): QueuedTurn => ({
	itemId: 'h-next',
	tabId: 't1',
	queuedAt: 500,
	kind: 'message',
	text: NEXT,
	paused: false,
	handOver: true,
	handOverSince: 500,
	...overrides,
});

/** The same message from an older host, which says nothing about it. */
const unnamed = (overrides: Partial<QueuedTurn> = {}): QueuedTurn => {
	const { handOver: _h, handOverSince: _s, ...item } = waiting(overrides);
	return item;
};

const project = (row: Session, input: HostedProjectionInput): Session =>
	projectHostedSession(row, { now: NOW, ...input });

function idleRow(mode: AgentMode, executionQueue: QueuedItem[] = []): Session {
	return createModeSession(mode, {
		id: 'row',
		state: 'idle',
		activeTabId: 't1',
		aiTabs: [
			createMockAITab({ id: 't1', name: 'Main', agentSessionId: 's1' }),
			createMockAITab({ id: 't2', name: 'Other', agentSessionId: 's2' }),
		],
		executionQueue,
	});
}

/** The tab just after its turn ended with the next message on its way to start, in each mode. */
function handOver(mode: AgentMode): Session {
	if (mode !== 'hosted') {
		// The local drain takes the message and marks the tab running in one store update.
		const row = idleRow(mode, [
			{ id: 'q-next', timestamp: 1, tabId: 't1', type: 'message', text: NEXT },
		]);
		const { item, remaining } = takeNextRunnableQueueItem(row.executionQueue);
		return {
			...row,
			state: 'busy',
			busySource: 'ai',
			executionQueue: remaining,
			aiTabs: row.aiTabs.map((tab) =>
				tab.id === item!.tabId ? markTabRunningQueuedItem(tab, item!, row) : tab
			),
		};
	}
	// The host's turn ended and its History synopsis holds the tab: the message waits there.
	return project(idleRow(mode), { agent: host(), queue: [waiting()] });
}

describe('U2: the tab stays busy through the hand-over to the next queued message', () => {
	it.each(AGENT_MODES)('%s: the tab and the agent read busy, with a start time', (mode) => {
		const row = handOver(mode);
		const tab = row.aiTabs.find((t) => t.id === 't1')!;
		expect(tab.state).toBe('busy');
		expect(typeof tab.thinkingStartTime).toBe('number');
		expect(row.state).toBe('busy');
		expect(row.aiTabs.find((t) => t.id === 't2')!.state).toBe('idle');
	});

	it('hosted: a turn still on its way from here reads busy, from when it left', () => {
		const row = project(idleRow('hosted'), {
			agent: host(),
			queue: [],
			handingOver: new Map([['t1', 300]]),
		});
		expect(row.aiTabs[0].state).toBe('busy');
		expect(row.aiTabs[0].thinkingStartTime).toBe(300);
		expect(row.state).toBe('busy');
	});

	it("hosted: the hand-over's own start time, not the turn before it (CodeRabbit on #2166)", () => {
		const after = idleRow('hosted');
		const row = project(
			{
				...after,
				// The turn before it, as the last projection drew it.
				aiTabs: after.aiTabs.map((tab) =>
					tab.id === 't1' ? { ...tab, state: 'busy', thinkingStartTime: 100 } : tab
				),
			},
			{ agent: host(), queue: [waiting()] }
		);
		expect(row.aiTabs[0].thinkingStartTime).toBe(500);
	});

	it("hosted: only the host queue's next message is a hand-over; one behind it reads queued", () => {
		const row = project(idleRow('hosted'), {
			agent: host('idle', 'idle'),
			queue: [
				waiting({ itemId: 'a', tabId: 't2', queuedAt: 400, handOverSince: 400 }),
				waiting({ handOver: false, handOverSince: undefined }),
			],
		});
		expect(row.aiTabs.find((t) => t.id === 't2')!.state).toBe('busy');
		expect(row.aiTabs.find((t) => t.id === 't1')!.state).toBe('idle');
	});

	it('hosted: a held message on the host is no hand-over: the tab reads idle', () => {
		const row = project(idleRow('hosted'), {
			agent: host(),
			queue: [waiting({ paused: true })],
		});
		expect(row.aiTabs[0].state).toBe('idle');
		expect(row.state).toBe('idle');
	});

	it("hosted: a message waiting behind another tab's turn reads queued, not busy, as locally", () => {
		const row = project(idleRow('hosted'), {
			agent: host('idle', 'busy'),
			queue: [waiting({ handOver: false, handOverSince: undefined })],
		});
		expect(row.aiTabs.find((t) => t.id === 't1')!.state).toBe('idle');
		expect(row.aiTabs.find((t) => t.id === 't2')!.state).toBe('busy');
	});

	it('hosted: with the link to the host down, a waiting message draws no busy tab', () => {
		const row = project(idleRow('hosted'), {
			agent: host(),
			queue: [waiting()],
			linkLost: {
				type: 'network_error',
				message: 'Connection lost',
				recoverable: true,
				agentId: 'claude-code',
				timestamp: 1,
			},
		});
		expect(row.aiTabs[0].state).toBe('idle');
	});

	it('hosted: once the turn starts, its own start time replaces the wait', () => {
		const first = project(idleRow('hosted'), { agent: host(), queue: [waiting()] });
		expect(first.aiTabs[0].thinkingStartTime).toBe(500);
		const running = project(first, {
			agent: {
				...host('busy'),
				aiTabs: [{ id: 't1', name: 'Main', state: 'busy', thinkingStartTime: 900 }],
			},
			queue: [],
		});
		expect(running.aiTabs[0].state).toBe('busy');
		expect(running.aiTabs[0].thinkingStartTime).toBe(900);
	});
});

describe('U6: a tab reads busy only while its message waits for that tab alone', () => {
	beforeEach(() => resetHostedTabLinesForTest());

	/** A message that waits for something else than its tab (an Auto Run's tree hold), in each mode. */
	function waitingForElse(mode: AgentMode): Session {
		if (mode !== 'hosted') {
			// The local drain takes nothing while the run holds the tree: the message stays queued.
			return idleRow(mode, [
				{ id: 'h-next', timestamp: 1, tabId: 't1', type: 'message', text: NEXT },
			]);
		}
		return project(idleRow(mode), {
			agent: host(),
			queue: [waiting({ handOver: false, handOverSince: undefined })],
		});
	}

	it.each(AGENT_MODES)(
		'%s: a message that waits for something else reads queued, the tab idle with no Stop',
		(mode) => {
			const row = waitingForElse(mode);
			expect(row.aiTabs[0].state).toBe('idle');
			expect(row.aiTabs[0].thinkingStartTime).toBeUndefined();
			expect(row.state).toBe('idle');
			expect(row.executionQueue.map((item) => item.id)).toEqual(['h-next']);
		}
	);

	it('hosted: a desktop host, which says false on every item, never draws a tab busy from its queue', () => {
		const row = project(idleRow('hosted'), {
			agent: host('idle', 'idle'),
			queue: [
				waiting({ handOver: false, handOverSince: undefined }),
				waiting({ itemId: 'b', tabId: 't2', handOver: false, handOverSince: undefined }),
			],
		});
		expect(row.aiTabs.map((tab) => tab.state)).toEqual(['idle', 'idle']);
	});

	it('hosted: the host-said hand-over reads busy until HAND_OVER_MAX_MS from when it was seen here, then queued', () => {
		const clock = (now: number) => hostHandOverClock('row', now);
		const at = (now: number) =>
			project(idleRow('hosted'), {
				agent: host(),
				queue: [waiting()],
				now,
				handOverClock: clock(now),
			});
		expect(at(10_000).aiTabs[0].state).toBe('busy');
		expect(nextHostHandOverDeadline()).toBe(10_000 + HAND_OVER_MAX_MS);
		expect(at(10_000 + HAND_OVER_MAX_MS - 1).aiTabs[0].state).toBe('busy');
		// Drawn busy a moment before the limit: the recheck is still armed, whatever the clock reads
		// by the time the sync asks (CodeRabbit on #2166).
		expect(nextHostHandOverDeadline()).toBe(10_000 + HAND_OVER_MAX_MS);
		const after = at(10_000 + HAND_OVER_MAX_MS);
		expect(after.aiTabs[0].state).toBe('idle');
		expect(after.executionQueue.map((item) => item.id)).toEqual(['h-next']);
		// Drawn as over: no recheck is armed for it again.
		expect(nextHostHandOverDeadline()).toBeUndefined();
	});

	it('hosted: an older host that says nothing has its next message drawn busy for UNNAMED_HAND_OVER_MS, then queued', () => {
		const at = (now: number) =>
			project(idleRow('hosted'), {
				agent: host(),
				queue: [unnamed()],
				now,
				handOverClock: hostHandOverClock('row', now),
			});
		const first = at(20_000);
		expect(first.aiTabs[0].state).toBe('busy');
		// Drawn from when it was seen waiting here, not from the host's clock.
		expect(first.aiTabs[0].thinkingStartTime).toBe(20_000);
		expect(at(20_000 + UNNAMED_HAND_OVER_MS - 1).aiTabs[0].state).toBe('busy');
		expect(at(20_000 + UNNAMED_HAND_OVER_MS).aiTabs[0].state).toBe('idle');
	});

	it('hosted: a hand-over seen again after a turn starts its limit again', () => {
		const at = (now: number, busy: boolean) =>
			project(idleRow('hosted'), {
				agent: host(busy ? 'busy' : 'idle'),
				queue: [waiting()],
				now,
				handOverClock: hostHandOverClock('row', now),
			});
		expect(at(1_000, false).aiTabs[0].state).toBe('busy');
		// The tab ran a turn meanwhile; the same message waits for it alone again much later.
		at(2_000, true);
		expect(at(1_000 + HAND_OVER_MAX_MS + 5, false).aiTabs[0].state).toBe('busy');
	});
});
