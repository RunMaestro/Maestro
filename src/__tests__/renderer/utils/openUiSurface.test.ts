/**
 * @file openUiSurface.test.ts
 * @description `maestro-cli open feedback` must behave like the Feedback
 * button: open the modal fresh, or restore a parked draft instead of replacing
 * it (which would throw the running conversation away).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openUiSurface } from '../../../renderer/utils/openUiSurface';
import {
	selectModalData,
	selectModalOpen,
	useModalStore,
} from '../../../renderer/stores/modalStore';
import { useFeedbackDraftStore } from '../../../renderer/stores/feedbackDraftStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useThroughputGaugeStore } from '../../../renderer/stores/throughputGaugeStore';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';

describe('openUiSurface - feedback', () => {
	beforeEach(() => {
		useModalStore.getState().closeModal('feedback');
		useFeedbackDraftStore.getState().reset();
	});

	it('opens the Send Feedback modal', () => {
		expect(openUiSurface({ surface: 'feedback' })).toEqual({ ok: true });
		expect(selectModalOpen('feedback')(useModalStore.getState())).toBe(true);
	});

	it('restores a minimized draft rather than opening a fresh modal', () => {
		useModalStore.getState().openModal('feedback');
		useFeedbackDraftStore.getState().setMinimized(true);

		expect(openUiSurface({ surface: 'feedback' })).toEqual({ ok: true });

		expect(useFeedbackDraftStore.getState().isMinimized).toBe(false);
		expect(selectModalOpen('feedback')(useModalStore.getState())).toBe(true);
	});
});

describe('openUiSurface - quick-chat', () => {
	it('shows the Quick Chat window through the main process, not as a modal', () => {
		const show = vi.mocked(window.maestro.quickChat.window);
		show.mockClear();
		expect(openUiSurface({ surface: 'quick-chat' })).toEqual({ ok: true });
		expect(show).toHaveBeenCalledWith('show');
	});
});

describe('openUiSurface - settings deep links', () => {
	beforeEach(() => {
		useModalStore.getState().closeModal('settings');
	});

	it.each(['system-one', 'library/speech'])('opens Settings on Models at %s', (subTab) => {
		expect(openUiSurface({ surface: 'settings', tab: 'models', subTab })).toEqual({
			ok: true,
		});
		expect(selectModalOpen('settings')(useModalStore.getState())).toBe(true);
		expect(selectModalData('settings')(useModalStore.getState())).toMatchObject({
			tab: 'models',
			subTab,
		});
	});

	it('still opens `local-models` as the Models tab', () => {
		expect(openUiSurface({ surface: 'settings', tab: 'local-models' })).toEqual({ ok: true });
		const data = selectModalData('settings')(useModalStore.getState());
		expect(data).toMatchObject({ tab: 'models' });
		expect(data?.subTab).toBeUndefined();
	});

	it('refuses an unknown inner tab and opens nothing', () => {
		const result = openUiSurface({ surface: 'settings', tab: 'models', subTab: 'nope' });
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Valid sub-tabs: overview, library, library/engines');
		expect(selectModalOpen('settings')(useModalStore.getState())).toBe(false);
	});

	it('refuses an inner tab without a tab', () => {
		const result = openUiSurface({ surface: 'settings', subTab: 'library' });
		expect(result.ok).toBe(false);
		expect(result.error).toContain('--sub-tab needs --tab');
	});
});

describe('openUiSurface - delegation graph', () => {
	beforeEach(() => {
		useModalStore.getState().closeModal('delegationGraph');
	});

	it('opens the Delegation Graph by id and by alias, with no Encore Feature to refuse it', () => {
		expect(openUiSurface({ surface: 'delegation-graph' })).toEqual({ ok: true });
		expect(selectModalOpen('delegationGraph')(useModalStore.getState())).toBe(true);
		// No scope: the graph opens on every agent.
		expect(selectModalData('delegationGraph')(useModalStore.getState())).toBeUndefined();

		useModalStore.getState().closeModal('delegationGraph');
		expect(openUiSurface({ surface: 'delegation' })).toEqual({ ok: true });
		expect(selectModalOpen('delegationGraph')(useModalStore.getState())).toBe(true);
	});

	it('refuses a tab, since the graph has none', () => {
		const result = openUiSurface({ surface: 'delegation-graph', tab: 'peers' });

		expect(result.ok).toBe(false);
		expect(result.error).toContain('has no tabs');
		expect(selectModalOpen('delegationGraph')(useModalStore.getState())).toBe(false);
	});

	it('opens the Delegation Graph on one group (`open delegation-graph --group`)', () => {
		expect(openUiSurface({ surface: 'delegation-graph', group: 'group-1' })).toEqual({
			ok: true,
		});

		expect(selectModalOpen('delegationGraph')(useModalStore.getState())).toBe(true);
		expect(selectModalData('delegationGraph')(useModalStore.getState())).toEqual({
			scope: { kind: 'group', groupId: 'group-1' },
		});
	});

	it('refuses a group on a surface that does not open on one, and opens nothing', () => {
		useModalStore.getState().closeModal('about');

		const result = openUiSurface({ surface: 'about', group: 'group-1' });

		expect(result.ok).toBe(false);
		expect(result.error).toContain('--group does not apply');
		expect(selectModalOpen('about')(useModalStore.getState())).toBe(false);
	});
});

describe('openUiSurface - group settings', () => {
	beforeEach(() => {
		useModalStore.getState().closeModal('groupSettings');
	});

	it('opens Group Settings on the group it was given', () => {
		expect(openUiSurface({ surface: 'group-settings', group: 'group-1' })).toEqual({ ok: true });
		expect(selectModalOpen('groupSettings')(useModalStore.getState())).toBe(true);
		expect(selectModalData('groupSettings')(useModalStore.getState())).toMatchObject({
			groupId: 'group-1',
		});
	});

	it('is refused without a group, and opens nothing', () => {
		const result = openUiSurface({ surface: 'group-settings' });
		expect(result.ok).toBe(false);
		expect(result.error).toContain('pass --group');
		expect(selectModalOpen('groupSettings')(useModalStore.getState())).toBe(false);
	});
});

describe('openUiSurface - agent settings', () => {
	const session = createMockSession({ id: 'agent-1', name: 'Builder' });

	beforeEach(() => {
		useModalStore.getState().closeModal('editAgent');
		useSessionStore.setState({ sessions: [session] });
	});

	it('opens Edit Agent for the agent it was given, on the tab it was last on', () => {
		expect(openUiSurface({ surface: 'agent-settings', agent: 'agent-1' })).toEqual({ ok: true });
		expect(selectModalOpen('editAgent')(useModalStore.getState())).toBe(true);
		const data = selectModalData('editAgent')(useModalStore.getState());
		expect(data?.session.id).toBe('agent-1');
		expect(data?.initialTab).toBeUndefined();
	});

	it('opens Edit Agent on the tab asked for (`open agent-settings --tab peers`)', () => {
		expect(openUiSurface({ surface: 'edit-agent', agent: 'agent-1', tab: 'Peers' })).toEqual({
			ok: true,
		});
		expect(selectModalData('editAgent')(useModalStore.getState())).toMatchObject({
			session: { id: 'agent-1' },
			initialTab: 'peers',
		});
	});

	it('is refused without an agent, and opens nothing', () => {
		const result = openUiSurface({ surface: 'agent-settings' });
		expect(result.ok).toBe(false);
		expect(result.error).toContain('pass --agent');
		expect(selectModalOpen('editAgent')(useModalStore.getState())).toBe(false);
	});

	it('is refused for an agent that is gone, and opens nothing', () => {
		const result = openUiSurface({ surface: 'agent-settings', agent: 'agent-gone' });
		expect(result).toEqual({ ok: false, error: 'Agent not found: agent-gone' });
		expect(selectModalOpen('editAgent')(useModalStore.getState())).toBe(false);
	});

	it("refuses an agent on a surface that is not one agent's, and opens nothing", () => {
		useModalStore.getState().closeModal('about');

		const result = openUiSurface({ surface: 'about', agent: 'agent-1' });

		expect(result.ok).toBe(false);
		expect(result.error).toContain('--agent does not apply');
		expect(selectModalOpen('about')(useModalStore.getState())).toBe(false);
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
		expect(openUiSurface({ surface: 'throughput-gauge' })).toEqual({ ok: true });
		expect(useThroughputGaugeStore.getState().visible).toBe(true);
	});

	it('resolves the gauge by its aliases', () => {
		setGaugeFlag(true);
		expect(openUiSurface({ surface: 'tps' })).toEqual({ ok: true });
		expect(useThroughputGaugeStore.getState().visible).toBe(true);
	});

	it('refuses while the Encore Feature is off, reporting to the caller only', () => {
		setGaugeFlag(false);
		const toastsBefore = useNotificationStore.getState().toasts.length;
		const result = openUiSurface({ surface: 'throughput-gauge' });
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
		const result = openUiSurface({ surface: 'usage-dashboard', tab: 'cue' });
		expect(result.ok).toBe(false);
		expect(result.error).toContain('Cue');
		expect(selectModalOpen('usageDashboard')(useModalStore.getState())).toBe(false);
	});
});
