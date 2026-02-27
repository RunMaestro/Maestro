/**
 * Tests for modalStore - Zustand store for modal visibility state
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useModalStore,
	useModalActions,
	selectModalOpen,
	selectModalData,
	selectModal,
	getModalActions,
	type ModalId,
	type SettingsModalData,
	type ConfirmModalData,
	type RenameInstanceModalData,
	type LightboxData,
} from '../../../renderer/stores/modalStore';
import type { Session } from '../../../renderer/types';

describe('modalStore', () => {
	beforeEach(() => {
		// Reset store to initial state before each test
		useModalStore.setState({ modals: new Map() });
	});

	describe('initial state', () => {
		it('has an empty modals map', () => {
			const state = useModalStore.getState();
			expect(state.modals.size).toBe(0);
		});

		it('reports all modals as closed by default', () => {
			const state = useModalStore.getState();
			expect(state.isOpen('settings')).toBe(false);
			expect(state.isOpen('about')).toBe(false);
			expect(state.isOpen('newInstance')).toBe(false);
		});

		it('returns undefined data for unopened modals', () => {
			const state = useModalStore.getState();
			expect(state.getData('settings')).toBeUndefined();
			expect(state.getData('confirm')).toBeUndefined();
		});
	});

	describe('openModal', () => {
		it('opens a modal without data', () => {
			const { openModal, isOpen } = useModalStore.getState();

			openModal('about');

			expect(isOpen('about')).toBe(true);
		});

		it('opens a modal with data', () => {
			const { openModal, isOpen, getData } = useModalStore.getState();
			const data: SettingsModalData = { tab: 'general' };

			openModal('settings', data);

			expect(isOpen('settings')).toBe(true);
			expect(getData('settings')).toEqual(data);
		});

		it('updates data when opening an already open modal', () => {
			const { openModal, getData } = useModalStore.getState();

			openModal('settings', { tab: 'general' });
			openModal('settings', { tab: 'shortcuts' });

			expect(getData('settings')).toEqual({ tab: 'shortcuts' });
		});

		it('does not affect other modals', () => {
			const { openModal, isOpen } = useModalStore.getState();

			openModal('about');

			expect(isOpen('about')).toBe(true);
			expect(isOpen('settings')).toBe(false);
			expect(isOpen('gitLog')).toBe(false);
		});
	});

	describe('closeModal', () => {
		it('closes an open modal', () => {
			const { openModal, closeModal, isOpen } = useModalStore.getState();

			openModal('about');
			expect(isOpen('about')).toBe(true);

			closeModal('about');
			expect(isOpen('about')).toBe(false);
		});

		it('clears modal data when closing', () => {
			const { openModal, closeModal, getData } = useModalStore.getState();

			openModal('settings', { tab: 'general' });
			closeModal('settings');

			expect(getData('settings')).toBeUndefined();
		});

		it('is idempotent for already closed modals', () => {
			const { closeModal, isOpen } = useModalStore.getState();

			closeModal('about');
			closeModal('about');

			expect(isOpen('about')).toBe(false);
		});

		it('does not affect other modals', () => {
			const { openModal, closeModal, isOpen } = useModalStore.getState();

			openModal('about');
			openModal('settings', { tab: 'general' });

			closeModal('about');

			expect(isOpen('about')).toBe(false);
			expect(isOpen('settings')).toBe(true);
		});
	});

	describe('toggleModal', () => {
		it('opens a closed modal', () => {
			const { toggleModal, isOpen } = useModalStore.getState();

			toggleModal('about');

			expect(isOpen('about')).toBe(true);
		});

		it('closes an open modal', () => {
			const { openModal, toggleModal, isOpen } = useModalStore.getState();

			openModal('about');
			toggleModal('about');

			expect(isOpen('about')).toBe(false);
		});

		it('opens with data', () => {
			const { toggleModal, isOpen, getData } = useModalStore.getState();

			toggleModal('settings', { tab: 'theme' });

			expect(isOpen('settings')).toBe(true);
			expect(getData('settings')).toEqual({ tab: 'theme' });
		});

		it('clears data when toggling closed', () => {
			const { openModal, toggleModal, getData } = useModalStore.getState();

			openModal('settings', { tab: 'general' });
			toggleModal('settings');

			expect(getData('settings')).toBeUndefined();
		});
	});

	describe('updateModalData', () => {
		it('updates data for an open modal', () => {
			const { openModal, updateModalData, getData } = useModalStore.getState();

			openModal('settings', { tab: 'general' });
			updateModalData('settings', { tab: 'shortcuts' });

			expect(getData('settings')).toEqual({ tab: 'shortcuts' });
		});

		it('partially updates data (merge)', () => {
			const { openModal, updateModalData, getData } = useModalStore.getState();
			const initialData: LightboxData = {
				image: 'test.png',
				images: ['test.png'],
				source: 'history',
				isGroupChat: false,
				allowDelete: true,
			};

			openModal('lightbox', initialData);
			updateModalData('lightbox', { isGroupChat: true });

			const data = getData('lightbox');
			expect(data?.image).toBe('test.png');
			expect(data?.isGroupChat).toBe(true);
			expect(data?.allowDelete).toBe(true);
		});

		it('stores data even for unopened modals', () => {
			const { updateModalData, getData, isOpen } = useModalStore.getState();

			updateModalData('settings', { tab: 'general' });

			expect(getData('settings')).toEqual({ tab: 'general' });
			expect(isOpen('settings')).toBe(false);
		});

		it('does not change open state', () => {
			const { openModal, updateModalData, isOpen } = useModalStore.getState();

			openModal('settings', { tab: 'general' });
			updateModalData('settings', { tab: 'shortcuts' });

			expect(isOpen('settings')).toBe(true);
		});
	});

	describe('closeAll', () => {
		it('closes all open modals', () => {
			const { openModal, closeAll, isOpen } = useModalStore.getState();

			openModal('about');
			openModal('settings', { tab: 'general' });
			openModal('gitLog');

			closeAll();

			expect(isOpen('about')).toBe(false);
			expect(isOpen('settings')).toBe(false);
			expect(isOpen('gitLog')).toBe(false);
		});

		it('clears all modal data', () => {
			const { openModal, closeAll, getData } = useModalStore.getState();

			openModal('settings', { tab: 'general' });
			openModal('confirm', { message: 'test', onConfirm: () => {} });

			closeAll();

			expect(getData('settings')).toBeUndefined();
			expect(getData('confirm')).toBeUndefined();
		});
	});

	describe('React hook integration', () => {
		it('provides state to React components via selectors', () => {
			const { result } = renderHook(() => useModalStore((state) => state.isOpen('settings')));

			expect(result.current).toBe(false);

			act(() => {
				useModalStore.getState().openModal('settings', { tab: 'general' });
			});

			expect(result.current).toBe(true);
		});

		it('re-renders only when subscribed modal changes', () => {
			let settingsRenderCount = 0;
			let aboutRenderCount = 0;

			const { result: settingsResult } = renderHook(() => {
				settingsRenderCount++;
				return useModalStore(selectModalOpen('settings'));
			});

			const { result: aboutResult } = renderHook(() => {
				aboutRenderCount++;
				return useModalStore(selectModalOpen('about'));
			});

			const initialSettingsRenders = settingsRenderCount;
			const initialAboutRenders = aboutRenderCount;

			// Open settings - should only re-render settings subscriber
			act(() => {
				useModalStore.getState().openModal('settings', { tab: 'general' });
			});

			expect(settingsResult.current).toBe(true);
			expect(aboutResult.current).toBe(false);
			expect(settingsRenderCount).toBe(initialSettingsRenders + 1);
			expect(aboutRenderCount).toBe(initialAboutRenders); // No change

			// Open about - should only re-render about subscriber
			act(() => {
				useModalStore.getState().openModal('about');
			});

			expect(aboutResult.current).toBe(true);
			expect(aboutRenderCount).toBe(initialAboutRenders + 1);
		});

		it('provides data via selectModalData', () => {
			const { result } = renderHook(() => useModalStore(selectModalData('settings')));

			expect(result.current).toBeUndefined();

			act(() => {
				useModalStore.getState().openModal('settings', { tab: 'theme' });
			});

			expect(result.current).toEqual({ tab: 'theme' });
		});

		it('provides full entry via selectModal', () => {
			const { result } = renderHook(() => useModalStore(selectModal('settings')));

			expect(result.current).toBeUndefined();

			act(() => {
				useModalStore.getState().openModal('settings', { tab: 'notifications' });
			});

			expect(result.current).toEqual({
				open: true,
				data: { tab: 'notifications' },
			});
		});
	});

	describe('action stability (getState extraction pattern)', () => {
		it('returns stable action references across state changes', () => {
			const actionsBefore = useModalStore.getState();

			useModalStore.getState().openModal('about');
			useModalStore.getState().openModal('settings', { tab: 'general' });

			const actionsAfter = useModalStore.getState();

			expect(actionsAfter.openModal).toBe(actionsBefore.openModal);
			expect(actionsAfter.closeModal).toBe(actionsBefore.closeModal);
			expect(actionsAfter.toggleModal).toBe(actionsBefore.toggleModal);
			expect(actionsAfter.updateModalData).toBe(actionsBefore.updateModalData);
			expect(actionsAfter.closeAll).toBe(actionsBefore.closeAll);
		});

		it('extracted actions still work correctly', () => {
			const { openModal, closeModal, isOpen, getData } = useModalStore.getState();

			openModal('settings', { tab: 'general' });
			expect(isOpen('settings')).toBe(true);
			expect(getData('settings')).toEqual({ tab: 'general' });

			closeModal('settings');
			expect(isOpen('settings')).toBe(false);
		});
	});

	describe('complex modal data types', () => {
		it('handles confirm modal with callback', () => {
			const { openModal, getData } = useModalStore.getState();
			const onConfirm = vi.fn();
			const data: ConfirmModalData = {
				message: 'Are you sure?',
				onConfirm,
			};

			openModal('confirm', data);

			const retrieved = getData('confirm');
			expect(retrieved?.message).toBe('Are you sure?');

			// Execute the callback
			retrieved?.onConfirm();
			expect(onConfirm).toHaveBeenCalled();
		});

		it('handles rename instance modal data', () => {
			const { openModal, getData } = useModalStore.getState();
			const data: RenameInstanceModalData = {
				sessionId: 'session-123',
				value: 'My Session',
			};

			openModal('renameInstance', data);

			expect(getData('renameInstance')).toEqual(data);
		});

		it('handles lightbox modal with array data', () => {
			const { openModal, getData } = useModalStore.getState();
			const data: LightboxData = {
				image: 'image1.png',
				images: ['image1.png', 'image2.png', 'image3.png'],
				source: 'staged',
				isGroupChat: true,
				allowDelete: false,
			};

			openModal('lightbox', data);

			const retrieved = getData('lightbox');
			expect(retrieved?.images).toHaveLength(3);
			expect(retrieved?.isGroupChat).toBe(true);
		});
	});

	describe('modal ID type safety', () => {
		it('accepts all valid modal IDs', () => {
			const { openModal, closeModal } = useModalStore.getState();

			// This is a compile-time check - if these don't type-check, the test fails
			const validIds: ModalId[] = [
				'settings',
				'about',
				'newInstance',
				'editAgent',
				'shortcutsHelp',
				'quickAction',
				'confirm',
				'quitConfirm',
				'renameInstance',
				'renameTab',
				'renameGroup',
				'agentSessions',
				'queueBrowser',
				'batchRunner',
				'autoRunSetup',
				'marketplace',
				'wizardResume',
				'agentError',
				'worktreeConfig',
				'createWorktree',
				'createPR',
				'deleteWorktree',
				'tabSwitcher',
				'fuzzyFileSearch',
				'promptComposer',
				'mergeSession',
				'sendToAgent',
				'newGroupChat',
				'deleteGroupChat',
				'renameGroupChat',
				'editGroupChat',
				'groupChatInfo',
				'gitDiff',
				'gitLog',
				'tour',
				'debugWizard',
				'debugPackage',
				'playground',
				'logViewer',
				'processMonitor',
				'usageDashboard',
				'standingOvation',
				'firstRunCelebration',
				'keyboardMastery',
				'leaderboard',
				'lightbox',
				'symphony',
				'updateCheck',
				'windowsWarning',
			];

			// Open and close each to verify they all work
			validIds.forEach((id) => {
				openModal(id);
				expect(useModalStore.getState().isOpen(id)).toBe(true);
				closeModal(id);
			});
		});
	});

	describe('non-React access (getState)', () => {
		it('allows reading state outside React', () => {
			useModalStore.getState().openModal('settings', { tab: 'general' });

			const state = useModalStore.getState();
			expect(state.isOpen('settings')).toBe(true);
			expect(state.getData('settings')).toEqual({ tab: 'general' });
		});

		it('allows mutations outside React', () => {
			const { openModal, closeModal, isOpen } = useModalStore.getState();

			openModal('about');
			expect(isOpen('about')).toBe(true);

			closeModal('about');
			expect(isOpen('about')).toBe(false);
		});
	});

	// ============================================================================
	// Integration Tests - End-to-End Modal Flows
	// ============================================================================

	describe('integration: settings modal flow', () => {
		it('opens with default tab → updates tab → closes → reopens with fresh state', () => {
			const { openModal, closeModal, isOpen, getData, updateModalData } = useModalStore.getState();

			// Open settings with default tab
			openModal('settings', { tab: 'general' });
			expect(isOpen('settings')).toBe(true);
			expect(getData('settings')?.tab).toBe('general');

			// Update tab while open
			updateModalData('settings', { tab: 'shortcuts' });
			expect(getData('settings')?.tab).toBe('shortcuts');

			// Close settings
			closeModal('settings');
			expect(isOpen('settings')).toBe(false);
			expect(getData('settings')).toBeUndefined();

			// Reopen - should have fresh state (the data we provide, not the old tab)
			openModal('settings', { tab: 'theme' });
			expect(isOpen('settings')).toBe(true);
			expect(getData('settings')?.tab).toBe('theme');
		});

		it('openSettings action works with specific tab', () => {
			const actions = getModalActions();

			actions.openSettings('shortcuts');
			expect(useModalStore.getState().isOpen('settings')).toBe(true);
			expect(useModalStore.getState().getData('settings')?.tab).toBe('shortcuts');

			actions.closeSettings();
			expect(useModalStore.getState().isOpen('settings')).toBe(false);
		});
	});

	describe('integration: lightbox modal flow', () => {
		it('opens with image gallery → navigates images → updates metadata', () => {
			const { openModal, updateModalData, getData, closeModal, isOpen } = useModalStore.getState();

			// Open lightbox with initial image and gallery
			const initialData: LightboxData = {
				image: 'image1.png',
				images: ['image1.png', 'image2.png', 'image3.png'],
				source: 'history',
				isGroupChat: false,
				allowDelete: false,
			};
			openModal('lightbox', initialData);

			expect(isOpen('lightbox')).toBe(true);
			expect(getData('lightbox')?.image).toBe('image1.png');
			expect(getData('lightbox')?.images).toHaveLength(3);

			// Navigate to second image
			updateModalData('lightbox', { image: 'image2.png' });
			expect(getData('lightbox')?.image).toBe('image2.png');
			// Other data should persist
			expect(getData('lightbox')?.images).toHaveLength(3);
			expect(getData('lightbox')?.source).toBe('history');

			// Update metadata (e.g., context changes)
			updateModalData('lightbox', { isGroupChat: true, allowDelete: true });
			expect(getData('lightbox')?.isGroupChat).toBe(true);
			expect(getData('lightbox')?.allowDelete).toBe(true);
			// Image should still be the navigated one
			expect(getData('lightbox')?.image).toBe('image2.png');

			// Close lightbox
			closeModal('lightbox');
			expect(isOpen('lightbox')).toBe(false);
			expect(getData('lightbox')).toBeUndefined();
		});

		it('setLightboxImage action opens and closes lightbox', () => {
			const actions = getModalActions();

			// Open with image
			actions.setLightboxImage('test.png');
			expect(useModalStore.getState().isOpen('lightbox')).toBe(true);
			expect(useModalStore.getState().getData('lightbox')?.image).toBe('test.png');

			// Close with null
			actions.setLightboxImage(null);
			expect(useModalStore.getState().isOpen('lightbox')).toBe(false);
		});
	});

	describe('integration: confirm dialog flow', () => {
		it('shows confirmation → callback fires on trigger → modal closes', () => {
			const onConfirm = vi.fn();
			const actions = getModalActions();

			// Show confirmation dialog
			actions.showConfirmation('Delete this session?', onConfirm);

			expect(useModalStore.getState().isOpen('confirm')).toBe(true);
			expect(useModalStore.getState().getData('confirm')?.message).toBe('Delete this session?');

			// Get the stored callback and invoke it
			const storedCallback = useModalStore.getState().getData('confirm')?.onConfirm;
			expect(storedCallback).toBeDefined();
			storedCallback?.();

			// Callback should have fired
			expect(onConfirm).toHaveBeenCalledTimes(1);

			// Close confirmation
			actions.closeConfirmation();
			expect(useModalStore.getState().isOpen('confirm')).toBe(false);
		});

		it('chained confirmations work correctly', () => {
			const firstConfirm = vi.fn();
			const secondConfirm = vi.fn();
			const actions = getModalActions();

			// First confirmation
			actions.showConfirmation('First action?', firstConfirm);
			useModalStore.getState().getData('confirm')?.onConfirm();
			expect(firstConfirm).toHaveBeenCalledTimes(1);
			actions.closeConfirmation();

			// Second confirmation (different callback)
			actions.showConfirmation('Second action?', secondConfirm);
			expect(useModalStore.getState().getData('confirm')?.message).toBe('Second action?');
			useModalStore.getState().getData('confirm')?.onConfirm();
			expect(secondConfirm).toHaveBeenCalledTimes(1);
			// First callback should not have been called again
			expect(firstConfirm).toHaveBeenCalledTimes(1);
		});
	});

	describe('integration: multi-modal coordination', () => {
		it('multiple modals can be open simultaneously', () => {
			const { openModal, isOpen, getData } = useModalStore.getState();

			openModal('settings', { tab: 'general' });
			openModal('about');
			openModal('lightbox', {
				image: 'test.png',
				images: ['test.png'],
				source: 'history',
				isGroupChat: false,
				allowDelete: false,
			});

			expect(isOpen('settings')).toBe(true);
			expect(isOpen('about')).toBe(true);
			expect(isOpen('lightbox')).toBe(true);

			expect(getData('settings')?.tab).toBe('general');
			expect(getData('lightbox')?.image).toBe('test.png');
		});

		it('closeAll closes all modals and clears their data', () => {
			const { openModal, closeAll, isOpen, getData } = useModalStore.getState();

			// Open multiple modals with data
			openModal('settings', { tab: 'shortcuts' });
			openModal('confirm', { message: 'Are you sure?', onConfirm: vi.fn() });
			openModal('lightbox', {
				image: 'img.png',
				images: ['img.png'],
				source: 'staged',
				isGroupChat: true,
				allowDelete: true,
			});

			// Verify all are open
			expect(isOpen('settings')).toBe(true);
			expect(isOpen('confirm')).toBe(true);
			expect(isOpen('lightbox')).toBe(true);

			// Close all
			closeAll();

			// All should be closed
			expect(isOpen('settings')).toBe(false);
			expect(isOpen('confirm')).toBe(false);
			expect(isOpen('lightbox')).toBe(false);

			// All data should be cleared
			expect(getData('settings')).toBeUndefined();
			expect(getData('confirm')).toBeUndefined();
			expect(getData('lightbox')).toBeUndefined();
		});

		it('modals maintain state isolation', () => {
			const { openModal, updateModalData, closeModal, getData } = useModalStore.getState();

			// Open two modals with data
			openModal('settings', { tab: 'general' });
			openModal('renameGroup', { groupId: 'g1', value: 'Group 1', emoji: '🚀' });

			// Update one modal's data
			updateModalData('settings', { tab: 'theme' });

			// Other modal's data should be unchanged
			expect(getData('renameGroup')).toEqual({
				groupId: 'g1',
				value: 'Group 1',
				emoji: '🚀',
			});

			// Close one modal
			closeModal('settings');

			// Other modal should still have its data
			expect(getData('renameGroup')).toEqual({
				groupId: 'g1',
				value: 'Group 1',
				emoji: '🚀',
			});
		});
	});

	describe('integration: worktree modal flow', () => {
		it('create worktree flow with session data', () => {
			const mockSession = {
				id: 'session-1',
				name: 'Test Session',
				agentType: 'claude-code',
			} as unknown as Session;

			const actions = getModalActions();

			// Open create worktree modal with session
			actions.setCreateWorktreeSession(mockSession);
			expect(useModalStore.getState().isOpen('createWorktree')).toBe(true);
			expect(useModalStore.getState().getData('createWorktree')?.session).toEqual(mockSession);

			// Close by setting null
			actions.setCreateWorktreeSession(null);
			expect(useModalStore.getState().isOpen('createWorktree')).toBe(false);
		});
	});

	describe('integration: rename flows', () => {
		it('rename instance flow preserves session ID while updating value', () => {
			const { openModal, updateModalData, getData } = useModalStore.getState();

			// Open rename modal with initial data
			openModal('renameInstance', {
				sessionId: 'sess-123',
				value: 'My Session',
			});

			// User types new name
			updateModalData('renameInstance', { value: 'Renamed Session' });

			// Session ID should persist, value should update
			expect(getData('renameInstance')).toEqual({
				sessionId: 'sess-123',
				value: 'Renamed Session',
			});
		});

		it('rename group flow with emoji update', () => {
			const { openModal, updateModalData, getData } = useModalStore.getState();

			// Open rename group modal with initial data
			openModal('renameGroup', { groupId: 'group-1', value: 'Old Name', emoji: '📁' });

			// User updates the name and emoji
			updateModalData('renameGroup', { value: 'Work Projects' });
			updateModalData('renameGroup', { emoji: '💼' });

			const data = getData('renameGroup');
			expect(data?.groupId).toBe('group-1');
			expect(data?.value).toBe('Work Projects');
			expect(data?.emoji).toBe('💼');
		});
	});

	describe('integration: React subscription isolation', () => {
		it('opening unrelated modal does not trigger settings subscriber', () => {
			let settingsRenderCount = 0;

			const { result: settingsResult } = renderHook(() => {
				settingsRenderCount++;
				return useModalStore(selectModalOpen('settings'));
			});

			const initialRenderCount = settingsRenderCount;
			expect(settingsResult.current).toBe(false);

			// Open a completely unrelated modal
			act(() => {
				useModalStore.getState().openModal('about');
			});

			// Settings subscriber should NOT have re-rendered
			expect(settingsRenderCount).toBe(initialRenderCount);
			expect(settingsResult.current).toBe(false);

			// Now open settings - should trigger re-render
			act(() => {
				useModalStore.getState().openModal('settings', { tab: 'general' });
			});

			expect(settingsRenderCount).toBe(initialRenderCount + 1);
			expect(settingsResult.current).toBe(true);
		});

		it('data selector only re-renders when that specific data changes', () => {
			let lightboxDataRenderCount = 0;

			const { result } = renderHook(() => {
				lightboxDataRenderCount++;
				return useModalStore(selectModalData('lightbox'));
			});

			const initialRenderCount = lightboxDataRenderCount;

			// Open lightbox with data
			act(() => {
				useModalStore.getState().openModal('lightbox', {
					image: 'test.png',
					images: ['test.png'],
					source: 'history',
					isGroupChat: false,
					allowDelete: false,
				});
			});

			expect(lightboxDataRenderCount).toBe(initialRenderCount + 1);
			expect(result.current?.image).toBe('test.png');

			// Update settings modal - should NOT trigger lightbox data subscriber
			act(() => {
				useModalStore.getState().openModal('settings', { tab: 'general' });
			});

			expect(lightboxDataRenderCount).toBe(initialRenderCount + 1);

			// Update lightbox data - SHOULD trigger re-render
			act(() => {
				useModalStore.getState().updateModalData('lightbox', { image: 'new.png' });
			});

			expect(lightboxDataRenderCount).toBe(initialRenderCount + 2);
			expect(result.current?.image).toBe('new.png');
		});
	});

	describe('no-op guards', () => {
		it('closeModal skips state update when modal is already closed', () => {
			const { closeModal } = useModalStore.getState();

			// Get initial state reference
			const stateBefore = useModalStore.getState().modals;

			// Close a modal that was never opened
			closeModal('settings');

			// Map reference should be identical (no new Map created)
			const stateAfter = useModalStore.getState().modals;
			expect(stateAfter).toBe(stateBefore);
		});

		it('closeModal skips state update when modal entry exists but is already closed', () => {
			const { openModal, closeModal } = useModalStore.getState();

			// Open and close to create an entry with open: false
			openModal('settings', { tab: 'general' });
			closeModal('settings');

			const stateBefore = useModalStore.getState().modals;

			// Close again — should be a no-op
			closeModal('settings');

			const stateAfter = useModalStore.getState().modals;
			expect(stateAfter).toBe(stateBefore);
		});

		it('openModal skips state update when already open with same data reference', () => {
			const { openModal } = useModalStore.getState();

			// Open without data
			openModal('about');
			const stateBefore = useModalStore.getState().modals;

			// Open again with same args (undefined data)
			openModal('about');
			const stateAfter = useModalStore.getState().modals;

			expect(stateAfter).toBe(stateBefore);
		});

		it('openModal does update when data reference changes', () => {
			const { openModal } = useModalStore.getState();

			openModal('settings', { tab: 'general' });
			const stateBefore = useModalStore.getState().modals;

			// Different data object — should update even if contents look the same
			openModal('settings', { tab: 'general' });
			const stateAfter = useModalStore.getState().modals;

			// New object literal means different reference, so update happens
			expect(stateAfter).not.toBe(stateBefore);
		});

		it('closeAll skips state update when no modals are open', () => {
			const { closeAll } = useModalStore.getState();

			const stateBefore = useModalStore.getState().modals;
			closeAll();
			const stateAfter = useModalStore.getState().modals;

			expect(stateAfter).toBe(stateBefore);
		});

		it('closeAll skips when all entries are already closed', () => {
			const { openModal, closeModal, closeAll } = useModalStore.getState();

			// Create entries but close them
			openModal('settings', { tab: 'general' });
			openModal('about');
			closeModal('settings');
			closeModal('about');

			const stateBefore = useModalStore.getState().modals;
			closeAll();
			const stateAfter = useModalStore.getState().modals;

			expect(stateAfter).toBe(stateBefore);
		});

		it('no-op closeModal does not trigger selector re-renders', () => {
			let renderCount = 0;

			renderHook(() => {
				renderCount++;
				return useModalStore(selectModalOpen('settings'));
			});

			const initialRenderCount = renderCount;

			// Close a modal that's not open — no-op, should not re-render
			act(() => {
				useModalStore.getState().closeModal('settings');
			});

			expect(renderCount).toBe(initialRenderCount);
		});
	});

	describe('compatibility layer: rename setters populate data before open', () => {
		it('setRenameTabId + setRenameTabInitialName + setRenameTabModalOpen preserves data', () => {
			const actions = getModalActions();

			// This is the exact call sequence from useMainKeyboardHandler and App.tsx
			actions.setRenameTabId('tab-123');
			actions.setRenameTabInitialName('My Tab');
			actions.setRenameTabModalOpen(true);

			const state = useModalStore.getState();
			expect(state.isOpen('renameTab')).toBe(true);
			expect(state.getData('renameTab')?.tabId).toBe('tab-123');
			expect(state.getData('renameTab')?.initialName).toBe('My Tab');
		});

		it('setRenameTabId with null is a no-op', () => {
			const actions = getModalActions();
			actions.setRenameTabId(null);
			expect(useModalStore.getState().isOpen('renameTab')).toBe(false);
		});

		it('setRenameInstanceValue + setRenameInstanceSessionId + setRenameInstanceModalOpen preserves data', () => {
			const actions = getModalActions();

			// Call sequence from SessionList.tsx context menu
			actions.setRenameInstanceValue('My Session');
			actions.setRenameInstanceSessionId('sess-456');
			actions.setRenameInstanceModalOpen(true);

			const state = useModalStore.getState();
			expect(state.isOpen('renameInstance')).toBe(true);
			expect(state.getData('renameInstance')?.sessionId).toBe('sess-456');
			expect(state.getData('renameInstance')?.value).toBe('My Session');
		});

		it('setRenameGroupId + setRenameGroupValue + setRenameGroupEmoji + setRenameGroupModalOpen preserves data', () => {
			const actions = getModalActions();

			// Call sequence from QuickActionsModal.tsx
			actions.setRenameGroupId('group-789');
			actions.setRenameGroupValue('Work Projects');
			actions.setRenameGroupEmoji('💼');
			actions.setRenameGroupModalOpen(true);

			const state = useModalStore.getState();
			expect(state.isOpen('renameGroup')).toBe(true);
			expect(state.getData('renameGroup')?.groupId).toBe('group-789');
			expect(state.getData('renameGroup')?.value).toBe('Work Projects');
			expect(state.getData('renameGroup')?.emoji).toBe('💼');
		});

		it('close then reopen rename tab with new data works correctly', () => {
			const actions = getModalActions();

			// First open
			actions.setRenameTabId('tab-1');
			actions.setRenameTabInitialName('First Tab');
			actions.setRenameTabModalOpen(true);

			// Close
			actions.setRenameTabModalOpen(false);
			expect(useModalStore.getState().isOpen('renameTab')).toBe(false);

			// Reopen with different data
			actions.setRenameTabId('tab-2');
			actions.setRenameTabInitialName('Second Tab');
			actions.setRenameTabModalOpen(true);

			const state = useModalStore.getState();
			expect(state.getData('renameTab')?.tabId).toBe('tab-2');
			expect(state.getData('renameTab')?.initialName).toBe('Second Tab');
		});
	});

	describe('compatibility layer: getModalActions()', () => {
		it('returns all expected action methods', () => {
			const actions = getModalActions();

			// Verify key action methods exist and are functions
			expect(typeof actions.setSettingsModalOpen).toBe('function');
			expect(typeof actions.openSettings).toBe('function');
			expect(typeof actions.closeSettings).toBe('function');
			expect(typeof actions.setLightboxImage).toBe('function');
			expect(typeof actions.showConfirmation).toBe('function');
			expect(typeof actions.closeConfirmation).toBe('function');
			expect(typeof actions.setQuitConfirmModalOpen).toBe('function');
		});

		it('actions obtained before state changes still work after', () => {
			// Get actions once, use them across multiple state changes
			const actions = getModalActions();

			actions.setSettingsModalOpen(true);
			expect(useModalStore.getState().isOpen('settings')).toBe(true);

			actions.setSettingsModalOpen(false);
			expect(useModalStore.getState().isOpen('settings')).toBe(false);

			actions.openSettings('theme');
			expect(useModalStore.getState().getData('settings')?.tab).toBe('theme');

			actions.closeSettings();
			expect(useModalStore.getState().isOpen('settings')).toBe(false);
		});

		it('actions from separate getModalActions calls operate on same store', () => {
			const actions1 = getModalActions();
			const actions2 = getModalActions();

			// Open via first reference
			actions1.setSettingsModalOpen(true);
			expect(useModalStore.getState().isOpen('settings')).toBe(true);

			// Close via second reference — should affect same store
			actions2.setSettingsModalOpen(false);
			expect(useModalStore.getState().isOpen('settings')).toBe(false);
		});
	});

	describe('compatibility layer: useModalActions()', () => {
		it('provides reactive state that updates on modal open/close', () => {
			const { result } = renderHook(() => useModalActions());

			expect(result.current.settingsModalOpen).toBe(false);

			act(() => {
				useModalStore.getState().openModal('settings', { tab: 'general' });
			});

			expect(result.current.settingsModalOpen).toBe(true);
			expect(result.current.settingsTab).toBe('general');

			act(() => {
				useModalStore.getState().closeModal('settings');
			});

			expect(result.current.settingsModalOpen).toBe(false);
			expect(result.current.settingsTab).toBe('general'); // Falls back to default
		});

		it('provides all action methods from getModalActions()', () => {
			const { result } = renderHook(() => useModalActions());

			// Verify action methods exist and are functions
			expect(typeof result.current.setSettingsModalOpen).toBe('function');
			expect(typeof result.current.openSettings).toBe('function');
			expect(typeof result.current.closeSettings).toBe('function');
			expect(typeof result.current.setLightboxImage).toBe('function');
			expect(typeof result.current.showConfirmation).toBe('function');
			expect(typeof result.current.closeConfirmation).toBe('function');
			expect(typeof result.current.setQuitConfirmModalOpen).toBe('function');
		});

		it('actions invoked through useModalActions update reactive state', () => {
			const { result } = renderHook(() => useModalActions());

			act(() => {
				result.current.openSettings('shortcuts');
			});

			expect(result.current.settingsModalOpen).toBe(true);
			expect(result.current.settingsTab).toBe('shortcuts');

			act(() => {
				result.current.closeSettings();
			});

			expect(result.current.settingsModalOpen).toBe(false);
		});

		it('quit confirm modal actions work through compatibility layer', () => {
			const { result } = renderHook(() => useModalActions());

			expect(result.current.quitConfirmModalOpen).toBe(false);

			act(() => {
				result.current.setQuitConfirmModalOpen(true);
			});

			expect(result.current.quitConfirmModalOpen).toBe(true);

			act(() => {
				result.current.setQuitConfirmModalOpen(false);
			});

			expect(result.current.quitConfirmModalOpen).toBe(false);
		});
	});
});
