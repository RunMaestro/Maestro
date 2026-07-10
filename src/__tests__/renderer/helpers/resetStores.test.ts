/**
 * Tests for shared Zustand store reset helpers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useImageAnnotatorStore } from '../../../renderer/components/ImageAnnotator/imageAnnotatorStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useModalStore } from '../../../renderer/stores/modalStore';
import {
	ALL_RENDERER_STORES,
	resetAllStores,
	resetStore,
	resetStores,
} from '../../helpers/resetStores';

describe('resetStores helpers', () => {
	beforeEach(() => {
		resetAllStores();
	});

	it('resetStore restores sessionStore defaults including a fresh Set', () => {
		useSessionStore.setState({
			sessions: [{ id: 's1' } as any],
			activeSessionId: 's1',
			cyclePosition: 3,
		});
		useSessionStore.getState().removedWorktreePaths.add('/tmp/wt');

		resetStore(useSessionStore);

		const state = useSessionStore.getState();
		expect(state.sessions).toEqual([]);
		expect(state.activeSessionId).toBe('');
		expect(state.cyclePosition).toBe(-1);
		expect(state.removedWorktreePaths.size).toBe(0);

		// Mutating the live Set must not poison the next reset
		state.removedWorktreePaths.add('/tmp/poison');
		resetStore(useSessionStore);
		expect(useSessionStore.getState().removedWorktreePaths.size).toBe(0);
		expect(useSessionStore.getState().removedWorktreePaths.has('/tmp/poison')).toBe(false);
	});

	it('resetStore clones array and plain-object defaults so in-place mutations do not leak', () => {
		const sessions = useSessionStore.getState().sessions;
		sessions.push({ id: 'poison' } as any);

		resetStore(useSessionStore);
		expect(useSessionStore.getState().sessions).toEqual([]);
		expect(useSessionStore.getState().sessions).not.toBe(sessions);
	});

	it('resetStores only touches the listed stores', () => {
		useSessionStore.setState({ activeSessionId: 'keep-me-reset' });
		useUIStore.setState({ leftSidebarOpen: false });

		resetStores(useSessionStore);

		expect(useSessionStore.getState().activeSessionId).toBe('');
		expect(useUIStore.getState().leftSidebarOpen).toBe(false);
	});

	it('resetAllStores clears modal Map entries', () => {
		useModalStore.getState().openModal('about');
		expect(useModalStore.getState().isOpen('about')).toBe(true);

		resetAllStores();

		expect(useModalStore.getState().isOpen('about')).toBe(false);
		expect(useModalStore.getState().modals.size).toBe(0);
	});

	it('resetAllStores includes and clears the image annotator store', () => {
		expect(ALL_RENDERER_STORES).toContain(useImageAnnotatorStore);

		useImageAnnotatorStore.getState().openAnnotator('data:image/png;base64,xx', () => {});
		expect(useImageAnnotatorStore.getState().isOpen).toBe(true);

		resetAllStores();

		expect(useImageAnnotatorStore.getState().isOpen).toBe(false);
		expect(useImageAnnotatorStore.getState().imageDataUrl).toBeNull();
		expect(useImageAnnotatorStore.getState().onSave).toBeNull();
	});
});
