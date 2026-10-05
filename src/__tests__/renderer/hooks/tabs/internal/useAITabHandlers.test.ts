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

// Phase 9: the hosted-runtime flag defaults to false, so every test outside the hosted describe runs
// the OFF path unchanged. The operations are mocked so a test sees the command, not the runtime.
const hostedMocks = vi.hoisted(() => ({
	isLibraryRuntimeHosting: vi.fn(() => false),
	createAiTab: vi.fn(async () => ({ ok: true, value: { tabId: '' } })),
	closeAiTab: vi.fn(async () => ({ ok: true, value: undefined })),
	setAiTabStarred: vi.fn(async () => ({ ok: true, value: undefined })),
	runtimeAnchorFor: vi.fn(() => undefined as unknown),
}));

vi.mock('../../../../../renderer/services/libraryRuntime', async () => {
	const actual = await vi.importActual<
		typeof import('../../../../../renderer/services/libraryRuntime')
	>('../../../../../renderer/services/libraryRuntime');
	return { ...actual, isLibraryRuntimeHosting: hostedMocks.isLibraryRuntimeHosting };
});
vi.mock('../../../../../renderer/services/agentOps', () => ({
	createAiTab: hostedMocks.createAiTab,
	closeAiTab: hostedMocks.closeAiTab,
	setAiTabStarred: hostedMocks.setAiTabStarred,
}));
vi.mock('../../../../../renderer/services/runtimeMirror', async () => {
	const actual = await vi.importActual<
		typeof import('../../../../../renderer/services/runtimeMirror')
	>('../../../../../renderer/services/runtimeMirror');
	return { ...actual, runtimeAnchorFor: hostedMocks.runtimeAnchorFor };
});

describe('useAITabHandlers', () => {
	beforeEach(() => {
		resetTabHandlerStores();
		clearDesktopAiTabSelections();
		inlineWizardMocks.endWizard.mockClear();
		runtimeMocks.isWebDesktop.mockReturnValue(false);
		hostedMocks.isLibraryRuntimeHosting.mockReturnValue(false);
		hostedMocks.createAiTab.mockClear();
		hostedMocks.closeAiTab.mockClear();
		hostedMocks.setAiTabStarred.mockClear();
		hostedMocks.runtimeAnchorFor.mockReset();
		hostedMocks.runtimeAnchorFor.mockReturnValue(undefined);
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

	it('asks the desktop for the tab rather than minting a browser-local id', () => {
		setupSession({ id: 'session-1', aiTabs: [createMockAITab({ id: 'ai-1' })] });
		runtimeMocks.isWebDesktop.mockReturnValue(true);
		const requestNewTab = vi.fn(() => new Promise(() => {}));
		(
			window.maestro.web as typeof window.maestro.web & { requestNewTab: typeof requestNewTab }
		).requestNewTab = requestNewTab;

		const { result } = renderHook(() => useAITabHandlers());
		act(() => {
			result.current.handleNewTab();
		});

		// The desktop owns the tab inventory, so the id has to come from there.
		// Inventing one here would be drawn now and then added a SECOND time
		// under the desktop's id by the next inventory broadcast.
		expect(requestNewTab).toHaveBeenCalledWith('session-1', false);
		expect(getSession().aiTabs.map((tab) => tab.id)).toEqual(['ai-1']);
	});

	it('draws and selects the desktop-minted tab as soon as the answer lands', async () => {
		setupSession({ id: 'session-1', aiTabs: [createMockAITab({ id: 'ai-1' })] });
		runtimeMocks.isWebDesktop.mockReturnValue(true);
		useSettingsStore.setState({
			defaultSaveToHistory: false,
			defaultShowThinking: 'sticky',
		} as any);
		const requestNewTab = vi.fn().mockResolvedValue({ tabId: 'ai-2' });
		(
			window.maestro.web as typeof window.maestro.web & { requestNewTab: typeof requestNewTab }
		).requestNewTab = requestNewTab;

		const { result } = renderHook(() => useAITabHandlers());
		await act(async () => {
			result.current.handleNewTab();
		});

		// Waiting for the desktop's inventory broadcast instead would leave the
		// tap doing nothing for up to the 500ms poll interval.
		const session = getSession();
		expect(session.aiTabs.map((tab) => tab.id)).toEqual(['ai-1', 'ai-2']);
		expect(session.aiTabs[1]).toMatchObject({ saveToHistory: false, showThinking: 'sticky' });
		expect(session.activeTabId).toBe('ai-2');
		expect(session.inputMode).toBe('ai');
	});

	it('only selects the tab when the inventory broadcast wins the race', async () => {
		setupSession({ id: 'session-1', aiTabs: [createMockAITab({ id: 'ai-1' })] });
		runtimeMocks.isWebDesktop.mockReturnValue(true);
		const requestNewTab = vi.fn(async () => {
			// The desktop commits the tab before it answers, so its 500ms poll can
			// broadcast the new inventory first. Adopting the id again here would
			// put the same tab in the strip twice.
			setupSession({
				id: 'session-1',
				aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
			});
			return { tabId: 'ai-2' };
		});
		(
			window.maestro.web as typeof window.maestro.web & { requestNewTab: typeof requestNewTab }
		).requestNewTab = requestNewTab;

		const { result } = renderHook(() => useAITabHandlers());
		await act(async () => {
			result.current.handleNewTab();
		});

		const session = getSession();
		expect(session.aiTabs.map((tab) => tab.id)).toEqual(['ai-1', 'ai-2']);
		expect(session.activeTabId).toBe('ai-2');
	});

	it('focuses the composer inside the tap, not when the answer arrives', async () => {
		setupSession({ id: 'session-1', aiTabs: [createMockAITab({ id: 'ai-1' })] });
		runtimeMocks.isWebDesktop.mockReturnValue(true);
		let resolveRequest: (value: { tabId: string }) => void = () => {};
		const requestNewTab = vi.fn(
			() =>
				new Promise<{ tabId: string }>((resolve) => {
					resolveRequest = resolve;
				})
		);
		(
			window.maestro.web as typeof window.maestro.web & { requestNewTab: typeof requestNewTab }
		).requestNewTab = requestNewTab;
		const textarea = document.createElement('textarea');
		document.body.appendChild(textarea);
		const inputRef = { current: textarea };

		const { result } = renderHook(() => useAITabHandlers(inputRef));
		act(() => {
			result.current.handleNewTab();
		});

		// iOS raises the on-screen keyboard only for a focus() that runs in the
		// user gesture's own call stack. Deferring it to the round trip's answer
		// moves the caret and leaves the keyboard down, so the phone user still
		// has to tap the composer - which is the whole point of focusing it.
		expect(document.activeElement).toBe(textarea);

		await act(async () => {
			resolveRequest({ tabId: 'ai-2' });
		});
		expect(document.activeElement).toBe(textarea);
		textarea.remove();
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

describe('useAITabHandlers when the library runtime is hosted', () => {
	beforeEach(() => {
		resetTabHandlerStores();
		inlineWizardMocks.endWizard.mockClear();
		runtimeMocks.isWebDesktop.mockReturnValue(false);
		hostedMocks.isLibraryRuntimeHosting.mockReturnValue(true);
		hostedMocks.createAiTab.mockClear();
		hostedMocks.closeAiTab.mockClear();
		hostedMocks.setAiTabStarred.mockClear();
		hostedMocks.runtimeAnchorFor.mockReset();
		hostedMocks.runtimeAnchorFor.mockReturnValue(undefined);
	});

	afterEach(() => {
		hostedMocks.isLibraryRuntimeHosting.mockReturnValue(false);
		cleanup();
	});

	describe('a new tab', () => {
		it('appears at once under an id this window chose, and the runtime is told the same id', () => {
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
			const created = session.aiTabs[1];
			expect(created).toMatchObject({ saveToHistory: false, showThinking: 'sticky' });
			expect(session.activeTabId).toBe(created.id);
			expect(hostedMocks.createAiTab).toHaveBeenCalledTimes(1);
			expect(hostedMocks.createAiTab).toHaveBeenCalledWith('test-session', created.id, undefined);
		});

		it('says where this window put the tab, in the runtime terms', () => {
			const anchor = { type: 'ai', id: 'ai-1' };
			hostedMocks.runtimeAnchorFor.mockReturnValue(anchor);
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });

			const { result } = renderHook(() => useAITabHandlers());
			act(() => {
				result.current.handleNewTab();
			});

			const created = getSession().aiTabs[1];
			expect(hostedMocks.runtimeAnchorFor).toHaveBeenCalledTimes(1);
			const [agentId, order, index] = hostedMocks.runtimeAnchorFor.mock.calls[0] as unknown as [
				string,
				Array<{ id: string }>,
				number,
			];
			expect(agentId).toBe('test-session');
			expect(order[index].id).toBe(created.id);
			expect(hostedMocks.createAiTab).toHaveBeenCalledWith('test-session', created.id, anchor);
		});

		it('keeps the browser path: a web client asks the desktop for the tab', () => {
			setupSession({ id: 'session-1', aiTabs: [createMockAITab({ id: 'ai-1' })] });
			runtimeMocks.isWebDesktop.mockReturnValue(true);
			const requestNewTab = vi.fn(() => new Promise(() => {}));
			(
				window.maestro.web as typeof window.maestro.web & { requestNewTab: typeof requestNewTab }
			).requestNewTab = requestNewTab;

			const { result } = renderHook(() => useAITabHandlers());
			act(() => {
				result.current.handleNewTab();
			});

			expect(requestNewTab).toHaveBeenCalledWith('session-1', false);
			expect(hostedMocks.createAiTab).not.toHaveBeenCalled();
		});

		it('sends nothing when the setting is off', () => {
			hostedMocks.isLibraryRuntimeHosting.mockReturnValue(false);
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			const { result } = renderHook(() => useAITabHandlers());
			act(() => {
				result.current.handleNewTab();
			});
			expect(getSession().aiTabs).toHaveLength(2);
			expect(hostedMocks.createAiTab).not.toHaveBeenCalled();
		});
	});

	describe('closing a tab', () => {
		it('closes it here and tells the runtime, which leaves a running turn to finish', () => {
			setupSession({
				aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
				activeTabId: 'ai-1',
			});
			const { result } = renderHook(() => useAITabHandlers());
			act(() => {
				result.current.handleTabClose('ai-2');
			});
			expect(getSession().aiTabs.map((tab) => tab.id)).toEqual(['ai-1']);
			expect(hostedMocks.closeAiTab).toHaveBeenCalledTimes(1);
			expect(hostedMocks.closeAiTab).toHaveBeenCalledWith('test-session', 'ai-2', {});
		});

		it('names the replacement tab when closing the last one made one', () => {
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })], activeTabId: 'ai-1' });
			const { result } = renderHook(() => useAITabHandlers());
			act(() => {
				result.current.handleTabClose('ai-1');
			});
			const [fresh] = getSession().aiTabs;
			expect(fresh.id).not.toBe('ai-1');
			expect(hostedMocks.closeAiTab).toHaveBeenCalledWith('test-session', 'ai-1', {
				freshTabId: fresh.id,
			});
		});

		it('waits for the confirmation of a draft before it sends anything', () => {
			setupSession({
				aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
				activeTabId: 'ai-1',
			});
			setLiveDraft('ai-2', 'unsent');
			const { result } = renderHook(() => useAITabHandlers());
			act(() => {
				result.current.handleTabClose('ai-2');
			});
			expect(hostedMocks.closeAiTab).not.toHaveBeenCalled();
			act(() => {
				useModalStore.getState().modals.get('confirm')?.data?.onConfirm();
			});
			expect(hostedMocks.closeAiTab).toHaveBeenCalledWith('test-session', 'ai-2', {});
		});

		it('sends the close of a wizard tab too', async () => {
			setupSession({
				aiTabs: [
					createMockAITab({ id: 'wizard-1', wizardState: { isActive: true } as any }),
					createMockAITab({ id: 'ai-2' }),
				],
			});
			const { result } = renderHook(() => useAITabHandlers());
			act(() => {
				result.current.handleTabClose('wizard-1');
			});
			expect(hostedMocks.closeAiTab).toHaveBeenCalledWith('test-session', 'wizard-1', {});
			await vi.waitFor(() => expect(inlineWizardMocks.endWizard).toHaveBeenCalledWith('wizard-1'));
		});

		it('sends nothing for a tab that is not there', () => {
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1' })] });
			const { result } = renderHook(() => useAITabHandlers());
			act(() => {
				result.current.performTabClose('ghost');
			});
			expect(hostedMocks.closeAiTab).not.toHaveBeenCalled();
		});

		it('sends nothing when the setting is off', () => {
			hostedMocks.isLibraryRuntimeHosting.mockReturnValue(false);
			setupSession({
				aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
			});
			const { result } = renderHook(() => useAITabHandlers());
			act(() => {
				result.current.handleTabClose('ai-2');
			});
			expect(hostedMocks.closeAiTab).not.toHaveBeenCalled();
		});
	});

	describe('closing all tabs', () => {
		it('closes every visible tab in order, naming the replacement on the last close only', async () => {
			setupSession({
				aiTabs: [
					createMockAITab({ id: 'ai-1' }),
					createMockAITab({ id: 'ai-2' }),
					createMockAITab({ id: 'consult', hidden: true }),
				],
				activeTabId: 'ai-1',
			});
			const { result } = renderHook(() => useAITabHandlers());
			await act(async () => {
				result.current.handleCloseAllTabs();
				await Promise.resolve();
			});
			const fresh = getSession().aiTabs.find((tab) => tab.id !== 'consult' && !tab.hidden)!;
			await vi.waitFor(() => expect(hostedMocks.closeAiTab).toHaveBeenCalledTimes(2));
			expect(hostedMocks.closeAiTab.mock.calls).toEqual([
				['test-session', 'ai-1', {}],
				['test-session', 'ai-2', { freshTabId: fresh.id }],
			]);
			// The hidden consult tab is never closed from here.
			expect(hostedMocks.closeAiTab.mock.calls.map((call) => call[1])).not.toContain('consult');
		});

		it('waits for one close to answer before it sends the next', async () => {
			let releaseFirst!: () => void;
			hostedMocks.closeAiTab.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						releaseFirst = () => resolve({ ok: true, value: undefined });
					})
			);
			setupSession({
				aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
				activeTabId: 'ai-1',
			});
			const { result } = renderHook(() => useAITabHandlers());
			await act(async () => {
				result.current.handleCloseAllTabs();
				await Promise.resolve();
			});
			expect(hostedMocks.closeAiTab).toHaveBeenCalledTimes(1);
			await act(async () => {
				releaseFirst();
				await Promise.resolve();
				await Promise.resolve();
			});
			expect(hostedMocks.closeAiTab).toHaveBeenCalledTimes(2);
		});
	});

	describe('starring a tab', () => {
		it('stars it here and sends the command, leaving the provider write to main', () => {
			setupSession({
				aiTabs: [createMockAITab({ id: 'ai-1', agentSessionId: 'agent-1' })],
				toolType: 'codex' as any,
				projectRoot: '/repo',
			});
			const { result } = renderHook(() => useAITabHandlers());
			act(() => {
				result.current.handleTabStar('ai-1', true);
			});
			expect(getSession().aiTabs[0].starred).toBe(true);
			expect(hostedMocks.setAiTabStarred).toHaveBeenCalledWith('test-session', 'ai-1', true);
			expect(window.maestro.agentSessions.setSessionStarred).not.toHaveBeenCalled();
		});

		it('still does nothing for a tab with no provider session yet', () => {
			setupSession({ aiTabs: [createMockAITab({ id: 'ai-1', agentSessionId: null })] });
			const { result } = renderHook(() => useAITabHandlers());
			act(() => {
				result.current.handleTabStar('ai-1', true);
			});
			expect(getSession().aiTabs[0].starred).toBeFalsy();
			expect(hostedMocks.setAiTabStarred).not.toHaveBeenCalled();
		});
	});
});
