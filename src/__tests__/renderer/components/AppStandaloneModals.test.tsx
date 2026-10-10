import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	AppStandaloneModals,
	type AppStandaloneModalsProps,
} from '../../../renderer/components/AppStandaloneModals';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { buildTipOrder, DID_YOU_KNOW_TIPS } from '../../../shared/didYouKnow';
import { resetStore } from '../../helpers';
import { mockTheme } from '../../helpers/mockTheme';

// Keep the real discovery card and store; unrelated standalone surfaces are inert.
vi.mock('../../../renderer/components/DebugPackageModal', () => ({
	DebugPackageModal: () => null,
}));
vi.mock('../../../renderer/components/DebugApplicationStatsModal', () => ({
	DebugApplicationStatsModal: () => null,
}));
vi.mock('../../../renderer/components/DebugAgentProbeModal', () => ({
	DebugAgentProbeModal: () => null,
}));
vi.mock('../../../renderer/components/widgets/WidgetGallery', () => ({
	WidgetGallery: () => null,
}));
vi.mock('../../../renderer/components/ProfilingCaptureModal', () => ({
	ProfilingCaptureModal: () => null,
}));
vi.mock('../../../renderer/components/WindowsWarningModal', () => ({
	WindowsWarningModal: () => null,
}));
vi.mock('../../../renderer/components/OnboardingSeriesHost', () => ({
	OnboardingSeriesHost: () => null,
}));
vi.mock('../../../renderer/components/AppOverlays', () => ({
	AppOverlays: () => null,
}));
vi.mock('../../../renderer/components/GitPillModals', () => ({
	GitPillModals: () => null,
}));
vi.mock('../../../renderer/components/PlaygroundPanel', () => ({
	PlaygroundPanel: () => null,
}));
vi.mock('../../../renderer/components/GistPublishModal', () => ({
	GistPublishModal: () => null,
}));
vi.mock('../../../renderer/components/DeleteAgentConfirmModal', () => ({
	DeleteAgentConfirmModal: () => null,
}));
vi.mock('../../../renderer/components/ImageAnnotator/ImageAnnotator', () => ({
	ImageAnnotator: () => null,
}));
vi.mock('../../../renderer/components/Wizard', () => ({
	MaestroWizard: () => null,
	WizardResumeModal: () => null,
}));
vi.mock('../../../renderer/components/Wizard/tour', () => ({
	TourOverlay: () => null,
}));

const props = {
	theme: mockTheme,
	autoRunStats: { cumulativeTimeMs: 0 },
	encoreFeatures: {},
} as AppStandaloneModalsProps;

describe('AppStandaloneModals discovery card', () => {
	beforeEach(() => {
		resetStore(useModalStore);
		resetStore(useSettingsStore);
		resetStore(useSessionStore);
		useSettingsStore.setState({ didYouKnowSeed: 42 });
	});
	afterEach(cleanup);

	it('opens from store updates with the requested tip and closes through the card', async () => {
		render(<AppStandaloneModals {...props} />, { wrapper: LayerStackProvider });
		expect(screen.queryByRole('dialog', { name: 'Did You Know?' })).not.toBeInTheDocument();
		const tip = DID_YOU_KNOW_TIPS[3];
		act(() => useModalStore.getState().openModal('didYouKnow', { startTipId: tip.id }));
		expect(await screen.findByText(tip.title)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /close/i }));
		expect(useModalStore.getState().isOpen('didYouKnow')).toBe(false);
		expect(screen.queryByText(tip.title)).not.toBeInTheDocument();
	});

	it('reopens without a payload using normal rotation instead of the previous start tip', async () => {
		render(<AppStandaloneModals {...props} />, { wrapper: LayerStackProvider });
		act(() =>
			useModalStore.getState().openModal('didYouKnow', { startTipId: DID_YOU_KNOW_TIPS[3].id })
		);
		await screen.findByText(DID_YOU_KNOW_TIPS[3].title);
		act(() => useModalStore.getState().closeModal('didYouKnow'));
		act(() => useModalStore.getState().openModal('didYouKnow'));
		const firstTip = buildTipOrder(42)[0];
		expect(await screen.findByText(firstTip.title)).toBeInTheDocument();
	});
});
