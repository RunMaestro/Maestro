import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAITabHandlers } from '../../../../../renderer/hooks/tabs/internal/useAITabHandlers';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { getLiveDraft, setLiveDraft } from '../../../../../renderer/utils/liveDraftStore';
import { createMockAITab, getSession, resetTabHandlerStores, setupSession } from './testUtils';

const inlineWizardMocks = vi.hoisted(() => ({
	endWizard: vi.fn(async () => null),
}));

vi.mock('../../../../../renderer/contexts/InlineWizardContext', () => ({
	useInlineWizardContext: () => ({
		endWizard: inlineWizardMocks.endWizard,
	}),
}));

describe('useAITabHandlers', () => {
	beforeEach(() => {
		resetTabHandlerStores();
		inlineWizardMocks.endWizard.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('creates a new AI tab with default settings', () => {
		setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
		useSettingsStore.setState({
			defaultSaveToHistory: false,
			defaultShowThinking: 'sticky',
		} as any);

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleNewTab();
		});

		const session = getSession();
		expect(session.aiTabs).toHaveLength(2);
		expect(session.aiTabs[1]).toMatchObject({
			saveToHistory: false,
			showThinking: 'sticky',
		});
		expect(session.activeTabId).toBe(session.aiTabs[1].id);
	});

	it('restores an orphaned thinking tab when selected', () => {
		const orphan = createMockAITab({ id: 'orphan-1', state: 'busy' });
		setupSession({
			aiTabs: [createMockAITab({ id: 'ai-1' })],
			orphanedThinkingTabs: [orphan],
		});

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleTabSelect('orphan-1');
		});

		expect(getSession().aiTabs.map((tab) => tab.id)).toContain('orphan-1');
		expect(getSession().activeTabId).toBe('orphan-1');
		expect(getSession().orphanedThinkingTabs).toBeUndefined();
	});

	it('opens draft confirmation and clears live draft after confirm', () => {
		const tab = createMockAITab({ id: 'ai-1' });
		setupSession({ aiTabs: [tab] });
		setLiveDraft('ai-1', 'pending prompt');

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleTabClose('ai-1');
		});

		const modal = useModalStore.getState().modals.get('confirm');
		expect(modal?.data?.message).toBe(
			'This tab has an unsent draft. Are you sure you want to close it?'
		);

		act(() => {
			modal?.data?.onConfirm();
		});

		expect(getLiveDraft('ai-1')).toBeUndefined();
		expect(getSession().aiTabs).toHaveLength(1);
	});

	it('ends wizard state when a wizard tab closes directly', async () => {
		const wizardTab = createMockAITab({
			id: 'wizard-1',
			wizardState: { isActive: true } as any,
		});
		setupSession({ aiTabs: [wizardTab, createMockAITab({ id: 'ai-2' })] });

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleTabClose('wizard-1');
		});

		await vi.waitFor(() => {
			expect(inlineWizardMocks.endWizard).toHaveBeenCalledWith('wizard-1');
		});
	});

	it('persists star changes through the provider-specific API', () => {
		const tab = createMockAITab({ id: 'ai-1', agentSessionId: 'agent-1' });
		setupSession({
			aiTabs: [tab],
			toolType: 'codex' as any,
			projectRoot: '/repo',
		});

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleTabStar('ai-1', true);
		});

		expect(window.maestro.agentSessions.setSessionStarred).toHaveBeenCalledWith(
			'codex',
			'/repo',
			'agent-1',
			true
		);
		expect(getSession().aiTabs[0].starred).toBe(true);
	});
});
