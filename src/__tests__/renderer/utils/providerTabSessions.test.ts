/**
 * Tests for the turn settings codified at send.
 *
 * Settings are codified when the user hits send (or queues): a turn runs, and
 * is labeled, with the provider, model, and effort in force at that moment,
 * whatever the user changes while it waits or works.
 *
 * The provider swap these used to sit beside moved to maestro-lib, and its
 * tests with it (`src/__tests__/shared/maestro-lib/agents/providerSwap.test.ts`).
 * This file only checks that the renderer's import site still reaches it.
 */

import { describe, it, expect } from 'vitest';
import {
	switchAgentProvider,
	switchTabProvider,
	resolveTurnProvider,
	updateProviderSlot,
	codifyTurnSettings,
	captureQueuedTurnSettings,
	codifyQueuedTurnSettings,
} from '../../../renderer/utils/providerTabSessions';
import * as providerSwap from '../../../shared/maestro-lib/agents/providerSwap';
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

describe('provider swap re-exports', () => {
	it('are the library implementation, so the desktop and the TUI cannot drift', () => {
		expect(switchAgentProvider).toBe(providerSwap.switchAgentProvider);
		expect(switchTabProvider).toBe(providerSwap.switchTabProvider);
		expect(resolveTurnProvider).toBe(providerSwap.resolveTurnProvider);
		expect(updateProviderSlot).toBe(providerSwap.updateProviderSlot);
	});

	it('switch a desktop agent without dropping a tab', () => {
		const session = makeSession('claude-code', {
			customModel: 'opus',
			aiTabs: [makeTab({ agentSessionId: 'claude-abc' }), makeTab({ id: 'tab-2' })],
		});

		const { agent } = switchAgentProvider(session, 'codex');

		expect(agent.toolType).toBe('codex');
		expect(agent.aiTabs.map((tab) => tab.id)).toEqual(['tab-1', 'tab-2']);
		expect(agent.aiTabs[0].providerSessions?.['claude-code']?.agentSessionId).toBe('claude-abc');
		expect(agent.providerOverrides?.['claude-code']).toEqual({ customModel: 'opus' });
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

describe('captureQueuedTurnSettings', () => {
	it('freezes the model and effort in force when the item is queued', () => {
		const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });
		const session = makeSession('claude-code', { customModel: 'sonnet', customEffort: 'low' });

		expect(captureQueuedTurnSettings(tab, session)).toEqual({
			model: 'opus',
			effort: 'xhigh',
		});
	});

	it('captures the agent default as an explicit pair of undefined fields', () => {
		// The OBJECT is the capture flag, so it must exist even when both values
		// are the agent's own default - otherwise dispatch falls back to the live
		// values and the item inherits a model the user picked afterwards.
		const captured = captureQueuedTurnSettings(makeTab(), makeSession('codex'));

		expect(captured).toEqual({ model: undefined, effort: undefined });
	});
});

describe('codifyQueuedTurnSettings', () => {
	it('runs a queued item under what it was queued with, not the live values', () => {
		const item = { turnSettings: { model: 'haiku', effort: 'low' } };
		// The user has since switched the tab to a big model.
		const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });
		const session = makeSession('claude-code');

		expect(codifyQueuedTurnSettings(item, tab, session)).toEqual({
			turnProvider: 'claude-code',
			turnModel: 'haiku',
			turnEffort: 'low',
		});
	});

	it('keeps an item queued on the agent default on the default', () => {
		const item = { turnSettings: {} };
		const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });

		expect(codifyQueuedTurnSettings(item, tab, makeSession('claude-code'))).toEqual({
			turnProvider: 'claude-code',
			turnModel: undefined,
			turnEffort: undefined,
		});
	});

	it('falls back to the live values for items queued before capture existed', () => {
		const tab = makeTab({ customModel: 'opus', customEffort: 'xhigh' });

		expect(codifyQueuedTurnSettings({}, tab, makeSession('claude-code'))).toEqual({
			turnProvider: 'claude-code',
			turnModel: 'opus',
			turnEffort: 'xhigh',
		});
	});

	it('always spawns on the live provider, which owns the resume token', () => {
		const item = { turnSettings: { model: 'haiku', effort: 'low' } };

		expect(codifyQueuedTurnSettings(item, makeTab(), makeSession('codex')).turnProvider).toBe(
			'codex'
		);
	});

	it('honors an override the user set while EDITING the queued message', () => {
		// The queued item was captured on haiku/low, then the user opened the
		// edit modal and switched it to opus/xhigh. The edit rewrites
		// turnSettings, so dispatch must spawn on the edited values - not the
		// original capture, and not the tab's live selection either.
		const edited = { turnSettings: { model: 'opus', effort: 'xhigh' } };
		const tab = makeTab({ customModel: 'sonnet', customEffort: 'medium' });

		expect(codifyQueuedTurnSettings(edited, tab, makeSession('claude-code'))).toEqual({
			turnProvider: 'claude-code',
			turnModel: 'opus',
			turnEffort: 'xhigh',
		});
	});

	it('sends an edited-back-to-default message on the agent default', () => {
		// Clearing a picker in the edit modal drops the field. That must mean
		// "use the agent default", not "fall back to the tab's current model".
		const cleared = { turnSettings: { effort: 'xhigh' } };
		const tab = makeTab({ customModel: 'sonnet', customEffort: 'medium' });

		expect(codifyQueuedTurnSettings(cleared, tab, makeSession('claude-code'))).toEqual({
			turnProvider: 'claude-code',
			turnModel: undefined,
			turnEffort: 'xhigh',
		});
	});
});
