/**
 * Tests for how AppStandaloneModals mounts the Playbook Launch dialog.
 *
 * The dialog and its host have their own suites (`MarketplaceModal/launch/`). What only this mount
 * decides is covered here: the host is drawn while the store entry the Exchange's Launch button
 * opens is open and not before, opening the Exchange alone does not draw it, it is drawn whether or
 * not the active agent has an Auto Run folder (the dialog picks its own agent), and it layers on
 * the Exchange without taking the Exchange down.
 *
 * Every other child of AppStandaloneModals draws nothing, and the lazy Exchange chunk resolves to
 * stand-ins that record the props they were given.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const exchange = vi.hoisted(() => ({
	exchangeProps: null as Record<string, any> | null,
	hostProps: null as Record<string, any> | null,
}));

// The Exchange chunk is lazy. These are what its two lazy imports resolve to.
vi.mock('../../../renderer/components/MarketplaceModal', () => ({
	MarketplaceModal: (props: Record<string, any>) => {
		exchange.exchangeProps = props;
		return <div data-testid="exchange-stub" />;
	},
	PlaybookLaunchModalHost: (props: Record<string, any>) => {
		exchange.hostProps = props;
		return <div data-testid="launch-host-stub" />;
	},
}));

// Everything else AppStandaloneModals draws has its own suite and none of it is under test here.
vi.mock('../../../renderer/components/NotificationCenter', () => ({
	NotificationCenterHost: () => null,
}));
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
vi.mock('../../../renderer/hooks/ui/useProfilingAutoStop', () => ({
	useProfilingAutoStop: () => undefined,
}));
vi.mock('../../../renderer/components/WindowsWarningModal', () => ({
	WindowsWarningModal: () => null,
}));
vi.mock('../../../renderer/components/OnboardingSeriesHost', () => ({
	OnboardingSeriesHost: () => null,
}));
vi.mock('../../../renderer/components/AppOverlays', () => ({ AppOverlays: () => null }));
vi.mock('../../../renderer/components/GitPillModals', () => ({ GitPillModals: () => null }));
vi.mock('../../../renderer/components/PlaygroundPanel', () => ({ PlaygroundPanel: () => null }));
vi.mock('../../../renderer/components/GistPublishModal', () => ({ GistPublishModal: () => null }));
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
vi.mock('../../../renderer/components/Wizard/tour', () => ({ TourOverlay: () => null }));
vi.mock('../../../renderer/components/HostFolderPicker', () => ({ HostFolderPicker: () => null }));
vi.mock('../../../renderer/components/Bundles/AgentBundleModals', () => ({
	AgentBundleModals: () => null,
}));
vi.mock('../../../renderer/components/MoveToHostModal', () => ({
	MoveToHostModalHost: () => null,
}));

import { AppStandaloneModals } from '../../../renderer/components/AppStandaloneModals';
import type { AppStandaloneModalsProps } from '../../../renderer/components/AppStandaloneModals';
import { getModalActions } from '../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { resolveEncoreFeatures } from '../../../shared/encoreFeatureDefaults';
import { createMockSession, resetAllStores } from '../../helpers';
import { mockTheme } from '../../helpers/mockTheme';
import { makePlaybook } from './MarketplaceModal/_fixtures';

const playbook = makePlaybook({
	id: 'development-code-review',
	title: 'Code Review',
	launch: { inputs: [], outro: { summary: 'Done.', nextSteps: [] } },
});

const WITH_FOLDER = createMockSession({
	id: 'with-folder',
	name: 'Alpha',
	autoRunFolderPath: '/work/alpha/.maestro/playbooks',
});
const WITHOUT_FOLDER = createMockSession({
	id: 'without-folder',
	name: 'Gamma',
	autoRunFolderPath: undefined,
});

/** The handlers and computed values App passes in. The dialog uses none of them. */
function makeProps(): AppStandaloneModalsProps {
	return {
		theme: mockTheme,
		onCloseDebugPackage: vi.fn(),
		setSuppressWindowsWarning: vi.fn(),
		enableBetaUpdates: false,
		setEnableBetaUpdates: vi.fn(),
		autoRunStats: {
			cumulativeTimeMs: 0,
			longestRunMs: 0,
			longestRunTimestamp: 0,
			totalRuns: 0,
			currentBadgeLevel: 0,
			lastBadgeUnlockLevel: 0,
			lastAcknowledgedBadgeLevel: 0,
			badgeHistory: [],
		},
		onStandingOvationClose: vi.fn(),
		onOpenLeaderboardRegistration: vi.fn(),
		isLeaderboardRegistered: false,
		onFirstRunCelebrationClose: vi.fn(),
		onKeyboardMasteryCelebrationClose: vi.fn(),
		onMarketplaceImportComplete: vi.fn().mockResolvedValue(undefined),
		setActiveSessionId: vi.fn(),
		onStartContribution: vi.fn().mockResolvedValue(undefined),
		encoreFeatures: resolveEncoreFeatures({}),
		onDirectorNotesResumeSession: vi.fn(),
		onFileClick: vi.fn(),
		shortcuts: {},
		gistPublishModalOpen: false,
		setGistPublishModalOpen: vi.fn(),
		activeFileTab: null,
		saveFileGistUrl: vi.fn(),
		fileGistUrls: {},
		onOpenFileTab: vi.fn(),
		mainPanelRef: { current: null },
		documentGraphShowExternalLinks: false,
		documentGraphConfirmClose: false,
		onExternalLinksChange: vi.fn(),
		documentGraphMaxNodes: 50,
		documentGraphPreviewCharLimit: 200,
		onPreviewCharLimitChange: vi.fn(),
		documentGraphLayoutType: 'mindmap',
		onLayoutTypeChange: vi.fn(),
		onPerformDeleteSession: vi.fn(),
		onCloseDeleteAgentModal: vi.fn(),
		onCloseSettings: vi.fn(),
		hasNoAgents: false,
		setFlashNotification: vi.fn(),
		wizardIsOpen: false,
		onWizardLaunchSession: vi.fn().mockResolvedValue(undefined),
		recordWizardStart: vi.fn(),
		recordWizardResume: vi.fn(),
		recordWizardAbandon: vi.fn(),
		recordWizardComplete: vi.fn(),
		onWizardResume: vi.fn(),
		onWizardStartFresh: vi.fn(),
		onWizardResumeClose: vi.fn(),
		setTourCompleted: vi.fn(),
		tabShortcuts: {},
		recordTourStart: vi.fn(),
		recordTourComplete: vi.fn(),
		recordTourSkip: vi.fn(),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	resetAllStores();
	exchange.exchangeProps = null;
	exchange.hostProps = null;
	useSessionStore.setState({
		sessions: [WITH_FOLDER, WITHOUT_FOLDER],
		activeSessionId: 'with-folder',
	});
});

describe('AppStandaloneModals: the Playbook Launch dialog', () => {
	it('draws no dialog until the Exchange opens one, then gives the host the theme', async () => {
		render(<AppStandaloneModals {...makeProps()} />);
		expect(screen.queryByTestId('launch-host-stub')).toBeNull();

		act(() => getModalActions().openPlaybookLaunch(playbook));

		expect(await screen.findByTestId('launch-host-stub')).toBeInTheDocument();
		expect(exchange.hostProps).toEqual({ theme: mockTheme });
	});

	it('does not draw the dialog when only the Exchange is open', async () => {
		render(<AppStandaloneModals {...makeProps()} />);

		act(() => getModalActions().setMarketplaceModalOpen(true));

		expect(await screen.findByTestId('exchange-stub')).toBeInTheDocument();
		expect(screen.queryByTestId('launch-host-stub')).toBeNull();
	});

	it('draws the dialog for an agent with no Auto Run folder, where the Exchange cannot be drawn', async () => {
		useSessionStore.setState({ activeSessionId: 'without-folder' });
		render(<AppStandaloneModals {...makeProps()} />);

		act(() => {
			getModalActions().setMarketplaceModalOpen(true);
			getModalActions().openPlaybookLaunch(playbook);
		});

		expect(await screen.findByTestId('launch-host-stub')).toBeInTheDocument();
		expect(screen.queryByTestId('exchange-stub')).toBeNull();
	});

	it('layers the dialog on the Exchange, and closing it leaves the Exchange up', async () => {
		render(<AppStandaloneModals {...makeProps()} />);

		act(() => {
			getModalActions().setMarketplaceModalOpen(true);
			getModalActions().openPlaybookLaunch(playbook);
		});

		expect(await screen.findByTestId('exchange-stub')).toBeInTheDocument();
		expect(await screen.findByTestId('launch-host-stub')).toBeInTheDocument();

		act(() => getModalActions().closePlaybookLaunch());

		expect(screen.queryByTestId('launch-host-stub')).toBeNull();
		expect(screen.getByTestId('exchange-stub')).toBeInTheDocument();
	});
});
