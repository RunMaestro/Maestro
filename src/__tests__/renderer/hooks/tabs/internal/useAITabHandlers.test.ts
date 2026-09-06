import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAITabHandlers } from '../../../../../renderer/hooks/tabs/internal/useAITabHandlers';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { getLiveDraft, setLiveDraft } from '../../../../../renderer/utils/liveDraftStore';
import {
	clearDesktopAiTabSelections,
	consumeDesktopAiTabSelection,
} from '../../../../../renderer/utils/desktopTabSelectionSync';
import { createMockAITab, getSession, resetTabHandlerStores, setupSession } from './testUtils';

const inlineWizardMocks = vi.hoisted(() => ({
	endWizard: vi.fn(async () => null),
}));

const runtimeMocks = vi.hoisted(() => ({
	isWebDesktop: vi.fn(() => false),
}));

vi.mock('../../../../../renderer/contexts/InlineWizardContext', () => ({
	useInlineWizardContext: () => ({
		endWizard: inlineWizardMocks.endWizard,
	}),
}));

vi.mock('../../../../../renderer/utils/runtimeContext', () => runtimeMocks);

describe('useAITabHandlers', () => {
	beforeEach(() => {
		resetTabHandlerStores();
		clearDesktopAiTabSelections();
		inlineWizardMocks.endWizard.mockClear();
		runtimeMocks.isWebDesktop.mockReturnValue(false);
	});

	afterEach(() => {
		cleanup();
	});

	it('creates a new AI tab with default settings', () => {
		setupSession({
			aiTabs: [createMockAITab({ id: 'ai-1' })],
			inputMode: 'terminal',
			activeTerminalTabId: 'terminal-1',
		});
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
		expect(session.inputMode).toBe('ai');
		expect(session.activeTerminalTabId).toBeNull();
	});

	it('requests a desktop-owned tab instead of creating a browser-local tab', () => {
		setupSession({ id: 'session-1', aiTabs: [createMockAITab({ id: 'ai-1' })] });
		runtimeMocks.isWebDesktop.mockReturnValue(true);
		const requestNewTab = vi.fn().mockResolvedValue({ tabId: 'ai-2' });
		(
			window.maestro.web as typeof window.maestro.web & { requestNewTab: typeof requestNewTab }
		).requestNewTab = requestNewTab;

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleNewTab();
		});

		expect(requestNewTab).toHaveBeenCalledWith('session-1', false);
		expect(getSession().aiTabs.map((tab) => tab.id)).toEqual(['ai-1']);
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

	it('records desktop AI-tab selections as explicit focus intent', () => {
		setupSession({
			id: 'session-1',
			aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
			activeTabId: 'ai-1',
		});

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleTabSelect('ai-2');
		});

		expect(consumeDesktopAiTabSelection('session-1', 'ai-2')).toBe(true);
	});

	it('does not record Web-Desktop selections as desktop focus intent', () => {
		setupSession({
			id: 'session-1',
			aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
			activeTabId: 'ai-1',
		});
		runtimeMocks.isWebDesktop.mockReturnValue(true);

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleTabSelect('ai-2');
		});

		expect(consumeDesktopAiTabSelection('session-1', 'ai-2')).toBe(false);
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

	// "Close all" is scoped to what the strip draws. A hidden consult tab holds a
	// transcript and a resume id the user was never shown a chip for, so closing it
	// here would destroy work silently.
	it('leaves a hidden consult tab alive when closing all tabs', () => {
		const consult = createMockAITab({ id: 'consult', hidden: true });
		setupSession({
			aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' }), consult],
			activeTabId: 'ai-1',
		});

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleCloseAllTabs();
		});

		const ids = getSession().aiTabs.map((tab) => tab.id);
		expect(ids).toContain('consult');
		expect(ids).not.toContain('ai-1');
		expect(ids).not.toContain('ai-2');
	});

	// The draft prompt guards tabs the user can still get back to. A draft parked on
	// a chipless consult must not put a confirmation in front of a close-all.
	it('does not prompt about drafts that live only on hidden consult tabs', () => {
		setupSession({
			aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'consult', hidden: true })],
			activeTabId: 'ai-1',
		});
		setLiveDraft('consult', 'pending consult text');

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleCloseAllTabs();
		});

		expect(useModalStore.getState().modals.get('confirm')).toBeUndefined();
		expect(getSession().aiTabs.map((tab) => tab.id)).toContain('consult');
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
