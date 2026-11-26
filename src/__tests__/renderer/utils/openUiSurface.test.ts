/**
 * @file openUiSurface.test.ts
 * @description `maestro-cli open feedback` must behave like the Feedback
 * button: open the modal fresh, or restore a parked draft instead of replacing
 * it (which would throw the running conversation away).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { openUiSurface } from '../../../renderer/utils/openUiSurface';
import {
	selectModalData,
	selectModalOpen,
	useModalStore,
} from '../../../renderer/stores/modalStore';
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

describe('openUiSurface - updates', () => {
	beforeEach(() => {
		useModalStore.getState().closeModal('updateCheck');
	});

	it('opens Check for Updates on its updates page by default', () => {
		expect(openUiSurface('updates')).toEqual({ ok: true });
		expect(selectModalOpen('updateCheck')(useModalStore.getState())).toBe(true);
		expect(selectModalData('updateCheck')(useModalStore.getState())?.initialView).toBe('updates');
	});

	it('deep-links to the rollback list', () => {
		expect(openUiSurface('updates', 'rollback')).toEqual({ ok: true });
		expect(selectModalData('updateCheck')(useModalStore.getState())?.initialView).toBe('rollback');
	});
});
