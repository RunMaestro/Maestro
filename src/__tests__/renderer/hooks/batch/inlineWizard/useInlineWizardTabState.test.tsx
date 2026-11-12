import { act, renderHook } from '@testing-library/react';
import { rollUpWizardActivityToSessions } from '../../../../../renderer/utils/wizardActivity';
import { describe, expect, it } from 'vitest';
import { useInlineWizardTabState } from '../../../../../renderer/hooks/batch/inlineWizard/useInlineWizardTabState';

describe('useInlineWizardTabState', () => {
	it('uses default as the effective tab when no current tab is selected', () => {
		const { result } = renderHook(() => useInlineWizardTabState());

		let effectiveTabId = '';
		act(() => {
			effectiveTabId = result.current.getEffectiveTabId();
		});

		expect(effectiveTabId).toBe('default');
		expect(result.current.currentTabId).toBe('default');
	});

	it('stores independent wizard state per tab', () => {
		const { result } = renderHook(() => useInlineWizardTabState());

		act(() => {
			result.current.setTabState('tab-a', (prev) => ({
				...prev,
				isActive: true,
				sessionId: 'session-a',
			}));
			result.current.setTabState('tab-b', (prev) => ({
				...prev,
				isActive: true,
				sessionId: 'session-b',
				isGeneratingDocs: true,
			}));
		});

		expect(result.current.getStateForTab('tab-a')?.sessionId).toBe('session-a');
		expect(result.current.getStateForTab('tab-b')?.isGeneratingDocs).toBe(true);
	});

	it('selects the current wizard tab for backward-compatible state access', () => {
		const { result } = renderHook(() => useInlineWizardTabState());

		act(() => {
			result.current.setTabState('tab-a', (prev) => ({
				...prev,
				isActive: true,
				goal: 'first',
			}));
			result.current.setTabState('tab-b', (prev) => ({
				...prev,
				isActive: true,
				goal: 'second',
			}));
			result.current.setCurrentTabId('tab-b');
		});

		expect(result.current.state.goal).toBe('second');
		expect(result.current.isWizardActiveForTab('tab-a')).toBe(true);
	});

	it('reports wizard activity per tab, including a background tab still generating', () => {
		const { result } = renderHook(() => useInlineWizardTabState());

		act(() => {
			result.current.setTabState('tab-a', (prev) => ({
				...prev,
				isActive: true,
				sessionId: 'session-1',
				isGeneratingDocs: false,
			}));
			result.current.setTabState('tab-b', (prev) => ({
				...prev,
				isActive: true,
				sessionId: 'session-1',
				isGeneratingDocs: true,
			}));
			result.current.setTabState('tab-c', (prev) => ({
				...prev,
				isActive: false,
				sessionId: 'session-2',
				isGeneratingDocs: true,
			}));
		});

		// Keyed by TAB, not rolled up: a consumer has to check the tab is still
		// open before drawing anything against its agent. `tab-c` is inactive but
		// still writing documents, which is exactly the case a wand must survive -
		// it would be dropped by an `isActive`-only filter.
		expect(result.current.wizardActiveTabs).toEqual(
			new Map([
				['tab-a', { sessionId: 'session-1', isGeneratingDocs: false }],
				['tab-b', { sessionId: 'session-1', isGeneratingDocs: true }],
				['tab-c', { sessionId: 'session-2', isGeneratingDocs: true }],
			])
		);

		// Rolled up against open tabs, the OR-aggregate per agent is unchanged.
		const sessions = [
			{ id: 'session-1', aiTabs: [{ id: 'tab-a' }, { id: 'tab-b' }] },
			{ id: 'session-2', aiTabs: [{ id: 'tab-c' }] },
		] as unknown as Parameters<typeof rollUpWizardActivityToSessions>[1];
		expect(rollUpWizardActivityToSessions(result.current.wizardActiveTabs, sessions)).toEqual(
			new Map([
				['session-1', { isGeneratingDocs: true }],
				['session-2', { isGeneratingDocs: true }],
			])
		);
	});

	it('drops activity whose tab is no longer open when rolled up to agents', () => {
		const { result } = renderHook(() => useInlineWizardTabState());

		act(() => {
			result.current.setTabState('closed-tab', (prev) => ({
				...prev,
				isActive: true,
				sessionId: 'session-1',
				isGeneratingDocs: false,
			}));
		});

		// The hook still holds the entry (eviction is the caller's job), but the
		// agent owns no such tab - so no wand, rather than one pointing at nothing.
		expect(result.current.wizardActiveTabs.has('closed-tab')).toBe(true);
		const sessions = [{ id: 'session-1', aiTabs: [{ id: 'other-tab' }] }] as unknown as Parameters<
			typeof rollUpWizardActivityToSessions
		>[1];
		expect(rollUpWizardActivityToSessions(result.current.wizardActiveTabs, sessions).size).toBe(0);
	});
});
