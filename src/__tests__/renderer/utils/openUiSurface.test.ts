/**
 * @file openUiSurface.test.ts
 * @description `maestro-cli open feedback` must behave like the Feedback
 * button: open the modal fresh, or restore a parked draft instead of replacing
 * it (which would throw the running conversation away).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openUiSurface } from '../../../renderer/utils/openUiSurface';
import { selectModalOpen, useModalStore } from '../../../renderer/stores/modalStore';
import { useFeedbackDraftStore } from '../../../renderer/stores/feedbackDraftStore';

describe('openUiSurface - feedback', () => {
	beforeEach(() => {
		useModalStore.getState().closeModal('feedback');
		useFeedbackDraftStore.getState().reset();
	});

	it('opens the Send Feedback modal', () => {
		expect(openUiSurface('feedback')).toEqual({ ok: true });
		expect(selectModalOpen('feedback')(useModalStore.getState())).toBe(true);
	});

	it('restores a minimized draft rather than opening a fresh modal', () => {
		useModalStore.getState().openModal('feedback');
		useFeedbackDraftStore.getState().setMinimized(true);

		expect(openUiSurface('feedback')).toEqual({ ok: true });

		expect(useFeedbackDraftStore.getState().isMinimized).toBe(false);
		expect(selectModalOpen('feedback')(useModalStore.getState())).toBe(true);
	});
});

describe('openUiSurface - quick-chat', () => {
	it('shows the Quick Chat window through the main process, not as a modal', () => {
		const show = vi.mocked(window.maestro.quickChat.window);
		show.mockClear();
		expect(openUiSurface('quick-chat')).toEqual({ ok: true });
		expect(show).toHaveBeenCalledWith('show');
	});
});
