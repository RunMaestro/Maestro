import { useState, useEffect, useLayoutEffect, useRef, useCallback, memo } from 'react';
import {
	X,
	Keyboard,
	Bell,
	Cpu,
	Settings,
	Palette,
	Puzzle,
	Server,
	Monitor,
	Globe,
	Wand2,
	Info,
} from 'lucide-react';
import { useSettings } from '../../hooks';
import type { Theme, SettingsTab } from '../../types';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { useResizableModal } from '../../hooks/ui/useResizableModal';
import { useViewportBreakpoint } from '../../hooks/ui/useViewportBreakpoint';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { ResizeHandles } from '../ui/ResizeHandles';
import { jumpToElement } from '../../utils/jumpHighlight';
import { AICommandsPanel } from '../AICommandsPanel';
import { MaestroPromptsTab } from './tabs/MaestroPromptsTab';
import { SpecKitCommandsPanel } from '../SpecKitCommandsPanel';
import { OpenSpecCommandsPanel } from '../OpenSpecCommandsPanel';
import { BmadCommandsPanel } from '../BmadCommandsPanel';
import { NotificationsPanel } from '../NotificationsPanel';
import { SshRemotesSection } from './SshRemotesSection';
import { SshRemoteIgnoreSection } from './SshRemoteIgnoreSection';
import { GeneralTab } from './tabs/GeneralTab';
import { DisplayTab } from './tabs/DisplayTab';
import { EncoreTab } from './tabs/EncoreTab';
import { ShortcutsTab } from './tabs/ShortcutsTab';
import { ThemeTab } from './tabs/ThemeTab';
import { EnvironmentTab } from './tabs/EnvironmentTab';
import { AboutTab } from './tabs/AboutTab';
import { useSettingsSearch, SettingsSearchInput, SettingsSearchResults } from './SettingsSearch';
import type { SearchableSetting } from './searchableSettings';

/**
 * The tabs this modal renders. Identical to the shared {@link SettingsTab} - an
 * alias rather than a copy, so a tab added in one place cannot go missing here.
 */
type SettingsTabId = SettingsTab;

// Alphabetized by label (case-insensitive) so the sidebar reads predictably
// regardless of which tabs ship. Mount-time default is still 'general' -
// that's enforced by the useState init below, not by list position.
const TAB_ITEMS: Array<{
	id: SettingsTabId;
	label: string;
	icon: typeof Settings;
}> = [
	{ id: 'about', label: 'About', icon: Info },
	{ id: 'aicommands', label: 'AI Commands', icon: Cpu },
	{ id: 'display', label: 'Display', icon: Monitor },
	{ id: 'environment', label: 'Environment', icon: Globe },
	{ id: 'general', label: 'General', icon: Settings },
	{ id: 'prompts', label: 'Maestro Prompts', icon: Wand2 },
	{ id: 'notifications', label: 'Notifications', icon: Bell },
	// Internal id stays 'encore' (deep links, persisted last-tab, searchable
	// settings all key on it); the user-facing surface is the Plugins tab.
	{ id: 'encore', label: 'Plugins', icon: Puzzle },
	{ id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
	{ id: 'ssh', label: 'SSH Hosts', icon: Server },
	{ id: 'theme', label: 'Themes', icon: Palette },
];

// Single source of truth for a settings-tab button so the vertical sidebar
// (md and up) and the horizontal tab strip (xs phones) render identical
// markup. `orientation` only swaps the active-edge indicator (right border in
// the sidebar, bottom border in the strip) and the flex sizing.
function SettingsTabButton({
	tab,
	isActive,
	orientation,
	theme,
	onClick,
}: {
	tab: (typeof TAB_ITEMS)[number];
	isActive: boolean;
	orientation: 'vertical' | 'horizontal';
	theme: Theme;
	onClick: () => void;
}) {
	const Icon = tab.icon;
	const activeEdge = `2px solid ${theme.colors.accent}`;
	const inactiveEdge = '2px solid transparent';
	return (
		<button
			onClick={onClick}
			className={`flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors cursor-pointer ${orientation === 'vertical' ? 'w-full' : 'flex-shrink-0'} ${isActive ? 'font-bold' : 'opacity-70 hover:opacity-100'}`}
			style={{
				backgroundColor: isActive ? theme.colors.bgActivity : 'transparent',
				color: isActive ? theme.colors.accent : theme.colors.textMain,
				...(orientation === 'vertical'
					? { borderRight: isActive ? activeEdge : inactiveEdge }
					: { borderBottom: isActive ? activeEdge : inactiveEdge }),
			}}
			title={tab.label}
		>
			<Icon className="w-4 h-4 flex-shrink-0" />
			<span className="whitespace-nowrap">{tab.label}</span>
		</button>
	);
}

// In-memory only - last tab the user was on. Resets on app restart, so the
// modal still defaults to General on a fresh launch. Honors any explicit
// `initialTab` prop (e.g. when a caller deep-links into a specific tab).
let lastOpenSettingsTab: SettingsTabId | null = null;

// In-memory only - last vertical scroll position per tab. Pairs with
// lastOpenSettingsTab so the user can reopen Settings (or flip between tabs)
// and land exactly where they were, instead of having to re-find the control
// they were tweaking. Resets on app restart.
const lastTabScrollPositions = new Map<SettingsTabId, number>();

// Test-only: reset the remembered tab so suites that assume a fresh open
// (e.g. "modal opens to General") aren't polluted by prior tests in the file.
export function __resetLastOpenSettingsTabForTests(): void {
	lastOpenSettingsTab = null;
	lastTabScrollPositions.clear();
}

interface SettingsModalProps {
	isOpen: boolean;
	onClose: () => void;
	theme: Theme;
	themes: Record<string, Theme>;
	/**
	 * Tab to deep-link into. `SettingsTab` rather than a hand-copied union: this
	 * prop, `SettingsTabId` below, and `SettingsTab` in `renderer/types` were three
	 * spellings of one list, and they had already drifted - the shared one could
	 * not name Plugins, so no caller could deep-link there.
	 */
	initialTab?: SettingsTab;
	initialSelectedPromptId?: string;
	hasNoAgents?: boolean;
	onThemeImportError?: (message: string) => void;
	onThemeImportSuccess?: (message: string) => void;
}

export const SettingsModal = memo(function SettingsModal(props: SettingsModalProps) {
	const {
		isOpen,
		onClose,
		theme,
		themes,
		initialTab,
		initialSelectedPromptId,
		hasNoAgents,
		onThemeImportError,
		onThemeImportSuccess,
	} = props;

	// All settings from useSettings hook (self-sourced, Tier 1B)
	// General tab settings are now self-sourced by GeneralTab
	// Display tab settings are now self-sourced by DisplayTab
	const {
		// Notification settings
		osNotificationsEnabled,
		setOsNotificationsEnabled,
		audioFeedbackEnabled,
		setAudioFeedbackEnabled,
		audioFeedbackCommand,
		setAudioFeedbackCommand,
		toastDuration,
		setToastDuration,
		toastWidth,
		setToastWidth,
		idleNotificationEnabled,
		setIdleNotificationEnabled,
		idleNotificationCommand,
		setIdleNotificationCommand,
		// AI Commands
		customAICommands,
		setCustomAICommands,
		speckitEnabled,
		setSpeckitEnabled,
		openspecEnabled,
		setOpenspecEnabled,
		bmadEnabled,
		setBmadEnabled,
		// SSH Remote file indexing settings
		sshRemoteIgnorePatterns,
		setSshRemoteIgnorePatterns,
		sshRemoteHonorGitignore,
		setSshRemoteHonorGitignore,
	} = useSettings();

	// Lazy init reads the remembered tab on mount. Doing this in useState (rather
	// than a restore effect) avoids racing with the persist effect below - under
	// React StrictMode a restore-via-effect double-fires and clobbers the saved
	// value with the initial 'general' before the restored value lands.
	const [activeTab, setActiveTab] = useState<SettingsTabId>(
		() => initialTab || lastOpenSettingsTab || 'general'
	);
	const resizableModal = useResizableModal({
		resizeKey: 'settings',
		defaultSize: { width: 980, height: 900 },
		minSize: { width: 720, height: 480 },
		enabled: isOpen,
	});
	// Search state
	const [searchActive, setSearchActive] = useState(false);
	const contentRef = useRef<HTMLDivElement>(null);

	// On xs phones the fixed 248px sidebar leaves too little room for content,
	// so collapse the two-column layout into a horizontal tab strip above the
	// content. sm and up keep the pixel-identical sidebar layout.
	const { isXs } = useViewportBreakpoint();

	const handleSearchActiveChange = useCallback((active: boolean) => {
		setSearchActive(active);
	}, []);

	// Hold setQuery in a ref so handleSearchNavigate doesn't depend on `search`
	// (which is created below and itself takes onNavigate as input).
	const setQueryRef = useRef<(q: string) => void>(() => {});

	// Stash theme accent in a ref so handleSearchNavigate stays stable across renders
	const jumpAccentRef = useRef(theme.colors.accent);
	jumpAccentRef.current = theme.colors.accent;

	// Pending scroll target - set when the user picks a search result, consumed
	// by the effect below once the content panel is actually visible and the
	// target tab has rendered. Doing this via state-driven effect (not RAF
	// chains) avoids a race where scrollIntoView fires while the content div
	// still has `hidden` / display:none from search mode, silently no-opping.
	const pendingScrollIdRef = useRef<string | null>(null);

	const handleSearchNavigate = useCallback((tab: SearchableSetting['tab'], settingId: string) => {
		pendingScrollIdRef.current = settingId;
		setQueryRef.current('');
		setActiveTab(tab);
	}, []);

	useEffect(() => {
		const targetId = pendingScrollIdRef.current;
		if (!targetId || searchActive) return;

		// Scroll + themed arrow/outline flash. The retry loop inside jumpToElement
		// covers the race where the target tab's content is still display:none from
		// search mode, which would otherwise make scrollIntoView silently no-op.
		const clearPending = () => {
			pendingScrollIdRef.current = null;
		};
		return jumpToElement(
			() => contentRef.current?.querySelector<HTMLElement>(`[data-setting-id="${targetId}"]`),
			{
				color: jumpAccentRef.current,
				arrow: true,
				onFound: clearPending,
				onTimeout: clearPending,
			}
		);
	}, [searchActive, activeTab]);

	const search = useSettingsSearch({
		isOpen,
		onSearchActiveChange: handleSearchActiveChange,
		onNavigate: handleSearchNavigate,
	});
	setQueryRef.current = search.setQuery;

	// Layer stack integration
	const isRecordingShortcutRef = useRef(false);
	const promptsEscapeHandlerRef = useRef<(() => boolean) | null>(null);

	// Honor a deep-link initialTab change while the modal is already mounted
	// (e.g. caller switches tab without closing). Mount-time restoration is
	// handled by the lazy useState init above, not here.
	useEffect(() => {
		if (isOpen && initialTab) {
			setActiveTab(initialTab);
		}
	}, [isOpen, initialTab]);

	// Persist the current tab in module memory so the next open lands here.
	// In-memory only - resets on app restart by design.
	useEffect(() => {
		lastOpenSettingsTab = activeTab;
	}, [activeTab]);

	// Restore the per-tab scroll position whenever the active tab changes (or
	// the modal reopens on a remembered tab). useLayoutEffect runs after the
	// new tab's content has committed to the DOM but before paint, so the
	// scroll lands without a visible flash at the top. `behavior: 'auto'` is
	// intentional - smooth-scrolling on tab switch reads as sluggish.
	useLayoutEffect(() => {
		if (!isOpen) return;
		const el = contentRef.current;
		if (!el) return;
		const saved = lastTabScrollPositions.get(activeTab) ?? 0;
		el.scrollTop = saved;
	}, [activeTab, isOpen]);

	// Save scroll position for the currently active tab on every scroll event.
	// Direct map write is cheap; no throttling needed. Pairs with the restore
	// effect above so the user can tweak a setting low in a long panel, flip
	// to another tab to verify the effect, and come back to exactly the same
	// position.
	const handleContentScroll = useCallback(
		(e: React.UIEvent<HTMLDivElement>) => {
			lastTabScrollPositions.set(activeTab, e.currentTarget.scrollTop);
		},
		[activeTab]
	);

	// Store onClose in a ref to avoid re-registering layer when onClose changes
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Register layer when modal opens
	useModalLayer(
		MODAL_PRIORITIES.SETTINGS,
		'Settings',
		() => {
			// If recording a shortcut, ShortcutsTab handles its own escape via onKeyDownCapture
			if (isRecordingShortcutRef.current) return;
			// Let prompts tab handle layered escape (help -> expanded -> list -> close)
			if (promptsEscapeHandlerRef.current?.()) return;
			onCloseRef.current();
		},
		{ enabled: isOpen }
	);

	// Tab navigation with Cmd+Shift+[ and ]
	useEffect(() => {
		if (!isOpen) return;

		const handleTabNavigation = (e: KeyboardEvent) => {
			const tabs = TAB_ITEMS.map((t) => t.id);
			const currentIndex = tabs.indexOf(activeTab);

			if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === '[') {
				e.preventDefault();
				const prevIndex = currentIndex === 0 ? tabs.length - 1 : currentIndex - 1;
				setActiveTab(tabs[prevIndex]);
			} else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === ']') {
				e.preventDefault();
				const nextIndex = (currentIndex + 1) % tabs.length;
				setActiveTab(tabs[nextIndex]);
			}
		};

		window.addEventListener('keydown', handleTabNavigation);
		return () => window.removeEventListener('keydown', handleTabNavigation);
	}, [isOpen, activeTab]);

	if (!isOpen) return null;

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999] p-4"
			role="dialog"
			aria-modal="true"
			aria-label="Settings"
		>
			<div
				ref={resizableModal.modalRef}
				className="relative rounded-xl border shadow-2xl overflow-hidden flex flex-col select-none"
				style={{
					...resizableModal.style,
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
				data-modal-resize-key="settings"
			>
				<ResizeHandles
					onResizeStart={resizableModal.onResizeStart}
					accentColor={theme.colors.accent}
					onResetSize={resizableModal.onResetSize}
					canReset={resizableModal.canReset}
				/>

				{/* Search Bar + Close Button */}
				<div className="flex items-center border-b" style={{ borderColor: theme.colors.border }}>
					<div className="flex-1">
						<SettingsSearchInput
							theme={theme}
							query={search.query}
							setQuery={search.setQuery}
							inputRef={search.inputRef}
							isActive={search.isActive}
							results={search.results}
							onClear={search.clear}
						/>
					</div>
					<button onClick={onClose} className="cursor-pointer pl-4 pr-6">
						<X className="w-5 h-5 opacity-50 hover:opacity-100" />
					</button>
				</div>

				{/* Search Results (replaces sidebar+content when active) */}
				{searchActive && (
					<SettingsSearchResults
						theme={theme}
						query={search.query}
						results={search.results}
						onNavigate={handleSearchNavigate}
						selectedIndex={search.selectedIndex}
						setSelectedIndex={search.setSelectedIndex}
					/>
				)}

				{/* Body: Sidebar + Content (two-column on sm+, stacked on xs) */}
				<div
					className={`flex ${isXs ? 'flex-col' : ''} flex-1 overflow-hidden ${searchActive ? 'hidden' : ''}`}
				>
					{isXs ? (
						/* Horizontal tab strip above content (xs phones) */
						<nav
							className="flex-shrink-0 flex border-b overflow-x-auto scrollbar-thin"
							style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
							aria-label="Settings tabs"
						>
							{TAB_ITEMS.map((tab) => (
								<SettingsTabButton
									key={tab.id}
									tab={tab}
									isActive={activeTab === tab.id}
									orientation="horizontal"
									theme={theme}
									onClick={() => setActiveTab(tab.id)}
								/>
							))}
						</nav>
					) : (
						/* Left Sidebar Tabs (sm and up) */
						<nav
							className="w-[248px] flex-shrink-0 border-r py-2 overflow-y-auto scrollbar-thin"
							style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
							aria-label="Settings tabs"
						>
							{TAB_ITEMS.map((tab) => (
								<SettingsTabButton
									key={tab.id}
									tab={tab}
									isActive={activeTab === tab.id}
									orientation="vertical"
									theme={theme}
									onClick={() => setActiveTab(tab.id)}
								/>
							))}
						</nav>
					)}

					{/* Content Area */}
					<div
						ref={contentRef}
						onScroll={handleContentScroll}
						className="flex-1 p-6 overflow-y-auto scrollbar-thin"
					>
						{activeTab === 'general' && <GeneralTab theme={theme} isOpen={isOpen} />}

						{activeTab === 'display' && <DisplayTab theme={theme} />}

						{activeTab === 'shortcuts' && (
							<ShortcutsTab
								theme={theme}
								hasNoAgents={hasNoAgents}
								onRecordingChange={(isRecording) => {
									isRecordingShortcutRef.current = isRecording;
								}}
							/>
						)}

						{activeTab === 'theme' && (
							<ThemeTab
								theme={theme}
								themes={themes}
								onThemeImportError={onThemeImportError}
								onThemeImportSuccess={onThemeImportSuccess}
							/>
						)}

						{activeTab === 'notifications' && (
							<NotificationsPanel
								osNotificationsEnabled={osNotificationsEnabled}
								setOsNotificationsEnabled={setOsNotificationsEnabled}
								audioFeedbackEnabled={audioFeedbackEnabled}
								setAudioFeedbackEnabled={setAudioFeedbackEnabled}
								audioFeedbackCommand={audioFeedbackCommand}
								setAudioFeedbackCommand={setAudioFeedbackCommand}
								toastDuration={toastDuration}
								setToastDuration={setToastDuration}
								toastWidth={toastWidth}
								setToastWidth={setToastWidth}
								idleNotificationEnabled={idleNotificationEnabled}
								setIdleNotificationEnabled={setIdleNotificationEnabled}
								idleNotificationCommand={idleNotificationCommand}
								setIdleNotificationCommand={setIdleNotificationCommand}
								theme={theme}
							/>
						)}

						{activeTab === 'aicommands' && (
							<div className="space-y-8">
								<div data-setting-id="aicommands-custom">
									<AICommandsPanel
										theme={theme}
										customAICommands={customAICommands}
										setCustomAICommands={setCustomAICommands}
									/>
								</div>

								{/* Divider */}
								<div className="border-t" style={{ borderColor: theme.colors.border }} />

								{/* Spec Kit Commands Section */}
								<div data-setting-id="aicommands-speckit">
									<SpecKitCommandsPanel
										theme={theme}
										enabled={speckitEnabled}
										onEnabledChange={setSpeckitEnabled}
									/>
								</div>

								{/* Divider */}
								<div className="border-t" style={{ borderColor: theme.colors.border }} />

								{/* OpenSpec Commands Section */}
								<div data-setting-id="aicommands-openspec">
									<OpenSpecCommandsPanel
										theme={theme}
										enabled={openspecEnabled}
										onEnabledChange={setOpenspecEnabled}
									/>
								</div>

								{/* Divider */}
								<div className="border-t" style={{ borderColor: theme.colors.border }} />

								{/* BMAD Commands Section */}
								<div data-setting-id="aicommands-bmad">
									<BmadCommandsPanel
										theme={theme}
										enabled={bmadEnabled}
										onEnabledChange={setBmadEnabled}
									/>
								</div>
							</div>
						)}

						{activeTab === 'prompts' && (
							<div data-setting-id="prompts-editor" className="prompts-editor-wrapper">
								<MaestroPromptsTab
									theme={theme}
									initialSelectedPromptId={initialSelectedPromptId}
									onEscapeHandled={(handler) => {
										promptsEscapeHandlerRef.current = handler;
									}}
								/>
							</div>
						)}

						{activeTab === 'ssh' && (
							<div className="space-y-5">
								<div data-setting-id="ssh-remotes">
									<SshRemotesSection theme={theme} />
								</div>
								<div data-setting-id="ssh-ignore-patterns">
									<SshRemoteIgnoreSection
										theme={theme}
										ignorePatterns={sshRemoteIgnorePatterns}
										onIgnorePatternsChange={setSshRemoteIgnorePatterns}
										honorGitignore={sshRemoteHonorGitignore}
										onHonorGitignoreChange={setSshRemoteHonorGitignore}
									/>
								</div>
							</div>
						)}

						{activeTab === 'environment' && <EnvironmentTab theme={theme} />}

						{activeTab === 'encore' && <EncoreTab theme={theme} isOpen={isOpen} />}

						{activeTab === 'about' && <AboutTab theme={theme} />}
					</div>
				</div>
			</div>
		</div>
	);
});
