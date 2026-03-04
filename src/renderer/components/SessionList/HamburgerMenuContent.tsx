import {
	Wand2,
	Plus,
	Settings,
	Keyboard,
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
} from 'lucide-react';
import type { Theme } from '../../types';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { useSettingsStore } from '../../stores/settingsStore';
import { getModalActions } from '../../stores/modalStore';

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
	const {
		setShortcutsHelpOpen,
		setSettingsModalOpen,
		setSettingsTab,
		setLogViewerOpen,
		setProcessMonitorOpen,
		setUsageDashboardOpen,
		setSymphonyModalOpen,
		setDirectorNotesOpen,
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
					<span
						className="text-xs font-mono px-1.5 py-0.5 rounded"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
					>
						{shortcuts.newInstance ? formatShortcutKeys(shortcuts.newInstance.keys) : '⌘N'}
					</span>
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
					<span
						className="text-xs font-mono px-1.5 py-0.5 rounded"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
					>
						{shortcuts.openWizard ? formatShortcutKeys(shortcuts.openWizard.keys) : '⇧⌘N'}
					</span>
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
				<span
					className="text-xs font-mono px-1.5 py-0.5 rounded"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
				>
					{shortcuts.quickAction ? formatShortcutKeys(shortcuts.quickAction.keys) : '⌘K'}
				</span>
			</button>
			{startTour && (
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
				<span
					className="text-xs font-mono px-1.5 py-0.5 rounded"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
				>
					{formatShortcutKeys(shortcuts.help.keys)}
				</span>
			</button>
			<button
				onClick={() => {
					setSettingsModalOpen(true);
					setSettingsTab('general');
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
				<span
					className="text-xs font-mono px-1.5 py-0.5 rounded"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
				>
					{formatShortcutKeys(shortcuts.settings.keys)}
				</span>
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
				<span
					className="text-xs font-mono px-1.5 py-0.5 rounded"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
				>
					{formatShortcutKeys(shortcuts.systemLogs.keys)}
				</span>
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
				<span
					className="text-xs font-mono px-1.5 py-0.5 rounded"
					style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
				>
					{formatShortcutKeys(shortcuts.processMonitor.keys)}
				</span>
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
					<span
						className="text-xs font-mono px-1.5 py-0.5 rounded"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
					>
						{formatShortcutKeys(shortcuts.usageDashboard.keys)}
					</span>
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
					<span
						className="text-xs font-mono px-1.5 py-0.5 rounded"
						style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
					>
						{shortcuts.openSymphony ? formatShortcutKeys(shortcuts.openSymphony.keys) : '⇧⌘Y'}
					</span>
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
						<span
							className="text-xs font-mono px-1.5 py-0.5 rounded"
							style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
						>
							{formatShortcutKeys(shortcuts.directorNotes.keys)}
						</span>
					)}
				</button>
			)}
			<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
			<button
				onClick={() => {
					window.maestro.shell.openExternal('https://runmaestro.ai');
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
					window.maestro.shell.openExternal('https://docs.runmaestro.ai');
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
		</div>
	);
}
