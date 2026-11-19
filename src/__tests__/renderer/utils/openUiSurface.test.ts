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
import { usePlaybookCompletionStore } from '../../../renderer/stores/playbookCompletionStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { buildFinalSummaryFacts } from '../../../shared/playbookRunReport';
import { createMockSession } from '../../helpers/mockSession';

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

describe('openUiSurface - playbook-report', () => {
	const report = {
		playbookName: 'Message Bus',
		status: 'completed' as const,
		facts: buildFinalSummaryFacts({
			wasStopped: false,
			totalCompletedTasks: 1,
			totalElapsedMs: 1_000,
			stalledDocuments: new Map(),
			documents: [{ filename: 'doc' }],
			loopEnabled: false,
			loopIteration: 0,
			totalInputTokens: 0,
			totalOutputTokens: 0,
			totalCost: 0,
		}),
		parameters: [],
		startedAt: 0,
		finishedAt: 1_000,
	};
	const isOpen = () => selectModalOpen('playbookReport')(useModalStore.getState());
	const fs = () =>
		window.maestro.fs as unknown as {
			readDir: ReturnType<typeof vi.fn>;
			readFile: ReturnType<typeof vi.fn>;
		};

	beforeEach(() => {
		usePlaybookCompletionStore.getState().clear();
	});

	afterEach(() => {
		usePlaybookCompletionStore.getState().clear();
		useSessionStore.setState({ sessions: [], activeSessionId: '' });
	});

	it('reopens the waiting reports without reading the disk', () => {
		usePlaybookCompletionStore.getState().enqueue('agent-1', report);
		useModalStore.getState().closeModal('playbookReport');
		fs().readDir.mockClear();

		expect(openUiSurface('run-report')).toEqual({ ok: true });

		expect(isOpen()).toBe(true);
		expect(fs().readDir).not.toHaveBeenCalled();
	});

	it("with none waiting, opens the active agent's newest saved report", async () => {
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'agent-1', autoRunFolderPath: '/docs' })],
			activeSessionId: 'agent-1',
		});
		fs().readDir.mockResolvedValueOnce([
			{ name: 'message-bus-20261119-090000.json', isFile: true, isDirectory: false, path: '' },
		]);
		fs().readFile.mockResolvedValueOnce(JSON.stringify(report));

		expect(openUiSurface('playbook-report')).toEqual({ ok: true });

		await vi.waitFor(() => expect(usePlaybookCompletionStore.getState().queue).toHaveLength(1));
		expect(fs().readDir).toHaveBeenCalledWith('/docs/.maestro-reports', undefined);
		expect(isOpen()).toBe(true);
	});
});
