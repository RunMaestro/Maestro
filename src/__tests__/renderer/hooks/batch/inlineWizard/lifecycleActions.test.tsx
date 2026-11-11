import { useRef } from 'react';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useInlineWizardLifecycleActions } from '../../../../../renderer/hooks/batch/inlineWizard/lifecycleActions';
import { useInlineWizardTabState } from '../../../../../renderer/hooks/batch/inlineWizard/useInlineWizardTabState';
import { endInlineWizardConversation } from '../../../../../renderer/services/inlineWizardConversation';

vi.mock('../../../../../renderer/services/inlineWizardConversation', async () => ({
	endInlineWizardConversation: vi.fn().mockResolvedValue(undefined),
}));

function useLifecycleHarness() {
	const tabState = useInlineWizardTabState();
	const generationControllersMap = useRef(new Map<string, AbortController>());
	const lifecycle = useInlineWizardLifecycleActions({
		currentTabId: tabState.currentTabId,
		setTabStates: tabState.setTabStates,
		previousUIStateRefsMap: tabState.previousUIStateRefsMap,
		conversationSessionsMap: tabState.conversationSessionsMap,
		generationControllersMap,
	});

	return {
		...tabState,
		generationControllersMap,
		...lifecycle,
	};
}

describe('inline wizard lifecycle actions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('ends an explicit tab and returns its previous UI state', async () => {
		const { result } = renderHook(() => useLifecycleHarness());
		const previousState = { readOnlyMode: true, saveToHistory: false, showThinking: 'on' as const };
		const session = {
			sessionId: 'conversation-1',
			agentType: 'claude-code' as const,
			directoryPath: '/repo',
			projectName: 'Repo',
			systemPrompt: 'prompt',
			isActive: true,
		};
		const generation = new AbortController();

		act(() => {
			result.current.setTabState('tab-a', (prev) => ({ ...prev, isActive: true }));
			result.current.previousUIStateRefsMap.current.set('tab-a', previousState);
			result.current.conversationSessionsMap.current.set('tab-a', session);
			result.current.generationControllersMap.current.set('tab-a', generation);
		});

		let restored = null as typeof previousState | null;
		await act(async () => {
			restored = await result.current.endWizard('tab-a');
		});

		expect(restored).toEqual(previousState);
		expect(result.current.getStateForTab('tab-a')).toBeUndefined();
		expect(result.current.conversationSessionsMap.current.has('tab-a')).toBe(false);
		expect(endInlineWizardConversation).toHaveBeenCalledWith(session);
		// An in-flight document generation for the ended tab is aborted and forgotten.
		expect(generation.signal.aborted).toBe(true);
		expect(result.current.generationControllersMap.current.has('tab-a')).toBe(false);
	});

	it('resets the current tab without touching another tab', () => {
		const { result } = renderHook(() => useLifecycleHarness());

		act(() => {
			result.current.setTabState('tab-a', (prev) => ({ ...prev, isActive: true }));
			result.current.setTabState('tab-b', (prev) => ({ ...prev, isActive: true }));
			result.current.setCurrentTabId('tab-a');
		});

		act(() => {
			result.current.reset();
		});

		expect(result.current.getStateForTab('tab-a')).toBeUndefined();
		expect(result.current.getStateForTab('tab-b')?.isActive).toBe(true);
	});
});
