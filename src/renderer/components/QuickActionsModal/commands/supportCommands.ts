import { buildMaestroUrl } from '../../../utils/buildMaestroUrl';
import type { NotifyToastInput } from '../../../stores/notificationStore';
import { captureException } from '../../../utils/sentry';
import type { SettingsTab } from '../../../types';
import type { QuickAction } from '../types';

interface FeedbackDraftActions {
	isMinimized: boolean;
	setMinimized: (minimized: boolean) => void;
}

interface BuildSupportCommandsArgs {
	setQuickActionOpen: (open: boolean) => void;
	setSettingsModalOpen: (open: boolean) => void;
	setSettingsTab: (tab: SettingsTab) => void;
	setShortcutsHelpOpen: (open: boolean) => void;
	setAboutModalOpen: (open: boolean) => void;
	onOpenLeaderboardRegistration: () => void;
	isLeaderboardRegistered: boolean;
	setFeedbackModalOpen: (open: boolean) => void;
	setLogViewerOpen: (open: boolean) => void;
	setProcessMonitorOpen: (open: boolean) => void;
	setUpdateCheckModalOpen?: (open: boolean) => void;
	setDebugPackageModalOpen?: (open: boolean) => void;
	startTour?: () => void;
	getFeedbackDraft: () => FeedbackDraftActions;
	createDebugPackage: () => Promise<{ success?: boolean; path?: string; error?: string }>;
	notifyToast: (args: NotifyToastInput) => void;
	openUrl: (url: string) => void;
	toggleDevtools: () => void;
	shortcuts: {
		settings?: QuickAction['shortcut'];
		help?: QuickAction['shortcut'];
		systemLogs?: QuickAction['shortcut'];
		processMonitor?: QuickAction['shortcut'];
	};
}

export function buildSupportCommands({
	setQuickActionOpen,
	setSettingsModalOpen,
	setSettingsTab,
	setShortcutsHelpOpen,
	setAboutModalOpen,
	onOpenLeaderboardRegistration,
	isLeaderboardRegistered,
	setFeedbackModalOpen,
	setLogViewerOpen,
	setProcessMonitorOpen,
	setUpdateCheckModalOpen,
	setDebugPackageModalOpen,
	startTour,
	getFeedbackDraft,
	createDebugPackage,
	notifyToast,
	openUrl,
	toggleDevtools,
	shortcuts,
}: BuildSupportCommandsArgs): QuickAction[] {
	const commands: QuickAction[] = [
		{
			id: 'settings',
			label: 'Settings',
			shortcut: shortcuts.settings,
			action: () => {
				setSettingsModalOpen(true);
				setQuickActionOpen(false);
			},
		},
		{
			id: 'theme',
			label: 'Change Theme',
			action: () => {
				setSettingsModalOpen(true);
				setSettingsTab('theme');
				setQuickActionOpen(false);
			},
		},
		{
			id: 'configureEnvVars',
			label: 'Configure Global Environment Variables',
			action: () => {
				setSettingsModalOpen(true);
				setSettingsTab('general');
				setQuickActionOpen(false);
			},
		},
		{
			id: 'shortcuts',
			label: 'View Shortcuts',
			shortcut: shortcuts.help,
			action: () => {
				setShortcutsHelpOpen(true);
				setQuickActionOpen(false);
			},
		},
		{
			id: 'logs',
			label: 'View System Logs',
			shortcut: shortcuts.systemLogs,
			action: () => {
				setLogViewerOpen(true);
				setQuickActionOpen(false);
			},
		},
		{
			id: 'processes',
			label: 'View System Processes',
			shortcut: shortcuts.processMonitor,
			action: () => {
				setProcessMonitorOpen(true);
				setQuickActionOpen(false);
			},
		},
		{
			id: 'devtools',
			label: 'Toggle JavaScript Console',
			action: () => {
				toggleDevtools();
				setQuickActionOpen(false);
			},
		},
		{
			id: 'about',
			label: 'About Maestro',
			action: () => {
				setAboutModalOpen(true);
				setQuickActionOpen(false);
			},
		},
		{
			id: 'leaderboard',
			label: isLeaderboardRegistered ? 'Leaderboard Registration' : 'Join Leaderboard',
			subtext: isLeaderboardRegistered
				? 'Update your global runmaestro.ai leaderboard profile'
				: 'Register for the global runmaestro.ai leaderboard',
			action: () => {
				onOpenLeaderboardRegistration();
				setQuickActionOpen(false);
			},
		},
		{
			id: 'feedback',
			label: 'Send Feedback',
			subtext: 'Report a bug or suggest a feature via GitHub',
			action: () => {
				const draft = getFeedbackDraft();
				if (draft.isMinimized) {
					draft.setMinimized(false);
				} else {
					setFeedbackModalOpen(true);
				}
				setQuickActionOpen(false);
			},
		},
		{
			id: 'website',
			label: 'Maestro Website',
			subtext: 'Open the Maestro website',
			action: () => {
				openUrl(buildMaestroUrl('https://runmaestro.ai/'));
				setQuickActionOpen(false);
			},
		},
		{
			id: 'docs',
			label: 'Documentation and User Guide',
			subtext: 'Open the Maestro documentation',
			action: () => {
				openUrl(buildMaestroUrl('https://docs.runmaestro.ai/'));
				setQuickActionOpen(false);
			},
		},
		{
			id: 'discord',
			label: 'Join Discord',
			subtext: 'Join the Maestro community',
			action: () => {
				openUrl(buildMaestroUrl('https://runmaestro.ai/discord'));
				setQuickActionOpen(false);
			},
		},
		{
			id: 'createDebugPackage',
			label: 'Create Debug Package',
			subtext: 'Generate a support bundle for bug reporting',
			action: () => {
				setQuickActionOpen(false);
				if (setDebugPackageModalOpen) {
					setDebugPackageModalOpen(true);
					return;
				}
				notifyToast({
					type: 'info',
					title: 'Debug Package',
					message: 'Creating debug package...',
				});
				createDebugPackage()
					.then((result) => {
						if (result.success && result.path) {
							notifyToast({
								type: 'success',
								title: 'Debug Package Created',
								message: `Saved to ${result.path}`,
							});
						} else if (result.error !== 'Cancelled by user') {
							notifyToast({
								type: 'error',
								title: 'Debug Package Failed',
								message: result.error || 'Unknown error',
							});
						}
					})
					.catch((error) => {
						notifyToast({
							type: 'error',
							title: 'Debug Package Failed',
							message: error instanceof Error ? error.message : 'Unknown error',
						});
						captureException(error);
						throw error;
					});
			},
		},
	];

	if (startTour) {
		commands.push({
			id: 'tour',
			label: 'Start Introductory Tour',
			subtext: 'Take a guided tour of the interface',
			action: () => {
				startTour();
				setQuickActionOpen(false);
			},
		});
	}

	if (setUpdateCheckModalOpen) {
		commands.push({
			id: 'updateCheck',
			label: 'Check for Updates',
			action: () => {
				setUpdateCheckModalOpen(true);
				setQuickActionOpen(false);
			},
		});
	}

	return commands;
}
