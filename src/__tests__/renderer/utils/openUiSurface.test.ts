/**
 * @file openUiSurface.test.ts
 * @description `maestro-cli open feedback` must behave like the Feedback
 * button: open the modal fresh, or restore a parked draft instead of replacing
 * it (which would throw the running conversation away).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openUiSurface } from '../../../renderer/utils/openUiSurface';
import { selectModalOpen, useModalStore } from '../../../renderer/stores/modalStore';
import { useFeedbackDraftStore } from '../../../renderer/stores/feedbackDraftStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useThroughputGaugeStore } from '../../../renderer/stores/throughputGaugeStore';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';

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

describe('openUiSurface - throughput-gauge', () => {
	const initialEncore = useSettingsStore.getState().encoreFeatures;
	const setGaugeFlag = (on: boolean) =>
		useSettingsStore.setState((s) => ({
			encoreFeatures: { ...s.encoreFeatures, throughputGauge: on },
		}));

	beforeEach(() => {
		useThroughputGaugeStore.setState({ visible: false });
	});

	afterEach(() => {
		useSettingsStore.setState({ encoreFeatures: initialEncore });
	});

	it('shows the floating gauge through its own store, not as a modal', () => {
		setGaugeFlag(true);
		expect(openUiSurface('throughput-gauge')).toEqual({ ok: true });
		expect(useThroughputGaugeStore.getState().visible).toBe(true);
	});

	it('resolves the gauge by its aliases', () => {
		setGaugeFlag(true);
		expect(openUiSurface('tps')).toEqual({ ok: true });
		expect(useThroughputGaugeStore.getState().visible).toBe(true);
	});

	it('refuses while the Encore Feature is off, reporting to the caller only', () => {
		setGaugeFlag(false);
		const toastsBefore = useNotificationStore.getState().toasts.length;
		const result = openUiSurface('throughput-gauge');
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Settings → Plugins');
		expect(useThroughputGaugeStore.getState().visible).toBe(false);
		// No in-app toast advertising the disabled feature.
		expect(useNotificationStore.getState().toasts.length).toBe(toastsBefore);
	});
});

describe('openUiSurface - Encore-gated tabs', () => {
	const initialEncore = useSettingsStore.getState().encoreFeatures;

	afterEach(() => {
		useSettingsStore.setState({ encoreFeatures: initialEncore });
		useModalStore.getState().closeModal('usageDashboard');
	});

	it("refuses the Usage Dashboard's Cue tab while Cue is off", () => {
		useSettingsStore.setState((s) => ({
			encoreFeatures: { ...s.encoreFeatures, usageStats: true, maestroCue: false },
		}));
		const result = openUiSurface('usage-dashboard', 'cue');
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Cue');
		expect(selectModalOpen('usageDashboard')(useModalStore.getState())).toBe(false);
	});
});
