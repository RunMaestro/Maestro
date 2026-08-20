/**
 * Tests for per-provider tab session parking.
 *
 * The behavior these lock down: changing an agent's provider must preserve the
 * user's tabs and transcripts, and a turn already in flight keeps running under
 * the provider it was sent with - so its late events belong to that provider,
 * not to whatever the agent is configured with by the time they land.
 */

import { describe, it, expect } from 'vitest';
import {
	switchTabProvider,
	resolveTurnProvider,
	updateProviderSlot,
	codifyTurnSettings,
} from '../../../renderer/utils/providerTabSessions';
import type { AITab, Session } from '../../../renderer/types';
import type { ToolType } from '../../../shared/types';

function makeTab(overrides: Partial<AITab> = {}): AITab {
	return {
		id: 'tab-1',
		agentSessionId: null,
		name: null,
		starred: false,
		logs: [],
		inputValue: '',
		stagedImages: [],
		createdAt: 0,
		state: 'idle',
		...overrides,
	} as AITab;
}

function makeSession(toolType: ToolType, overrides: Partial<Session> = {}): Session {
	return { id: 'session-1', toolType, ...overrides } as Session;
}

describe('switchTabProvider', () => {
	it('parks the outgoing provider session and clears the live slot', () => {
		const tab = makeTab({
			agentSessionId: 'claude-abc',
			usageStats: { inputTokens: 5 } as any,
			customModel: 'sonnet',
			customEffort: 'high',
		});

		const result = switchTabProvider(tab, 'claude-code', 'codex');

		expect(result.agentSessionId).toBeNull();
		expect(result.usageStats).toBeUndefined();
		expect(result.customModel).toBeUndefined();
		expect(result.customEffort).toBeUndefined();
		expect(result.providerSessions?.['claude-code']).toEqual({
			agentSessionId: 'claude-abc',
			usageStats: { inputTokens: 5 },
			customModel: 'sonnet',
			customEffort: 'high',
		});
	});

	it('never leaves the tab transcript behind', () => {
		const logs = [{ id: 'l1', timestamp: 1, source: 'user', text: 'keep me' }] as any;
		const tab = makeTab({ logs, name: 'My Tab', starred: true });

		const result = switchTabProvider(tab, 'claude-code', 'codex');

		expect(result.logs).toBe(logs);
		expect(result.name).toBe('My Tab');
		expect(result.starred).toBe(true);
		expect(result.id).toBe('tab-1');
	});

	it('restores a previously parked session on the way back', () => {
		const tab = makeTab({
			agentSessionId: 'codex-xyz',
			providerSessions: { 'claude-code': { agentSessionId: 'claude-abc', customModel: 'opus' } },
		});

		const result = switchTabProvider(tab, 'codex', 'claude-code');

		expect(result.agentSessionId).toBe('claude-abc');
		expect(result.customModel).toBe('opus');
		expect(result.providerSessions?.['codex']?.agentSessionId).toBe('codex-xyz');
		// The live provider owns the live fields, so it holds no parked entry.
		expect(result.providerSessions?.['claude-code']).toBeUndefined();
	});

	it('survives a round trip through a third provider', () => {
		let tab = makeTab({ agentSessionId: 'claude-abc' });

		tab = switchTabProvider(tab, 'claude-code', 'codex');
		tab = switchTabProvider(tab, 'codex', 'opencode');
		tab = switchTabProvider(tab, 'opencode', 'claude-code');

		expect(tab.agentSessionId).toBe('claude-abc');
	});

	it('does not resume a session the incoming provider never had', () => {
		const tab = makeTab({ agentSessionId: 'claude-abc' });

		const result = switchTabProvider(tab, 'claude-code', 'codex');

		expect(result.agentSessionId).toBeNull();
		expect(result.awaitingSessionId).toBe(false);
	});

	it('returns the tab untouched when the provider did not change', () => {
		const tab = makeTab({ agentSessionId: 'claude-abc' });

		expect(switchTabProvider(tab, 'claude-code', 'claude-code')).toBe(tab);
	});
});

describe('resolveTurnProvider', () => {
	it('attributes an in-flight turn to the provider it was sent with', () => {
		const tab = makeTab({ turnProvider: 'claude-code' });
		// The user switched the agent to Codex while Claude was still working.
		expect(resolveTurnProvider(tab, makeSession('codex'))).toBe('claude-code');
	});

	it('falls back to the current provider for a tab that never sent', () => {
		expect(resolveTurnProvider(makeTab(), makeSession('codex'))).toBe('codex');
	});
});

describe('updateProviderSlot', () => {
	it('writes to the live fields when the turn provider is still current', () => {
		const tab = makeTab();
		const result = updateProviderSlot(tab, makeSession('codex'), 'codex', {
			agentSessionId: 'codex-new',
		});

		expect(result.agentSessionId).toBe('codex-new');
		expect(result.providerSessions).toBeUndefined();
	});

	it('parks a late session ID from a provider the agent switched away from', () => {
		// Mid-turn switch: Claude's turn finishes and reports its session ID after
		// the agent is already on Codex. Writing it live would hand Codex a resume
		// token it has never heard of.
		const tab = makeTab({ agentSessionId: null, turnProvider: 'claude-code' });
		const session = makeSession('codex');

		const result = updateProviderSlot(tab, session, 'claude-code', {
			agentSessionId: 'claude-late',
		});

		expect(result.agentSessionId).toBeNull();
		expect(result.providerSessions?.['claude-code']?.agentSessionId).toBe('claude-late');
	});

	it('merges into an existing parked entry without dropping its other fields', () => {
		const tab = makeTab({
			providerSessions: { 'claude-code': { agentSessionId: 'claude-abc', customModel: 'opus' } },
		});

		const result = updateProviderSlot(tab, makeSession('codex'), 'claude-code', {
			usageStats: { inputTokens: 3 } as any,
		});

		expect(result.providerSessions?.['claude-code']).toEqual({
			agentSessionId: 'claude-abc',
			customModel: 'opus',
			usageStats: { inputTokens: 3 },
		});
	});
});

describe('codifyTurnSettings', () => {
	it('freezes the provider, model, and effort a turn is sent with', () => {
		const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });
		const session = makeSession('claude-code', { customModel: 'sonnet', customEffort: 'low' });

		expect(codifyTurnSettings(tab, session)).toEqual({
			turnProvider: 'claude-code',
			turnModel: 'opus',
			turnEffort: 'xhigh',
		});
	});

	it('falls back to the agent-level overrides when the tab has none', () => {
		const session = makeSession('codex', { customModel: 'gpt-5', customEffort: 'medium' });

		expect(codifyTurnSettings(makeTab(), session)).toEqual({
			turnProvider: 'codex',
			turnModel: 'gpt-5',
			turnEffort: 'medium',
		});
	});

	it('leaves model and effort undefined when the agent default applies', () => {
		// Undefined is meaningful: consumers render no pill rather than labeling
		// the turn with a model name nobody chose.
		expect(codifyTurnSettings(makeTab(), makeSession('claude-code'))).toEqual({
			turnProvider: 'claude-code',
			turnModel: undefined,
			turnEffort: undefined,
		});
	});
});
