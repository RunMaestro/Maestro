import {
	Bell,
	Wand2,
	Plus,
	Settings,
	Keyboard,
	ScanEye,
	ScrollText,
	Cpu,
	ExternalLink,
	Info,
	Download,
	Compass,
	Globe,
	BookOpen,
	BarChart3,
	Music,
	Command,
	Zap,
	Music2,
	LogOut,
	MessageCircle,
	Gauge,
	ToggleLeft,
	ToggleRight,
} from 'lucide-react';
import type { Theme } from '../../types';
import { ShortcutHint } from '../ui/ShortcutHint';
import { useSettingsStore } from '../../stores/settingsStore';
import { getModalActions } from '../../stores/modalStore';
import { useThroughputGaugeStore } from '../../stores/throughputGaugeStore';
import { buildMaestroUrl } from '../../utils/buildMaestroUrl';
import { openUiSurface } from '../../utils/openUiSurface';
import { openUrl } from '../../utils/openUrl';
import { isWebDesktop } from '../../utils/runtimeContext';
import { canOpenComputerHistory } from '../../utils/computerHistoryAvailability';
import { currentWebLoginUser, signOutWebLogin } from '../../services/webLoginSession';
import { usePhoneLayout } from '../../hooks/ui/useViewportBreakpoint';
import {
	KEYBOARD_MODE_TOGGLE_KEYS,
	keyboardModeToggleShadow,
	nextKeyboardMode,
	switchKeyboardMode,
} from '../../services/keyboardMode';
import { KEYBOARD_MODE_LABELS } from '../../../shared/shortcut-types';

/** Stable fallback so the selector never hands React a fresh array. */
const NO_QUICK_CHAT_HOTKEY: string[] = [];

interface HamburgerMenuContentProps {
	theme: Theme;
	onNewAgentSession?: () => void;
	openWizard?: () => void;
	startTour?: () => void;
	setMenuOpen: (open: boolean) => void;
}

export function HamburgerMenuContent({
	theme,
	onNewAgentSession,
	openWizard,
	startTour,
	setMenuOpen,
}: HamburgerMenuContentProps) {
	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const encoreFeatures = useSettingsStore((s) => s.encoreFeatures);
	const notificationCenterEnabled = useSettingsStore((s) => s.notificationCenterEnabled);
	const keyboardMode = useSettingsStore((s) => s.keyboardMode);
	const quickChatHotkey =
		useSettingsStore((s) => s.quickChatSettings?.hotkey) ?? NO_QUICK_CHAT_HOTKEY;
	// A phone has no keyboard and no room for a guided tour's anchored
	// callouts, so the two entries that exist only for those are not offered.
	// (The chord badges beside every other row are hidden by CSS via
	// data-shortcut-hint.)
	const phone = usePhoneLayout();
	// Only a browser that actually signed in has somewhere to sign out to. On
	// the desktop there is no session and no login page, so the row is absent
	// rather than disabled. The cookie outlives the feature, so the row also
	// needs the Encore flag: with Web Login off there is no session to end.
	const webLoginEnabled = useSettingsStore((s) => s.encoreFeatures.webLogin === true);
	const webLoginUser = isWebDesktop() && webLoginEnabled ? currentWebLoginUser() : null;
	const {
		setShortcutsHelpOpen,
		setSettingsModalOpen,
		setLogViewerOpen,
		setProcessMonitorOpen,
		setUsageDashboardOpen,
		setSymphonyModalOpen,
		setDirectorNotesOpen,
		setCueModalOpen,
		setPianolaModalOpen,
		setComputerHistoryOpen,
		setConcertoStageOpen,
		setUpdateCheckModalOpen,
		setAboutModalOpen,
		setQuickActionOpen,
	} = getModalActions();

	return (
		<div className="p-1">
			{onNewAgentSession && (
				<button
					onClick={() => {
						onNewAgentSession();
						setMenuOpen(false);
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					<Plus className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							New Agent
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Create a new agent session
						</div>
					</div>
					<ShortcutHint theme={theme} keys={shortcuts.newInstance?.keys ?? []} />
				</button>
			)}
			{openWizard && (
				<button
					onClick={() => {
						openWizard();
						setMenuOpen(false);
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					<Wand2 className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							New Agent Wizard
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Get started with AI
						</div>
					</div>
					<ShortcutHint theme={theme} keys={shortcuts.openWizard?.keys ?? []} />
				</button>
			)}
			<button
				onClick={() => {
					setQuickActionOpen(true);
					setMenuOpen(false);
				}}
				className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
			>
				<Command className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<div className="flex-1">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Command Palette
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Quick actions and navigation
					</div>
				</div>
				<ShortcutHint theme={theme} keys={shortcuts.quickAction?.keys ?? []} />
			</button>
			{notificationCenterEnabled && (
				<button
					onClick={() => {
						openUiSurface('notification-center');
						setMenuOpen(false);
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					<Bell className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Notification Center
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Unread notifications and history
						</div>
					</div>
					<ShortcutHint keys={shortcuts.openNotificationCenter?.keys ?? []} theme={theme} />
				</button>
			)}
			{startTour && !phone && (
				<button
					onClick={() => {
						startTour();
						setMenuOpen(false);
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					<Compass className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Introductory Tour
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Learn how to use Maestro
						</div>
					</div>
				</button>
			)}
			<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
			{!phone && (
				<button
					onClick={() => {
						setShortcutsHelpOpen(true);
						setMenuOpen(false);
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					<Keyboard className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Keyboard Shortcuts
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							View all available shortcuts
						</div>
					</div>
					<ShortcutHint theme={theme} keys={shortcuts.help?.keys ?? []} />
				</button>
			)}
			{/* The mode every chord in the app belongs to, switchable without
			    opening Settings. Row absent on a phone for the same reason the
			    shortcut list above it is: there is no keyboard to put in a mode.
			    The chord badge is dropped when another action's binding has taken
			    Opt+Cmd+V, since the toggle handler stands down in that case. */}
			{!phone && (
				<button
					onClick={() => {
						switchKeyboardMode();
						setMenuOpen(false);
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					{keyboardMode === 'default' ? (
						<ToggleLeft className="w-5 h-5" style={{ color: theme.colors.accent }} />
					) : (
						<ToggleRight className="w-5 h-5" style={{ color: theme.colors.accent }} />
					)}
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Keyboard Mode: {KEYBOARD_MODE_LABELS[keyboardMode]}
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Switch to {KEYBOARD_MODE_LABELS[nextKeyboardMode(keyboardMode)]} mode
						</div>
					</div>
					<ShortcutHint
						theme={theme}
						keys={keyboardModeToggleShadow() ? [] : KEYBOARD_MODE_TOGGLE_KEYS}
					/>
				</button>
			)}
			<button
				onClick={() => {
					setSettingsModalOpen(true);
					setMenuOpen(false);
				}}
				className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
			>
				<Settings className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<div className="flex-1">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Settings
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Configure preferences
					</div>
				</div>
				<ShortcutHint theme={theme} keys={shortcuts.settings?.keys ?? []} />
			</button>
			<button
				onClick={() => {
					setLogViewerOpen(true);
					setMenuOpen(false);
				}}
				className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
			>
				<ScrollText className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<div className="flex-1">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						System Logs
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						View application logs
					</div>
				</div>
				<ShortcutHint theme={theme} keys={shortcuts.systemLogs?.keys ?? []} />
			</button>
			<button
				onClick={() => {
					setProcessMonitorOpen(true);
					setMenuOpen(false);
				}}
				className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
			>
				<Cpu className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<div className="flex-1">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Process Monitor
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						View running processes
					</div>
				</div>
				<ShortcutHint theme={theme} keys={shortcuts.processMonitor?.keys ?? []} />
			</button>
			{encoreFeatures.usageStats && (
				<button
					onClick={() => {
						setUsageDashboardOpen(true);
						setMenuOpen(false);
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					<BarChart3 className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Usage Dashboard
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							View usage analytics
						</div>
					</div>
					<ShortcutHint theme={theme} keys={shortcuts.usageDashboard?.keys ?? []} />
				</button>
			)}
			{encoreFeatures.directorNotes && (
				<button
					onClick={() => {
						setDirectorNotesOpen(true);
						setMenuOpen(false);
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					<ScrollText className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Director's Notes
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Unified history & AI synopsis
						</div>
					</div>
					{shortcuts.directorNotes && (
						<ShortcutHint theme={theme} keys={shortcuts.directorNotes?.keys ?? []} />
					)}
				</button>
			)}
			{canOpenComputerHistory(encoreFeatures) && (
				<button
					onClick={() => {
						setComputerHistoryOpen(true);
						setMenuOpen(false);
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					<ScanEye className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Computer History
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							What you saw and typed across apps
						</div>
					</div>
					{shortcuts.computerHistory && (
						<ShortcutHint theme={theme} keys={shortcuts.computerHistory?.keys ?? []} />
					)}
				</button>
			)}
			{encoreFeatures.symphony && (
				<button
					onClick={() => {
						setSymphonyModalOpen(true);
						setMenuOpen(false);
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					<Music className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Maestro Symphony
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Contribute to open source
						</div>
					</div>
					<ShortcutHint theme={theme} keys={shortcuts.openSymphony?.keys ?? []} />
				</button>
			)}
			{encoreFeatures.maestroCue && (
				<button
					onClick={() => {
						setCueModalOpen(true);
						setMenuOpen(false);
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					<Zap className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Maestro Cue
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Event-driven automation
						</div>
					</div>
					{shortcuts.openCue && <ShortcutHint theme={theme} keys={shortcuts.openCue?.keys ?? []} />}
				</button>
			)}
			{encoreFeatures.concerto && (
				<button
					onClick={() => {
						setConcertoStageOpen(true);
						setMenuOpen(false);
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					<Music2 className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Concerto
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Agent-composed interactive views
						</div>
					</div>
					{shortcuts.toggleConcerto && (
						<ShortcutHint theme={theme} keys={shortcuts.toggleConcerto?.keys ?? []} />
					)}
				</button>
			)}
			{encoreFeatures.throughputGauge && (
				<button
					onClick={() => {
						useThroughputGaugeStore.getState().toggle();
						setMenuOpen(false);
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					<Gauge className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Throughput Gauge
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Live tokens per second
						</div>
					</div>
					{shortcuts.toggleThroughputGauge && (
						<ShortcutHint theme={theme} keys={shortcuts.toggleThroughputGauge?.keys ?? []} />
					)}
				</button>
			)}
			{/* Quick Chat is its own window, which only the Electron app has. */}
			{encoreFeatures.quickChat !== false && !isWebDesktop() && (
				<button
					onClick={() => {
						void window.maestro.quickChat.window('show');
						setMenuOpen(false);
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					<MessageCircle className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Quick Chat
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Floating chat with one agent
						</div>
					</div>
					{quickChatHotkey.length > 0 && <ShortcutHint theme={theme} keys={quickChatHotkey} />}
				</button>
			)}
			{encoreFeatures.pianola && (
				<button
					onClick={() => {
						setPianolaModalOpen(true);
						setMenuOpen(false);
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					<Music className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Pianola
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Autonomous manager
						</div>
					</div>
				</button>
			)}
			<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
			<button
				onClick={() => {
					openUrl(buildMaestroUrl('https://runmaestro.ai'));
					setMenuOpen(false);
				}}
				className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
			>
				<Globe className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<div className="flex-1">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Maestro Website
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Visit runmaestro.ai
					</div>
				</div>
				<ExternalLink className="w-4 h-4" style={{ color: theme.colors.textDim }} />
			</button>
			<button
				onClick={() => {
					openUrl(buildMaestroUrl('https://docs.runmaestro.ai'));
					setMenuOpen(false);
				}}
				className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
			>
				<BookOpen className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<div className="flex-1">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Documentation
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						See usage docs on docs.runmaestro.ai
					</div>
				</div>
				<ExternalLink className="w-4 h-4" style={{ color: theme.colors.textDim }} />
			</button>
			{/* Check for Updates assumes the user is running the Electron binary
			    directly - it would dump a misleading dialog when the renderer is
			    served through the web-desktop bridge. Hide it in that context. */}
			{!isWebDesktop() && (
				<button
					onClick={() => {
						setUpdateCheckModalOpen(true);
						setMenuOpen(false);
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					<Download className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Check for Updates
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							Get the latest version
						</div>
					</div>
				</button>
			)}
			<button
				onClick={() => {
					setAboutModalOpen(true);
					setMenuOpen(false);
				}}
				className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
			>
				<Info className="w-5 h-5" style={{ color: theme.colors.accent }} />
				<div className="flex-1">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						About Maestro
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						Version, Credits, Stats
					</div>
				</div>
			</button>
			{webLoginUser && (
				<button
					data-testid="hamburger-sign-out"
					onClick={() => {
						setMenuOpen(false);
						void signOutWebLogin();
					}}
					className="w-full flex items-center gap-3 px-3 py-2.5 rounded-md hover:bg-white/10 transition-colors text-left"
				>
					<LogOut className="w-5 h-5" style={{ color: theme.colors.accent }} />
					<div className="flex-1">
						<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
							Sign out ({webLoginUser.displayName})
						</div>
						<div className="text-xs" style={{ color: theme.colors.textDim }}>
							End this browser&apos;s Web Login session
						</div>
					</div>
				</button>
			)}
		</div>
	);
}
