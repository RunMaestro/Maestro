/**
 * One agent keeps at most `MAX_CONSULT_TABS_PER_AGENT` hidden consult tabs.
 *
 * A remote asker sends a key of its own per conversation (`remote-asker:<key>`), and a local asker
 * gets one consult tab per asking tab, so without a cap the tab list grows without bound. Past the
 * cap, the least recently used idle hidden consult tab gives up its slot to the new pairing. This
 * file pins the rule and the headless host's use of it; the desktop host's use is in
 * `src/__tests__/renderer/hooks/useCrossAgentDispatch.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
	consultTabLastUsedAt,
	consultTabToReplace,
	DEFAULT_TAB_DEFAULTS,
	MAX_CONSULT_TABS_PER_AGENT,
	openConsultTabRecord,
	type RuleContext,
} from '../../../../shared/maestro-lib/agents/rules';
import { REMOTE_ASKER_SESSION_PREFIX } from '../../../../shared/crossAgentTypes';
import type { AgentRecord, AITabRecord } from '../../../../shared/maestro-lib/store/records';

function consultTab(index: number, overrides: Partial<AITabRecord> = {}): AITabRecord {
	return {
		id: `consult-${index}`,
		agentSessionId: `provider-${index}`,
		name: `↩ Asker ${index}`,
		createdAt: index,
		logs: [{ id: `q-${index}`, timestamp: 1000 + index, source: 'user', text: 'q' }],
		hidden: true,
		state: 'idle',
		consultOrigin: {
			sourceSessionId: `${REMOTE_ASKER_SESSION_PREFIX}peer`,
			sourceTabId: `key-${index}`,
		},
		...overrides,
	} as AITabRecord;
}

function agentWith(tabs: AITabRecord[]): AgentRecord {
	return {
		id: 'target',
		name: 'Target',
		toolType: 'claude-code',
		activeTabId: 'main',
		aiTabs: [
			{ id: 'main', name: 'Main', logs: [], createdAt: 0, state: 'idle' } as AITabRecord,
			...tabs,
		],
		unifiedTabOrder: [
			{ type: 'ai', id: 'main' },
			...tabs.map((tab) => ({ type: 'ai' as const, id: tab.id })),
		],
	} as AgentRecord;
}

let idCounter = 0;
const ctx: RuleContext = {
	newId: () => `new-${++idCounter}`,
	now: () => 5000,
	random: () => 0,
};

const question = { id: 'question', timestamp: 5000, source: 'user', text: 'new question' };

function fullTabs(): AITabRecord[] {
	return Array.from({ length: MAX_CONSULT_TABS_PER_AGENT }, (_, i) => consultTab(i));
}

describe('the consult tab cap', () => {
	it('is near 50', () => {
		expect(MAX_CONSULT_TABS_PER_AGENT).toBe(50);
	});

	it('replaces nothing while the agent is under the cap', () => {
		expect(consultTabToReplace(fullTabs().slice(1))).toBeUndefined();
	});

	it('replaces the least recently used hidden consult tab at the cap', () => {
		const tabs = fullTabs();
		// consult-0 asked most recently, so consult-1 is now the oldest.
		tabs[0] = consultTab(0, {
			logs: [{ id: 'late', timestamp: 9999, source: 'user', text: 'q' }],
		});
		expect(consultTabToReplace(tabs)?.id).toBe('consult-1');
	});

	it('never replaces a consult in flight, and never a tab the person revealed', () => {
		const tabs = fullTabs();
		tabs[0] = consultTab(0, { state: 'busy' });
		tabs.push(consultTab(99, { hidden: false, createdAt: -1, logs: [] }));
		expect(consultTabToReplace(tabs)?.id).toBe('consult-1');
	});

	it('adds past the cap when every consult tab is busy, rather than refusing the consult', () => {
		const tabs = fullTabs().map((tab) => ({ ...tab, state: 'busy' as const }));
		expect(consultTabToReplace(tabs)).toBeUndefined();
	});

	it('reads recency from the newest transcript entry, falling back to creation', () => {
		expect(consultTabLastUsedAt(consultTab(3))).toBe(1003);
		expect(consultTabLastUsedAt(consultTab(3, { logs: [] }))).toBe(3);
		expect(consultTabLastUsedAt({ id: 'x' })).toBe(0);
	});
});

describe('a headless host opening a consult tab', () => {
	it('keeps the agent at the cap: a new remote asker key takes the oldest slot on a fresh tab', () => {
		const agent = agentWith(fullTabs());
		const opened = openConsultTabRecord(
			agent,
			{
				key: { sourceSessionId: `${REMOTE_ASKER_SESSION_PREFIX}peer`, sourceTabId: 'key-new' },
				name: '↩ Peer',
				question: question as never,
			},
			ctx,
			DEFAULT_TAB_DEFAULTS
		);

		expect(opened.created).toBe(true);
		const consults = (opened.agent.aiTabs ?? []).filter((tab) => tab.consultOrigin);
		expect(consults).toHaveLength(MAX_CONSULT_TABS_PER_AGENT);
		expect(consults.some((tab) => tab.id === 'consult-0')).toBe(false);
		expect(opened.agent.unifiedTabOrder?.some((ref) => ref.id === 'consult-0')).toBe(false);
		// The person's own tab is untouched.
		expect(opened.agent.aiTabs?.[0].id).toBe('main');
		expect(opened.agent.activeTabId).toBe('main');
		// The new pairing never resumes the replaced asker's provider session.
		expect(opened.resumeAgentSessionId).toBeUndefined();
		expect(opened.tab.agentSessionId ?? null).toBeNull();
	});

	it('still reuses an existing pairing at the cap without replacing anything', () => {
		const agent = agentWith(fullTabs());
		const opened = openConsultTabRecord(
			agent,
			{
				key: { sourceSessionId: `${REMOTE_ASKER_SESSION_PREFIX}peer`, sourceTabId: 'key-7' },
				name: '↩ Peer',
				question: question as never,
			},
			ctx,
			DEFAULT_TAB_DEFAULTS
		);
		expect(opened.created).toBe(false);
		expect(opened.tab.id).toBe('consult-7');
		expect(opened.resumeAgentSessionId).toBe('provider-7');
		expect(opened.agent.aiTabs).toHaveLength(MAX_CONSULT_TABS_PER_AGENT + 1);
	});
});
