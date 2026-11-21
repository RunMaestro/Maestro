import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMainPanelProps } from '../../../../renderer/hooks/props';
import type { UseMainPanelPropsDeps } from '../../../../renderer/hooks/props';
import type { Session } from '../../../../renderer/types';
import type { QueuedItem } from '../../../../renderer/types';
import { useSessionListProps } from '../../../../renderer/hooks/props';
import type { UseSessionListPropsDeps } from '../../../../renderer/hooks/props';
import { mockTheme } from '../../../helpers/mockTheme';
__maestroMicrobenchDescribe('useMainPanelProps', () => {
	// MainPanel self-sources the full Session for paint (including executionQueue).
	// useMainPanelProps must not re-export activeSession; doing so would either
	// reintroduce App-level streaming wakes or leave a stale chrome slice on the
	// prop bag. These tests guard that contract and the remaining session-field deps.

	function makeQueuedItem(overrides: Partial<QueuedItem> = {}): QueuedItem {
		return {
			id: 'q1',
			timestamp: 0,
			tabId: 't1',
			type: 'message',
			text: 'original',
			...overrides,
		};
	}

	function makeSession(overrides: Partial<Session> = {}): Session {
		return {
			id: 's1',
			activeTabId: 't1',
			inputMode: 'ai',
			projectRoot: '/repo',
			cwd: '/repo',
			executionQueue: [makeQueuedItem()],
			...overrides,
		} as unknown as Session;
	}

	const stableCancelTab = vi.fn();
	const stableCancelMergeTab = vi.fn();

	function makeDeps(activeSession: Session): UseMainPanelPropsDeps {
		return {
			activeSession,
			cancelTab: stableCancelTab,
			cancelMergeTab: stableCancelMergeTab,
		} as unknown as UseMainPanelPropsDeps;
	}

	describe('useMainPanelProps', () => {
		it('does not pass activeSession (MainPanel self-sources for paint)', () => {
			const session = makeSession();
			const { result } = renderHook(() => useMainPanelProps(makeDeps(session)));

			expect(result.current).not.toHaveProperty('activeSession');
		});

		it('does not recompute when only executionQueue changes', () => {
			// Queue edits must not wake this memo - MainPanel's store subscription
			// repaints the QUEUED list. Tracking executionQueue here would couple
			// App chrome props to a field chrome equality ignores.
			const first = makeSession({ executionQueue: [makeQueuedItem({ text: 'original' })] });
			const { result, rerender } = renderHook(
				(session: Session) => useMainPanelProps(makeDeps(session)),
				{ initialProps: first }
			);
			const firstProps = result.current;

			rerender(makeSession({ executionQueue: [makeQueuedItem({ text: 'edited' })] }));
			expect(result.current).toBe(firstProps);
		});

		it('recomputes when a tracked session field like activeTabId changes', () => {
			const first = makeSession({ activeTabId: 't1' });
			const { result, rerender } = renderHook(
				(session: Session) => useMainPanelProps(makeDeps(session)),
				{ initialProps: first }
			);
			const firstProps = result.current;

			rerender(makeSession({ activeTabId: 't2' }));
			expect(result.current).not.toBe(firstProps);
		});

		it('keeps the memoized props stable when nothing tracked changes', () => {
			const session = makeSession();

			const { result, rerender } = renderHook((s: Session) => useMainPanelProps(makeDeps(s)), {
				initialProps: session,
			});

			const firstProps = result.current;
			rerender(session);
			expect(result.current).toBe(firstProps);
		});
	});
});
__maestroMicrobenchDescribe('useSessionListProps', () => {
	function createDeps(overrides: Partial<UseSessionListPropsDeps> = {}): UseSessionListPropsDeps {
		return {
			theme: mockTheme,
			isLiveMode: false,
			webInterfaceUrl: null,
			showSessionJumpNumbers: false,
			sidebarContainerRef: { current: null },
			toggleGlobalLive: vi.fn().mockResolvedValue(undefined),
			restartWebServer: vi.fn().mockResolvedValue(null),
			toggleGroup: vi.fn(),
			handleDragStart: vi.fn(),
			handleDragOver: vi.fn(),
			handleDropOnGroup: vi.fn(),
			handleDropOnUngrouped: vi.fn(),
			finishRenamingGroup: vi.fn(),
			finishRenamingSession: vi.fn(),
			startRenamingGroup: vi.fn(),
			startRenamingSession: vi.fn(),
			showConfirmation: vi.fn(),
			createNewGroup: vi.fn(),
			setGroupParent: vi.fn(),
			handleCreateGroupAndMove: vi.fn(),
			addNewSession: vi.fn(),
			deleteSession: vi.fn(),
			deleteWorktreeGroup: vi.fn(),
			handleEditAgent: vi.fn(),
			handleOpenCreatePRSession: vi.fn(),
			handleQuickCreateWorktree: vi.fn(),
			handleOpenWorktreeConfigSession: vi.fn(),
			handleDeleteWorktreeSession: vi.fn(),
			handleToggleWorktreeExpanded: vi.fn(),
			handleConfigureCue: vi.fn(),
			maestroCueEnabled: false,
			openWizardModal: vi.fn(),
			handleOpenFeedbackModal: vi.fn(),
			handleStartTour: vi.fn(),
			handleOpenGroupChat: vi.fn(),
			handleNewGroupChat: vi.fn(),
			handleEditGroupChat: vi.fn(),
			handleOpenRenameGroupChatModal: vi.fn(),
			handleOpenDeleteGroupChatModal: vi.fn(),
			handleArchiveGroupChat: vi.fn(),
			handleDeleteAllArchivedGroupChats: vi.fn(),
			...overrides,
		};
	}

	describe('useSessionListProps', () => {
		it('hides the Maestro Cue configure action when the Encore Feature is disabled', () => {
			const handleConfigureCue = vi.fn();

			const { result } = renderHook(() =>
				useSessionListProps(createDeps({ handleConfigureCue, maestroCueEnabled: false }))
			);

			expect(result.current.onConfigureCue).toBeUndefined();
		});

		it('passes the Maestro Cue configure action when the Encore Feature is enabled', () => {
			const handleConfigureCue = vi.fn();

			const { result } = renderHook(() =>
				useSessionListProps(createDeps({ handleConfigureCue, maestroCueEnabled: true }))
			);

			expect(result.current.onConfigureCue).toBe(handleConfigureCue);
		});
	});
});
