import { renderHook, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUnifiedTabHandlers } from '../../../../../renderer/hooks/tabs/internal/useUnifiedTabHandlers';
import {
	createMockAITab,
	createMockBrowserTab,
	createMockFileTab,
	createMockTerminalTab,
	getSession,
	resetTabHandlerStores,
	setupSession,
} from './testUtils';
import { createGroupFromTabRefs } from '../../../../../renderer/utils/panelLayout';
import type { PanelLayoutNode, TabGroup, UnifiedTabRef } from '../../../../../renderer/types';

/** Find the leaf id whose tab ref matches, so a test can focus a specific pane. */
function leafIdForTab(group: TabGroup, ref: UnifiedTabRef): string {
	let id: string | null = null;
	const walk = (node: PanelLayoutNode): void => {
		if (id) return;
		if (node.kind === 'leaf') {
			if (node.tab.type === ref.type && node.tab.id === ref.id) id = node.id;
			return;
		}
		node.children.forEach(walk);
	};
	walk(group.layout);
	if (!id) throw new Error(`No leaf for ${ref.type}:${ref.id}`);
	return id;
}

/** Build a two-pane group and focus the pane holding `focusOn`. */
function groupFocusedOn(members: UnifiedTabRef[], focusOn: UnifiedTabRef): TabGroup {
	const group = createGroupFromTabRefs(members, 'Group');
	return { ...group, focusedPaneId: leafIdForTab(group, focusOn) };
}

const inlineWizardMocks = vi.hoisted(() => ({
	endWizard: vi.fn(async () => null),
}));

vi.mock('../../../../../renderer/contexts/InlineWizardContext', () => ({
	useInlineWizardContext: () => ({
		endWizard: inlineWizardMocks.endWizard,
	}),
}));

// Phase 9: the hosted-runtime flag defaults to false, so every test outside the hosted describe runs the
// OFF path unchanged. The operations are mocked so a test sees the command, not the runtime.
const hostedMocks = vi.hoisted(() => ({
	isLibraryRuntimeHosting: vi.fn(() => false),
	closeAiTab: vi.fn(async () => ({ ok: true, value: undefined })),
	reorderTab: vi.fn(async () => ({ ok: true, value: undefined })),
	runtimeTabIndexFor: vi.fn(() => undefined as number | undefined),
}));

vi.mock('../../../../../renderer/services/libraryRuntime', async () => {
	const actual = await vi.importActual<
		typeof import('../../../../../renderer/services/libraryRuntime')
	>('../../../../../renderer/services/libraryRuntime');
	return { ...actual, isLibraryRuntimeHosting: hostedMocks.isLibraryRuntimeHosting };
});
vi.mock('../../../../../renderer/services/agentOps', () => ({
	closeAiTab: hostedMocks.closeAiTab,
	reorderTab: hostedMocks.reorderTab,
}));
vi.mock('../../../../../renderer/services/runtimeMirror', async () => {
	const actual = await vi.importActual<
		typeof import('../../../../../renderer/services/runtimeMirror')
	>('../../../../../renderer/services/runtimeMirror');
	return { ...actual, runtimeTabIndexFor: hostedMocks.runtimeTabIndexFor };
});

describe('useUnifiedTabHandlers', () => {
	beforeEach(() => {
		resetTabHandlerStores();
		inlineWizardMocks.endWizard.mockClear();
		hostedMocks.isLibraryRuntimeHosting.mockReturnValue(false);
		hostedMocks.closeAiTab.mockClear();
		hostedMocks.reorderTab.mockClear();
		hostedMocks.runtimeTabIndexFor.mockReset();
		hostedMocks.runtimeTabIndexFor.mockReturnValue(undefined);
	});

	afterEach(() => {
		cleanup();
	});

	it('reorders the unified tab order by tab id, ignoring ids that are not in it', () => {
		setupSession({
			aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
		});
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		act(() => {
			result.current.handleUnifiedTabReorder('ai-1', 'ai-2');
			result.current.handleUnifiedTabReorder('ai-1', 'gone');
		});

		expect(getSession().unifiedTabOrder).toEqual([
			{ type: 'ai', id: 'ai-2' },
			{ type: 'ai', id: 'ai-1' },
		]);
	});

	it('reorders the visible chips when hidden tabs sit between them', () => {
		// The strip renders buildUnifiedTabs, which drops hidden consult tabs while
		// their refs stay in the order. Addressing the drop by POSITION moved the
		// hidden ref instead and the strip never changed - the reported bug.
		setupSession({
			aiTabs: [
				createMockAITab({ id: 'ai-1' }),
				createMockAITab({ id: 'consult-1', hidden: true }),
				createMockAITab({ id: 'consult-2', hidden: true }),
				createMockAITab({ id: 'ai-2' }),
			],
		});
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		act(() => {
			result.current.handleUnifiedTabReorder('ai-1', 'ai-2');
		});

		expect(getSession().unifiedTabOrder).toEqual([
			{ type: 'ai', id: 'consult-1' },
			{ type: 'ai', id: 'consult-2' },
			{ type: 'ai', id: 'ai-2' },
			{ type: 'ai', id: 'ai-1' },
		]);
	});

	it('returns close-current metadata for active AI tabs without closing them', () => {
		const aiTab = createMockAITab({
			id: 'ai-1',
			inputValue: 'draft',
			wizardState: { isActive: true, currentStep: 'intent' } as any,
		});
		setupSession({ aiTabs: [aiTab] });
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		expect(result.current.handleCloseCurrentTab()).toEqual({
			type: 'ai',
			tabId: 'ai-1',
			isWizardTab: true,
			hasWizardUserInteraction: true,
			hasDraft: true,
		});
		expect(getSession().aiTabs).toHaveLength(1);
	});

	it('delegates active file close to file preview handlers', () => {
		const fileTab = createMockFileTab({ id: 'file-1' });
		setupSession({ filePreviewTabs: [fileTab], activeFileTabId: 'file-1' });
		const handleCloseFileTab = vi.fn();
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab }));

		expect(result.current.handleCloseCurrentTab()).toEqual({ type: 'file', tabId: 'file-1' });
		expect(handleCloseFileTab).toHaveBeenCalledWith('file-1');
	});

	it('closes browser current tab immediately and returns browser result', () => {
		const aiTab = createMockAITab({ id: 'ai-1' });
		const browserTab = createMockBrowserTab({ id: 'browser-1' });
		setupSession({
			aiTabs: [aiTab],
			browserTabs: [browserTab],
			activeBrowserTabId: 'browser-1',
			unifiedTabOrder: [
				{ type: 'ai', id: 'ai-1' },
				{ type: 'browser', id: 'browser-1' },
			],
		});
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		expect(result.current.handleCloseCurrentTab()).toEqual({
			type: 'browser',
			tabId: 'browser-1',
		});
		expect(getSession().browserTabs).toEqual([]);
	});

	it('closes other mixed tabs, kills terminal processes, and ends closed wizard tabs', async () => {
		const active = createMockAITab({ id: 'ai-active' });
		const wizard = createMockAITab({
			id: 'wizard-1',
			wizardState: { isActive: true } as any,
		});
		const fileTab = createMockFileTab({ id: 'file-1' });
		const browserTab = createMockBrowserTab({ id: 'browser-1' });
		const terminalTab = createMockTerminalTab({ id: 'term-1' });
		setupSession({
			aiTabs: [active, wizard],
			filePreviewTabs: [fileTab],
			browserTabs: [browserTab],
			terminalTabs: [terminalTab],
			activeTabId: active.id,
			unifiedTabOrder: [
				{ type: 'ai', id: active.id },
				{ type: 'file', id: fileTab.id },
				{ type: 'browser', id: browserTab.id },
				{ type: 'terminal', id: terminalTab.id },
				{ type: 'ai', id: wizard.id },
			],
		});
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		act(() => {
			result.current.handleCloseOtherTabs();
		});

		expect(getSession().unifiedTabOrder).toEqual([{ type: 'ai', id: 'ai-active' }]);
		expect(window.maestro.process.kill).toHaveBeenCalledWith('test-session-terminal-term-1');
		await vi.waitFor(() => {
			expect(inlineWizardMocks.endWizard).toHaveBeenCalledWith('wizard-1');
		});
	});

	describe('Cmd+W with an active tiled group closes only the focused pane', () => {
		it('targets the focused AI pane, not a lingering standalone activeTabId', () => {
			const paneA = createMockAITab({ id: 'ai-A', inputValue: 'draft' });
			const paneB = createMockAITab({ id: 'ai-B' });
			const standalone = createMockAITab({ id: 'ai-standalone' });
			const group = groupFocusedOn(
				[
					{ type: 'ai', id: 'ai-A' },
					{ type: 'ai', id: 'ai-B' },
				],
				{ type: 'ai', id: 'ai-A' }
			);
			setupSession({
				aiTabs: [paneA, paneB, standalone],
				tabGroups: [group],
				activeGroupId: group.id,
				// A stale standalone selection that the old code path would have closed instead.
				activeTabId: 'ai-standalone',
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-standalone' },
					{ type: 'group', id: group.id },
				],
			});
			const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

			expect(result.current.handleCloseCurrentTab()).toEqual({
				type: 'ai',
				tabId: 'ai-A',
				isWizardTab: false,
				hasWizardUserInteraction: false,
				hasDraft: true,
			});
		});

		it('delegates a focused file pane to the file close handler', () => {
			const fileTab = createMockFileTab({ id: 'file-1' });
			const aiPane = createMockAITab({ id: 'ai-1' });
			const group = groupFocusedOn(
				[
					{ type: 'file', id: 'file-1' },
					{ type: 'ai', id: 'ai-1' },
				],
				{ type: 'file', id: 'file-1' }
			);
			setupSession({
				aiTabs: [aiPane],
				filePreviewTabs: [fileTab],
				tabGroups: [group],
				activeGroupId: group.id,
				activeTabId: 'ai-1',
				unifiedTabOrder: [{ type: 'group', id: group.id }],
			});
			const handleCloseFileTab = vi.fn();
			const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab }));

			expect(result.current.handleCloseCurrentTab()).toEqual({ type: 'file', tabId: 'file-1' });
			expect(handleCloseFileTab).toHaveBeenCalledWith('file-1');
		});

		it('closes a focused browser pane immediately and returns the browser result', () => {
			const browserTab = createMockBrowserTab({ id: 'browser-1' });
			const aiPane = createMockAITab({ id: 'ai-1' });
			const group = groupFocusedOn(
				[
					{ type: 'browser', id: 'browser-1' },
					{ type: 'ai', id: 'ai-1' },
				],
				{ type: 'browser', id: 'browser-1' }
			);
			setupSession({
				aiTabs: [aiPane],
				browserTabs: [browserTab],
				tabGroups: [group],
				activeGroupId: group.id,
				activeTabId: 'ai-1',
				unifiedTabOrder: [{ type: 'group', id: group.id }],
			});
			const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

			expect(result.current.handleCloseCurrentTab()).toEqual({
				type: 'browser',
				tabId: 'browser-1',
			});
			expect(getSession().browserTabs).toEqual([]);
		});

		it('returns the terminal result for a focused terminal pane (keyboard handler kills the PTY)', () => {
			const terminalTab = createMockTerminalTab({ id: 'term-1' });
			const aiPane = createMockAITab({ id: 'ai-1' });
			const group = groupFocusedOn(
				[
					{ type: 'terminal', id: 'term-1' },
					{ type: 'ai', id: 'ai-1' },
				],
				{ type: 'terminal', id: 'term-1' }
			);
			setupSession({
				aiTabs: [aiPane],
				terminalTabs: [terminalTab],
				tabGroups: [group],
				activeGroupId: group.id,
				// Group is active in AI input mode; the standalone terminal-mode guard must not fire.
				inputMode: 'ai',
				unifiedTabOrder: [{ type: 'group', id: group.id }],
			});
			const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

			expect(result.current.handleCloseCurrentTab()).toEqual({ type: 'terminal', tabId: 'term-1' });
		});
	});

	it('preserves tabs with unsent drafts and closes the rest silently', () => {
		setupSession({
			aiTabs: [
				createMockAITab({ id: 'ai-1' }),
				createMockAITab({ id: 'ai-2', inputValue: 'draft' }),
				createMockAITab({ id: 'ai-3' }),
			],
			activeTabId: 'ai-1',
		});
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		act(() => {
			result.current.handleCloseTabsRight();
		});

		// ai-2 (draft) survives; ai-3 closes. No confirmation modal is opened.
		expect(getSession().aiTabs.map((t) => t.id)).toEqual(['ai-1', 'ai-2']);
	});

	it('does not close anything when the only tab in the set has a draft', () => {
		setupSession({
			aiTabs: [
				createMockAITab({ id: 'ai-1' }),
				createMockAITab({ id: 'ai-2', inputValue: 'draft' }),
			],
			activeTabId: 'ai-1',
		});
		const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

		act(() => {
			result.current.handleCloseTabsRight();
		});

		expect(getSession().aiTabs.map((t) => t.id)).toEqual(['ai-1', 'ai-2']);
	});
});

describe('useUnifiedTabHandlers when the library runtime is hosted', () => {
	beforeEach(() => {
		resetTabHandlerStores();
		inlineWizardMocks.endWizard.mockClear();
		hostedMocks.isLibraryRuntimeHosting.mockReturnValue(true);
		hostedMocks.closeAiTab.mockClear();
		hostedMocks.reorderTab.mockClear();
		hostedMocks.runtimeTabIndexFor.mockReset();
		hostedMocks.runtimeTabIndexFor.mockReturnValue(undefined);
	});

	afterEach(() => {
		hostedMocks.isLibraryRuntimeHosting.mockReturnValue(false);
		cleanup();
	});

	describe('reordering the strip', () => {
		const twoTabs = () =>
			setupSession({
				aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
			});

		it('moves the chip here and sends the move, with the index the runtime counts', () => {
			twoTabs();
			hostedMocks.runtimeTabIndexFor.mockReturnValue(1);
			const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

			act(() => {
				result.current.handleUnifiedTabReorder('ai-1', 'ai-2');
			});

			expect(getSession().unifiedTabOrder).toEqual([
				{ type: 'ai', id: 'ai-2' },
				{ type: 'ai', id: 'ai-1' },
			]);
			// The order AFTER the move is what the index is counted over.
			expect(hostedMocks.runtimeTabIndexFor).toHaveBeenCalledWith(
				'test-session',
				[
					{ type: 'ai', id: 'ai-2' },
					{ type: 'ai', id: 'ai-1' },
				],
				{ type: 'ai', id: 'ai-1' }
			);
			expect(hostedMocks.reorderTab).toHaveBeenCalledWith(
				'test-session',
				{ type: 'ai', id: 'ai-1' },
				1
			);
		});

		it('moves a tab of any kind the same way', () => {
			setupSession({
				aiTabs: [createMockAITab({ id: 'ai-1' })],
				filePreviewTabs: [createMockFileTab({ id: 'file-1' })],
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'file-1' },
				],
			});
			hostedMocks.runtimeTabIndexFor.mockReturnValue(0);
			const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));
			act(() => {
				result.current.handleUnifiedTabReorder('file-1', 'ai-1');
			});
			expect(hostedMocks.reorderTab).toHaveBeenCalledWith(
				'test-session',
				{ type: 'file', id: 'file-1' },
				0
			);
		});

		it('sends nothing when the runtime does not hold the tab yet: the next fold places it', () => {
			twoTabs();
			hostedMocks.runtimeTabIndexFor.mockReturnValue(undefined);
			const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));
			act(() => {
				result.current.handleUnifiedTabReorder('ai-1', 'ai-2');
			});
			expect(getSession().unifiedTabOrder[0]).toEqual({ type: 'ai', id: 'ai-2' });
			expect(hostedMocks.reorderTab).not.toHaveBeenCalled();
		});

		it('sends nothing for a move that did not happen', () => {
			twoTabs();
			hostedMocks.runtimeTabIndexFor.mockReturnValue(0);
			const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));
			act(() => {
				result.current.handleUnifiedTabReorder('ai-1', 'gone');
			});
			expect(hostedMocks.reorderTab).not.toHaveBeenCalled();
		});

		it('sends nothing when the setting is off', () => {
			hostedMocks.isLibraryRuntimeHosting.mockReturnValue(false);
			twoTabs();
			hostedMocks.runtimeTabIndexFor.mockReturnValue(1);
			const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));
			act(() => {
				result.current.handleUnifiedTabReorder('ai-1', 'ai-2');
			});
			expect(hostedMocks.reorderTab).not.toHaveBeenCalled();
		});
	});

	describe('closing a set of tabs', () => {
		it('archives each AI tab it closed, in order, and not the other kinds', async () => {
			setupSession({
				aiTabs: [
					createMockAITab({ id: 'ai-1' }),
					createMockAITab({ id: 'ai-2' }),
					createMockAITab({ id: 'ai-3' }),
				],
				filePreviewTabs: [createMockFileTab({ id: 'file-1' })],
				activeTabId: 'ai-1',
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'file-1' },
					{ type: 'ai', id: 'ai-2' },
					{ type: 'ai', id: 'ai-3' },
				],
			});
			const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));

			await act(async () => {
				result.current.handleCloseOtherTabs();
				await Promise.resolve();
			});

			await vi.waitFor(() => expect(hostedMocks.closeAiTab).toHaveBeenCalledTimes(2));
			expect(hostedMocks.closeAiTab.mock.calls).toEqual([
				['test-session', 'ai-2'],
				['test-session', 'ai-3'],
			]);
		});

		it('does not send a tab it left open: a draft survives the bulk close', async () => {
			setupSession({
				aiTabs: [
					createMockAITab({ id: 'ai-1' }),
					createMockAITab({ id: 'ai-2', inputValue: 'draft' }),
					createMockAITab({ id: 'ai-3' }),
				],
				activeTabId: 'ai-1',
			});
			const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));
			await act(async () => {
				result.current.handleCloseTabsRight();
				await Promise.resolve();
			});
			await vi.waitFor(() => expect(hostedMocks.closeAiTab).toHaveBeenCalledTimes(1));
			expect(hostedMocks.closeAiTab).toHaveBeenCalledWith('test-session', 'ai-3');
		});

		it('sends nothing when it closed no AI tab', () => {
			setupSession({
				aiTabs: [createMockAITab({ id: 'ai-1' })],
				filePreviewTabs: [createMockFileTab({ id: 'file-1' })],
				activeTabId: 'ai-1',
				unifiedTabOrder: [
					{ type: 'ai', id: 'ai-1' },
					{ type: 'file', id: 'file-1' },
				],
			});
			const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));
			act(() => {
				result.current.handleCloseOtherTabs();
			});
			expect(hostedMocks.closeAiTab).not.toHaveBeenCalled();
		});

		it('sends nothing when the setting is off', () => {
			hostedMocks.isLibraryRuntimeHosting.mockReturnValue(false);
			setupSession({
				aiTabs: [createMockAITab({ id: 'ai-1' }), createMockAITab({ id: 'ai-2' })],
				activeTabId: 'ai-1',
			});
			const { result } = renderHook(() => useUnifiedTabHandlers({ handleCloseFileTab: vi.fn() }));
			act(() => {
				result.current.handleCloseTabsRight();
			});
			expect(hostedMocks.closeAiTab).not.toHaveBeenCalled();
		});
	});
});
