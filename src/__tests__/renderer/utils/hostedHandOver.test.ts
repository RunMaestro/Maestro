/**
 * Parity U2: between the end of a turn and the start of the next queued message, the tab stays
 * busy in every mode, so the Stop pill does not flicker away.
 *
 * A local and an SSH tab are busy from the moment the queue drain takes the message. A hosted tab
 * reads its host: a headless host runs the finished turn's History synopsis first, and the next
 * message waits in the host's queue until it ends (3 to 4 s with the live pass's provider). The
 * projection draws that wait as the hand-over it is.
 */

import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import type { QueuedTurn } from '../../../shared/maestro-lib/client/types';
import type { QueuedItem, Session } from '../../../renderer/types';
import { projectHostedSession } from '../../../renderer/utils/hostedSession';
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

const waiting = (overrides: Partial<QueuedTurn> = {}): QueuedTurn => ({
	itemId: 'h-next',
	tabId: 't1',
	queuedAt: 500,
	kind: 'message',
	text: NEXT,
	paused: false,
	...overrides,
});

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
	return projectHostedSession(idleRow(mode), { agent: host(), queue: [waiting()] });
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
		const row = projectHostedSession(idleRow('hosted'), {
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
		const row = projectHostedSession(
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

	it('hosted: a held message on the host is no hand-over: the tab reads idle', () => {
		const row = projectHostedSession(idleRow('hosted'), {
			agent: host(),
			queue: [waiting({ paused: true })],
		});
		expect(row.aiTabs[0].state).toBe('idle');
		expect(row.state).toBe('idle');
	});

	it("hosted: a message waiting behind another tab's turn reads queued, not busy, as locally", () => {
		const row = projectHostedSession(idleRow('hosted'), {
			agent: host('idle', 'busy'),
			queue: [waiting()],
		});
		expect(row.aiTabs.find((t) => t.id === 't1')!.state).toBe('idle');
		expect(row.aiTabs.find((t) => t.id === 't2')!.state).toBe('busy');
	});

	it('hosted: with the link to the host down, a waiting message draws no busy tab', () => {
		const row = projectHostedSession(idleRow('hosted'), {
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
		const first = projectHostedSession(idleRow('hosted'), { agent: host(), queue: [waiting()] });
		expect(first.aiTabs[0].thinkingStartTime).toBe(500);
		const running = projectHostedSession(first, {
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
