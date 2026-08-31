/**
 * Tests for wizardActivity - rolling live per-tab wizard state up to the agents that own it.
 *
 * The liveness filter is the whole point of this module: wizard state lives in a hook map
 * keyed by tab id, and every path that removes a tab has to remember to evict its entry.
 * One that forgets used to leave `isActive: true` behind forever, and the Left Bar painted
 * a wand on an agent with no wizard tab in it.
 */

import { describe, it, expect } from 'vitest';
import {
	isWizardTab,
	rollUpWizardActivityToSessions,
	NO_WIZARD_TABS,
	type WizardTabActivity,
} from '../../../renderer/utils/wizardActivity';
import type { Session, AITab } from '../../../renderer/types';

const tab = (id: string) => ({ id }) as AITab;

const session = (id: string, tabIds: string[], overrides: Partial<Session> = {}): Session =>
	({ id, aiTabs: tabIds.map(tab), ...overrides }) as Session;

const activity = (
	entries: Array<[string, WizardTabActivity]>
): ReadonlyMap<string, WizardTabActivity> => new Map(entries);

describe('isWizardTab', () => {
	it('reports tabs present in the activity map', () => {
		const map = activity([['tab-1', { sessionId: 'agent-1', isGeneratingDocs: false }]]);
		expect(isWizardTab(map, 'tab-1')).toBe(true);
		expect(isWizardTab(map, 'tab-2')).toBe(false);
	});

	it('is false for a missing tab id rather than throwing', () => {
		expect(isWizardTab(NO_WIZARD_TABS, undefined)).toBe(false);
		expect(isWizardTab(NO_WIZARD_TABS, null)).toBe(false);
	});
});

describe('rollUpWizardActivityToSessions', () => {
	it('maps a live wizard tab to its owning agent', () => {
		const result = rollUpWizardActivityToSessions(
			activity([['tab-1', { sessionId: 'agent-1', isGeneratingDocs: false }]]),
			[session('agent-1', ['tab-1'])]
		);
		expect(result.get('agent-1')).toEqual({ isGeneratingDocs: false });
	});

	it('drops entries whose tab is no longer open', () => {
		// The phantom-wand case: the wizard was never evicted from the hook map, but its
		// tab is gone. No wand, because there is nothing left to switch to.
		const result = rollUpWizardActivityToSessions(
			activity([['closed-tab', { sessionId: 'agent-1', isGeneratingDocs: true }]]),
			[session('agent-1', ['tab-1'])]
		);
		expect(result.size).toBe(0);
	});

	it('drops entries whose agent is gone entirely', () => {
		const result = rollUpWizardActivityToSessions(
			activity([['tab-1', { sessionId: 'deleted-agent', isGeneratingDocs: false }]]),
			[session('agent-1', ['tab-1'])]
		);
		expect(result.size).toBe(0);
	});

	it('does not count a snoozed wizard tab', () => {
		// A snoozed tab is out of the strip, so a wand on the agent row points at nothing.
		const result = rollUpWizardActivityToSessions(
			activity([['snoozed-tab', { sessionId: 'agent-1', isGeneratingDocs: false }]]),
			[
				session('agent-1', ['tab-1'], {
					snoozedTabs: [{ id: 'snooze-1', tab: tab('snoozed-tab') }],
				} as Partial<Session>),
			]
		);
		expect(result.size).toBe(0);
	});

	it('ORs isGeneratingDocs across an agent with several wizard tabs', () => {
		const result = rollUpWizardActivityToSessions(
			activity([
				['tab-1', { sessionId: 'agent-1', isGeneratingDocs: false }],
				['tab-2', { sessionId: 'agent-1', isGeneratingDocs: true }],
			]),
			[session('agent-1', ['tab-1', 'tab-2'])]
		);
		expect(result.get('agent-1')).toEqual({ isGeneratingDocs: true });
	});

	it('ignores a generating tab that is closed while a live one is not generating', () => {
		const result = rollUpWizardActivityToSessions(
			activity([
				['tab-1', { sessionId: 'agent-1', isGeneratingDocs: false }],
				['closed-tab', { sessionId: 'agent-1', isGeneratingDocs: true }],
			]),
			[session('agent-1', ['tab-1'])]
		);
		expect(result.get('agent-1')).toEqual({ isGeneratingDocs: false });
	});

	it('skips entries with no owning agent recorded', () => {
		const result = rollUpWizardActivityToSessions(
			activity([['tab-1', { sessionId: null, isGeneratingDocs: false }]]),
			[session('agent-1', ['tab-1'])]
		);
		expect(result.size).toBe(0);
	});

	it('returns an empty map when nothing is running', () => {
		expect(
			rollUpWizardActivityToSessions(NO_WIZARD_TABS, [session('agent-1', ['tab-1'])]).size
		).toBe(0);
	});
});
