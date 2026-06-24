import { act, renderHook } from '@testing-library/react';
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

	it('aggregates active sessions and generation state across tabs', () => {
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

		expect(result.current.wizardActiveSessions).toEqual(
			new Map([['session-1', { isGeneratingDocs: true }]])
		);
	});
});
