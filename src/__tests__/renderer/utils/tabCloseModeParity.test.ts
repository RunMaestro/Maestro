/**
 * Parity round 5, P1: Cmd+W or a tab's X loses one tab in every mode. A local and an SSH close is
 * `closeTab()` alone; a hosted close is the same `closeTab()` plus the host's close, and the host
 * sync (`projectHostedSession()`) must neither draw the tab back while the host catches up nor
 * keep it once the host has dropped it.
 */

import { describe, expect, it } from 'vitest';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import { closeTab } from '../../../renderer/utils/tabHelpers';
import { projectHostedSession } from '../../../renderer/utils/hostedSession';
import type { Session } from '../../../renderer/types';
import { AGENT_MODES, createModeSession, type AgentMode } from '../../helpers';
import { createMockAITab } from '../../helpers/mockTab';

const TABS = ['t1', 't2', 't3'];

function hostAgent(tabIds: readonly string[]): AgentRecord {
	return {
		id: 'h1',
		name: 'Docs',
		toolType: 'claude-code',
		activeTabId: tabIds[0],
		aiTabs: tabIds.map((id) => ({ id, agentSessionId: `s-${id}` })),
	};
}

function seed(mode: AgentMode): Session {
	const session = createModeSession(mode, {
		id: `row-${mode}`,
		activeTabId: 't2',
		aiTabs: TABS.map((id) => createMockAITab({ id, agentSessionId: `s-${id}`, logs: [] })),
		unifiedTabOrder: TABS.map((id) => ({ type: 'ai' as const, id })),
		executionQueue: [],
		state: 'idle',
	});
	// A hosted record has been in step with its host before the close.
	return mode === 'hosted' ? projectHostedSession(session, { agent: hostAgent(TABS) }) : session;
}

const strip = (session: Session) => session.unifiedTabOrder.map((ref) => ref.id);

/** The strip after closing `t2`, then after the host (for a hosted agent) caught up. */
function closeAndSettle(mode: AgentMode): { atOnce: string[]; settled: string[] } {
	const closed = closeTab(seed(mode), 't2', false)!.session;
	if (mode !== 'hosted') return { atOnce: strip(closed), settled: strip(closed) };
	// The host has not taken the close yet: it still lists t2.
	const pending = projectHostedSession(closed, {
		agent: hostAgent(TABS),
		closing: new Set(['t2']),
	});
	// The host took it: t2 is gone from its record.
	const settled = projectHostedSession(pending, { agent: hostAgent(['t1', 't3']) });
	return { atOnce: strip(pending), settled: strip(settled) };
}

describe('closing a tab, in every mode', () => {
	it.each(AGENT_MODES)('%s: loses exactly the closed tab and never draws it back', (mode) => {
		expect(closeAndSettle(mode)).toEqual({ atOnce: ['t1', 't3'], settled: ['t1', 't3'] });
	});

	it('draws the same strip in all three modes', () => {
		const results = AGENT_MODES.map(closeAndSettle);
		expect(results[1]).toEqual(results[0]);
		expect(results[2]).toEqual(results[0]);
	});
});
