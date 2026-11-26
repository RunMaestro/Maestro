/**
 * Parity round 5, P3: after a turn, the Main Window header's context gauge, cost pill, and session
 * id pill read the same in every mode. A local and an SSH tab get the turn's usage from the local
 * usage listener; a hosted tab gets it from the host's tab record, through the host sync
 * (`projectHostedSession()`, `mirrorTab()`), and the header reads it through the same
 * `useContextWindow()`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import type { UsageStats } from '../../../shared/types';
import { useContextWindow } from '../../../renderer/hooks/mainPanel/useContextWindow';
import { projectHostedSession } from '../../../renderer/utils/hostedSession';
import { mirrorTab, mirrorUsageStats } from '../../../renderer/utils/peerMirrorView';
import type { AITab, Session } from '../../../renderer/types';
import { AGENT_MODES, createModeSession, type AgentMode } from '../../helpers';
import { createMockAITab } from '../../helpers/mockTab';

const TURN_USAGE: UsageStats = {
	inputTokens: 12_000,
	outputTokens: 800,
	cacheReadInputTokens: 30_000,
	cacheCreationInputTokens: 2_000,
	totalCostUsd: 0.42,
	contextWindow: 200_000,
	absoluteUsage: {
		inputTokens: 9_000,
		outputTokens: 300,
		cacheReadInputTokens: 30_000,
		cacheCreationInputTokens: 2_000,
		reasoningTokens: 0,
	},
};

function hostAgent(usageStats?: unknown): AgentRecord {
	return {
		id: 'h1',
		name: 'Docs',
		toolType: 'claude-code',
		activeTabId: 't1',
		aiTabs: [{ id: 't1', agentSessionId: 's-t1', ...(usageStats ? { usageStats } : {}) }],
	};
}

function seed(mode: AgentMode): Session {
	return createModeSession(mode, {
		id: `row-${mode}`,
		toolType: 'claude-code',
		activeTabId: 't1',
		aiTabs: [createMockAITab({ id: 't1', agentSessionId: 's-t1', logs: [] })],
		unifiedTabOrder: [{ type: 'ai', id: 't1' }],
		executionQueue: [],
		state: 'idle',
	});
}

/** The agent after one turn, as each mode records it. */
function afterTurn(mode: AgentMode): Session {
	const session = seed(mode);
	if (mode === 'hosted') return projectHostedSession(session, { agent: hostAgent(TURN_USAGE) });
	// A local and an SSH turn: the usage listener writes the turn's usage on the tab.
	return {
		...session,
		aiTabs: session.aiTabs.map((tab) => ({ ...tab, usageStats: TURN_USAGE })),
	};
}

function activeTab(session: Session): AITab {
	return session.aiTabs.find((tab) => tab.id === session.activeTabId)!;
}

/** What the header draws from the tab: the gauge, the cost pill, the session id pill. */
async function headerReadout(mode: AgentMode) {
	const session = afterTurn(mode);
	const tab = activeTab(session);
	const { result } = renderHook(() => useContextWindow(session, tab));
	await waitFor(() => expect(result.current.activeTabContextWindow).toBeGreaterThan(0));
	return {
		window: result.current.activeTabContextWindow,
		tokens: result.current.activeTabContextTokens,
		percent: result.current.activeTabContextUsage,
		cost: tab.usageStats?.totalCostUsd,
		sessionId: tab.agentSessionId,
	};
}

beforeEach(() => {
	(window as unknown as { maestro: unknown }).maestro = {
		agents: { getConfig: vi.fn().mockResolvedValue({}) },
	};
});

describe('the header context gauge after a turn, in every mode', () => {
	it.each(AGENT_MODES)('%s: shows a gauge, the cost, and the session id', async (mode) => {
		const readout = await headerReadout(mode);
		expect(readout.window).toBe(200_000);
		expect(readout.percent).toBeGreaterThan(0);
		expect(readout.cost).toBe(0.42);
		expect(readout.sessionId).toBe('s-t1');
	});

	it('draws the same readout in all three modes', async () => {
		const results = [];
		for (const mode of AGENT_MODES) results.push(await headerReadout(mode));
		expect(results[1]).toEqual(results[0]);
		expect(results[2]).toEqual(results[0]);
	});

	it('gives a tab the host added the usage too', () => {
		expect(mirrorTab({ id: 't9', usageStats: TURN_USAGE }).usageStats).toEqual(TURN_USAGE);
	});

	it('keeps the same tab object while the host usage has not changed', () => {
		const first = projectHostedSession(seed('hosted'), { agent: hostAgent(TURN_USAGE) });
		const again = projectHostedSession(first, {
			agent: hostAgent(structuredClone(TURN_USAGE)),
		});
		expect(again).toBe(first);
	});

	it('keeps the usage a tab had when an older host reports none', () => {
		const first = projectHostedSession(seed('hosted'), { agent: hostAgent(TURN_USAGE) });
		const older = projectHostedSession(first, { agent: hostAgent() });
		expect(activeTab(older).usageStats).toEqual(TURN_USAGE);
	});
});

describe('mirrorUsageStats: host usage is untrusted', () => {
	it('drops a value with a missing, negative, or non-number token count', () => {
		expect(mirrorUsageStats(undefined)).toBeUndefined();
		expect(mirrorUsageStats([1, 2])).toBeUndefined();
		expect(mirrorUsageStats({ ...TURN_USAGE, inputTokens: -1 })).toBeUndefined();
		expect(mirrorUsageStats({ ...TURN_USAGE, outputTokens: '5' })).toBeUndefined();
		expect(mirrorUsageStats({ ...TURN_USAGE, cacheReadInputTokens: Infinity })).toBeUndefined();
	});

	it('keeps only the fields the header reads', () => {
		const usage = mirrorUsageStats({
			...TURN_USAGE,
			totalCostUsd: 'free',
			contextWindow: -5,
			accounting: { source: 'evil' },
			absoluteUsage: { inputTokens: 1 },
			extra: 'x',
		});
		expect(usage).toEqual({
			inputTokens: 12_000,
			outputTokens: 800,
			cacheReadInputTokens: 30_000,
			cacheCreationInputTokens: 2_000,
			totalCostUsd: 0,
			contextWindow: 0,
		});
	});
});
