import {
	Fragment,
	useState,
	useEffect,
	useLayoutEffect,
	useRef,
	useCallback,
	useMemo,
	memo,
	type ComponentType,
} from 'react';
import {
	X,
	ChevronDown,
	ChevronRight,
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
	HardDrive,
} from 'lucide-react';
import { useSettings } from '../../hooks';
import type { Theme, SettingsTab } from '../../types';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { useIsTopLayer } from '../../hooks/ui/useIsTopLayer';
import { useResizableModal } from '../../hooks/ui/useResizableModal';
import { useViewportBreakpoint } from '../../hooks/ui/useViewportBreakpoint';
import { useOptionalContentFits } from '../../hooks/ui/useOptionalLabelFits';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { ResizeHandles } from '../ui/ResizeHandles';
import { useModalTabCycling } from '../ui/ModalTabStrip';
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
import {
	MODELS_SETTINGS_NAV_ITEMS,
	ModelsSettingsTab,
	useModelsSettingsNav,
} from './tabs/LocalModelsTab';
import { useSettingsSearch, SettingsSearchInput, SettingsSearchResults } from './SettingsSearch';
import { usePluginContributions } from '../../hooks/usePluginContributions';
import { pluginSettingsId } from '../../../shared/plugins/panel-host';
import { PluginSettingsCard } from './PluginSettingsCard';
import { encoreTileForSetting, settingSubTab, type SearchableSetting } from './searchableSettings';
import type { EncoreTileRequest } from './tabs/EncoreTab/types';
import type { SettingsModalData } from '../../stores/modalStore';
import { LOCAL_MODEL_LIBRARY_SECTION_IDS } from '../../../shared/local-models/library';

/**
 * The tabs this modal renders: the shared {@link SettingsTab} (an alias rather
 * than a copy, so a tab added in one place cannot go missing here) plus one
 * dynamic tab per plugin settings page.
 */
type SettingsTabId = SettingsTab | `plugin-settings:${string}`;

/** One row of the sidebar: a tab, or a child of a tab's subtree. */
interface SettingsNavEntry {
	label: string;
	icon: ComponentType<{ className?: string }>;
}

interface SettingsNavItem extends SettingsNavEntry {
	id: SettingsTabId;
	/**
	 * The tab's subtree. Defaults to open whenever the sidebar has room for it,
	 * and otherwise only while the tab is open; the disclosure overrides that.
	 * Walked by Cmd+Shift+[ / ] in place of the tab itself.
	 */
	children?: readonly (SettingsNavEntry & { id: string })[];
	/**
	 * The place the tab row itself opens, for a tab with a subtree that has a
	 * landing page (Models opens its Overview). The row is the selected one while
	 * that place shows, and it is walked by Cmd+Shift+[ / ] before the children.
	 */
	landing?: string;
}

// Alphabetized by label (case-insensitive) so the sidebar reads predictably
// regardless of which tabs ship. Mount-time default is still 'general' -
// that's enforced by the useState init below, not by list position.
const TAB_ITEMS: SettingsNavItem[] = [
	{ id: 'about', label: 'About', icon: Info },
	{ id: 'aicommands', label: 'AI Commands', icon: Cpu },
	{ id: 'display', label: 'Display', icon: Monitor },
	{ id: 'environment', label: 'Environment', icon: Globe },
	{ id: 'general', label: 'General', icon: Settings },
	{ id: 'prompts', label: 'Maestro Prompts', icon: Wand2 },
	{
		id: 'models',
		label: 'Models',
		icon: HardDrive,
		children: MODELS_SETTINGS_NAV_ITEMS,
		landing: 'overview',
	},
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
//
// A tab with a subtree passes `expanded`. While one of its children is showing,
// that child carries the selection (background and edge) and the tab is drawn
// as the open parent: accent and bold, with no fill. A tab with a landing page
// passes `selected` while the landing page shows. In the sidebar a chevron
// toggles the subtree independently of the page the tab opens.
function SettingsTabButton({
	tab,
	isActive,
	orientation,
	theme,
	onClick,
	onToggle,
	child = false,
	expanded,
	selected = isActive && !expanded,
}: {
	tab: SettingsNavEntry;
	isActive: boolean;
	orientation: 'vertical' | 'horizontal';
	theme: Theme;
	onClick: () => void;
	/** Toggle the subtree without navigating away from the current page. */
	onToggle?: () => void;
	/** A row of a tab's subtree: indented in the sidebar, smaller everywhere. */
	child?: boolean;
	/** Whether this row carries the selection. Defaults to active and not an open parent. */
	selected?: boolean;
	/** Whether this tab's subtree is showing. Undefined for a tab with none. */
	expanded?: boolean;
}) {
	const Icon = tab.icon;
	const activeEdge = `2px solid ${theme.colors.accent}`;
	const inactiveEdge = '2px solid transparent';
	const vertical = orientation === 'vertical';
	const collapsible = vertical && expanded !== undefined && onToggle !== undefined;
	const padding = child
		? vertical
			? 'pl-10 pr-4 py-1.5'
			: 'px-3 py-2'
		: collapsible
			? 'pl-4 pr-12 py-2'
			: 'px-4 py-2';
	const Chevron = expanded ? ChevronDown : ChevronRight;
	const tabButton = (
		<button
			onClick={onClick}
			className={`flex items-center gap-2.5 ${padding} ${child ? 'text-[13px]' : 'text-sm'} text-left transition-colors cursor-pointer ${vertical ? 'w-full' : 'flex-shrink-0'} ${isActive ? 'font-bold' : 'opacity-70 hover:opacity-100'}`}
			style={{
				backgroundColor: selected ? theme.colors.bgActivity : 'transparent',
				color: isActive ? theme.colors.accent : theme.colors.textMain,
				...(vertical
					? { borderRight: selected ? activeEdge : inactiveEdge }
					: { borderBottom: selected ? activeEdge : inactiveEdge }),
			}}
			title={tab.label}
			aria-current={selected ? 'page' : undefined}
			aria-expanded={expanded}
		>
			<Icon className={`${child ? 'w-3.5 h-3.5' : 'w-4 h-4'} flex-shrink-0`} />
			<span className="whitespace-nowrap">{tab.label}</span>
		</button>
	);
	if (!collapsible) return tabButton;
	return (
		<div className="relative">
			{tabButton}
			<button
				type="button"
				onClick={onToggle}
				aria-label={`${expanded ? 'Collapse' : 'Expand'} ${tab.label}`}
				aria-expanded={expanded}
				className="absolute inset-y-0 right-0 px-4 opacity-70 hover:opacity-100 transition-opacity cursor-pointer"
				style={{ color: isActive ? theme.colors.accent : theme.colors.textMain }}
			>
				<Chevron className="w-3.5 h-3.5" aria-hidden="true" />
			</button>
		</div>
	);
}

// In-memory only - last tab the user was on. Resets on app restart, so the
// modal still defaults to General on a fresh launch. Honors any explicit
// `initialTab` prop (e.g. when a caller deep-links into a specific tab).
let lastOpenSettingsTab: SettingsTabId | null = null;

// In-memory only - last vertical scroll position per view (a tab, or one child
// of a tab's subtree, keyed like the cycling list below). Pairs with
// lastOpenSettingsTab so the user can reopen Settings (or flip between tabs)
// and land exactly where they were, instead of having to re-find the control
// they were tweaking. Resets on app restart.
const lastTabScrollPositions = new Map<string, number>();

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
	/** A `data-setting-id` to scroll to and flash on open (deep link from outside Settings). */
	initialSettingId?: string;
	/** The immutable modal data identifies each external navigation request. */
	initialNavigationRequest?: SettingsModalData;
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
		initialSettingId,
		initialNavigationRequest,
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
		toastPosition,
		setToastPosition,
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

	const contributions = usePluginContributions();
	const settingsPanels = useMemo(
		() => contributions.panels.filter((p) => p.placement === 'settings'),
		[contributions.panels]
	);
	const pluginSettings = useMemo<SearchableSetting[]>(
		() =>
			settingsPanels.map((panel) => ({
				id: pluginSettingsId(panel.id),
				tab: pluginSettingsId(panel.id),
				tabLabel: 'Plugin settings',
				label: panel.title,
				description: `Settings from ${panel.pluginId}.`,
				keywords: [panel.pluginId, panel.localId],
			})),
		[settingsPanels]
	);
	const tabItems = useMemo<SettingsNavItem[]>(
		() => [
			...TAB_ITEMS,
			...settingsPanels.map((panel) => ({
				id: pluginSettingsId(panel.id),
				label: panel.title,
				icon: Puzzle,
			})),
		],
		[settingsPanels]
	);

	// Lazy init reads the remembered tab on mount. Doing this in useState (rather
	// than a restore effect) avoids racing with the persist effect below - under
	// React StrictMode a restore-via-effect double-fires and clobbers the saved
	// value with the initial 'general' before the restored value lands.
	const [activeTab, setActiveTab] = useState<SettingsTabId>(
		() => initialTab || lastOpenSettingsTab || 'general'
	);
	const resizableModal = useResizableModal({
		resizeKey: 'settings',
		defaultSize: { width: 1200, height: 900 },
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
	const handledSettingIdRef = useRef<string | null>(null);
	const handledNavigationRequestRef = useRef<SettingsModalData | undefined>(undefined);
	const pendingPluginSettingIdRef = useRef<string | null>(null);
	// A jump to a setting inside a Plugins tile opens that tile; a plain tab
	// pick drops the request so returning to Plugins shows the grid again.
	const [encoreTileRequest, setEncoreTileRequest] = useState<EncoreTileRequest | null>(null);
	const requestEncoreTileFor = useCallback((settingId: string) => {
		const flag = encoreTileForSetting(settingId);
		setEncoreTileRequest(flag ? { flag } : null);
	}, []);
	const selectTab = useCallback((tab: SettingsTabId) => {
		pendingPluginSettingIdRef.current = null;
		setEncoreTileRequest(null);
		setActiveTab(tab);
	}, []);

	// Where the user is inside Models. Owned here because the sidebar draws its
	// panels as a subtree; the tab draws whatever this says.
	const modelsNav = useModelsSettingsNav();
	const { open: openModelsPlace } = modelsNav;

	// The open child of each tab that has a subtree, and how to move it.
	const childNavigation = useMemo<
		Partial<Record<SettingsTabId, { active: string; select: (id: string) => void }>>
	>(
		() => ({
			models: { active: modelsNav.panel, select: (id) => void openModelsPlace(id) },
		}),
		[modelsNav.panel, openModelsPlace]
	);
	const selectChild = useCallback(
		(tab: SettingsTabId, child: string) => {
			pendingPluginSettingIdRef.current = null;
			setActiveTab(tab);
			childNavigation[tab]?.select(child);
		},
		[childNavigation]
	);
	const activeChild = childNavigation[activeTab]?.active;
	// The view on screen: a tab, or `tab>child` inside a subtree. Keys the
	// remembered scroll position and the Cmd+Shift+[ / ] walk.
	const activeViewKey = activeChild !== undefined ? `${activeTab}>${activeChild}` : activeTab;

	// A jump into a tab's inner place (Models > Library > Speech), from a deep
	// link or a search result. Only Models has one; a path it does not know is
	// ignored and the tab opens where it was.
	const requestSubTab = useCallback(
		(subTab: string | undefined) => {
			if (subTab) openModelsPlace(subTab);
		},
		[openModelsPlace]
	);

	const handleSearchNavigate = useCallback(
		(tab: SearchableSetting['tab'], settingId: string) => {
			pendingScrollIdRef.current = settingId;
			setQueryRef.current('');
			requestSubTab(settingSubTab(settingId));
			selectTab(tab);
			requestEncoreTileFor(settingId);
		},
		[selectTab, requestSubTab, requestEncoreTileFor]
	);

	// Deep link from outside Settings (e.g. a disabled control explaining which
	// setting unlocks it). Bumping the counter re-runs the jump effect below even
	// when the target tab is already the active one.
	const [deepLinkJump, setDeepLinkJump] = useState(0);
	useEffect(() => {
		if (isOpen) {
			requestSubTab(
				initialNavigationRequest?.subTab ??
					(initialSettingId ? settingSubTab(initialSettingId) : undefined)
			);
		}
	}, [isOpen, initialSettingId, initialNavigationRequest, requestSubTab]);

	useEffect(() => {
		if (!isOpen || !initialSettingId) {
			handledSettingIdRef.current = null;
			pendingPluginSettingIdRef.current = null;
			if (!isOpen) setEncoreTileRequest(null);
			return;
		}
		if (
			handledSettingIdRef.current === initialSettingId &&
			handledNavigationRequestRef.current === initialNavigationRequest
		)
			return;
		handledNavigationRequestRef.current = initialNavigationRequest;
		handledSettingIdRef.current = initialSettingId;
		pendingPluginSettingIdRef.current = null;
		pendingScrollIdRef.current = initialSettingId;
		requestEncoreTileFor(initialSettingId);
		if (initialSettingId.startsWith('plugin-settings:')) {
			// Keep only unresolved requests pending. A user tab selection cancels
			// the request, so later registry refreshes cannot replay an old link.
			pendingPluginSettingIdRef.current = initialSettingId;
			pendingScrollIdRef.current = null;
			setActiveTab('encore');
		}
		setDeepLinkJump((n) => n + 1);
	}, [isOpen, initialSettingId, initialNavigationRequest, requestEncoreTileFor]);

	useEffect(() => {
		const targetId = pendingPluginSettingIdRef.current;
		if (!isOpen || !targetId) return;
		if (!settingsPanels.some((p) => pluginSettingsId(p.id) === targetId)) {
			// A missing link is deferred only while the contribution read is pending.
			// Once it settles, later registry changes must not replay a stale request.
			if (!contributions.isLoading) pendingPluginSettingIdRef.current = null;
			return;
		}
		pendingPluginSettingIdRef.current = null;
		pendingScrollIdRef.current = targetId;
		setActiveTab(targetId as SettingsTabId);
		setDeepLinkJump((n) => n + 1);
	}, [isOpen, initialSettingId, initialNavigationRequest, settingsPanels, contributions.isLoading]);

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
	}, [searchActive, activeTab, deepLinkJump]);

	const search = useSettingsSearch({
		isOpen,
		additionalSettings: pluginSettings,
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
		if (isOpen && initialTab && !initialSettingId?.startsWith('plugin-settings:')) {
			setActiveTab(initialTab);
		}
	}, [isOpen, initialTab, initialSettingId, initialNavigationRequest]);

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
		const saved = lastTabScrollPositions.get(activeViewKey) ?? 0;
		el.scrollTop = saved;
	}, [activeViewKey, isOpen]);

	// Save scroll position for the currently active tab on every scroll event.
	// Direct map write is cheap; no throttling needed. Pairs with the restore
	// effect above so the user can tweak a setting low in a long panel, flip
	// to another tab to verify the effect, and come back to exactly the same
	// position.
	const handleContentScroll = useCallback(
		(e: React.UIEvent<HTMLDivElement>) => {
			lastTabScrollPositions.set(activeViewKey, e.currentTarget.scrollTop);
		},
		[activeViewKey]
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

	// Tab navigation with Cmd+Shift+[ and ]. It walks the sidebar's rows: a tab
	// with a subtree is walked through its landing page and then its children,
	// so stepping into Models lands on its Overview going down and on its last
	// panel going up.
	const navLeaves = useMemo(
		() =>
			tabItems.flatMap((tab): { key: string; tab: SettingsTabId; child?: string }[] =>
				tab.children
					? [...(tab.landing ? [tab.landing] : []), ...tab.children.map((child) => child.id)].map(
							(child) => ({ key: `${tab.id}>${child}`, tab: tab.id, child })
						)
					: [{ key: tab.id, tab: tab.id }]
			),
		[tabItems]
	);
	const navLeafKeys = useMemo(() => navLeaves.map((leaf) => leaf.key), [navLeaves]);
	const selectNavLeaf = useCallback(
		(key: string) => {
			const leaf = navLeaves.find((entry) => entry.key === key);
			if (!leaf) return;
			if (leaf.child !== undefined) selectChild(leaf.tab, leaf.child);
			else selectTab(leaf.tab);
		},
		[navLeaves, selectChild, selectTab]
	);
	useModalTabCycling({
		tabs: navLeafKeys,
		activeTab: activeViewKey,
		onSelect: selectNavLeaf,
		enabled: isOpen,
	});
	const settingsIsTopLayer = useIsTopLayer(MODAL_PRIORITIES.SETTINGS);
	useModalTabCycling({
		tabs: LOCAL_MODEL_LIBRARY_SECTION_IDS,
		activeTab: modelsNav.librarySection,
		onSelect: modelsNav.setLibrarySection,
		shift: false,
		enabled:
			isOpen &&
			settingsIsTopLayer &&
			!searchActive &&
			activeTab === 'models' &&
			modelsNav.panel === 'library',
	});

	// By default, a subtree in the sidebar stays expanded while every row fits without
	// scrolling the sidebar, and collapses to "open only under the selected tab"
	// when it would not. Measured, not a breakpoint: the font size is a user
	// setting, and plugin settings pages add rows. The key re-measures when the
	// rows change or the sidebar is mounted again.
	const sidebarRef = useRef<HTMLElement>(null);
	const subtreesFit = useOptionalContentFits(sidebarRef, {
		axis: 'height',
		contentKey: `${isOpen}:${isXs}:${tabItems.length}`,
	});
	// A manual disclosure choice takes precedence over the automatic fit rule.
	const [subtreeExpansion, setSubtreeExpansion] = useState<Partial<Record<SettingsTabId, boolean>>>(
		{}
	);

	// The sidebar rows, for either orientation: every tab, and its subtree when
	// it is open or the sidebar has room for it, unless toggled manually. The phone
	// strip scrolls sideways anyway, so there it shows only under the selected tab.
	const renderNavItems = (orientation: 'vertical' | 'horizontal') =>
		tabItems.map((tab) => {
			const isActive = activeTab === tab.id;
			const expanded = tab.children
				? orientation === 'vertical'
					? (subtreeExpansion[tab.id] ?? (isActive || subtreesFit))
					: isActive
				: undefined;
			const landing = tab.landing;
			return (
				<Fragment key={tab.id}>
					<SettingsTabButton
						tab={tab}
						isActive={isActive}
						expanded={expanded}
						onToggle={
							tab.children
								? () => setSubtreeExpansion((previous) => ({ ...previous, [tab.id]: !expanded }))
								: undefined
						}
						selected={
							tab.children ? isActive && landing !== undefined && activeChild === landing : isActive
						}
						orientation={orientation}
						theme={theme}
						onClick={() =>
							landing !== undefined ? selectChild(tab.id, landing) : selectTab(tab.id)
						}
					/>
					{expanded &&
						tab.children?.map((child) => (
							<SettingsTabButton
								key={child.id}
								tab={child}
								child
								isActive={activeChild === child.id}
								orientation={orientation}
								theme={theme}
								onClick={() => selectChild(tab.id, child.id)}
							/>
						))}
				</Fragment>
			);
		});

	useEffect(() => {
		if (
			activeTab.startsWith('plugin-settings:') &&
			!pluginSettings.some((s) => s.tab === activeTab)
		) {
			lastTabScrollPositions.delete(activeTab);
			pendingScrollIdRef.current = null;
			setActiveTab('encore');
		}
	}, [activeTab, pluginSettings]);

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
					className={`flex ${isXs ? 'flex-col' : ''} flex-1 min-h-0 overflow-hidden ${searchActive ? 'hidden' : ''}`}
				>
					{isXs ? (
						/* Horizontal tab strip above content (xs phones) */
						<nav
							className="flex-shrink-0 flex border-b overflow-x-auto scrollbar-thin"
							style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
							aria-label="Settings tabs"
						>
							{renderNavItems('horizontal')}
						</nav>
					) : (
						/* Left Sidebar Tabs (sm and up) */
						<nav
							ref={sidebarRef}
							className="w-[248px] flex-shrink-0 border-r py-2 overflow-y-auto scrollbar-thin"
							style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
							aria-label="Settings tabs"
						>
							{renderNavItems('vertical')}
						</nav>
					)}

					{/* Content Area */}
					<div
						ref={contentRef}
						onScroll={handleContentScroll}
						className={`flex-1 min-w-0 min-h-0 ${activeTab.startsWith('plugin-settings:') ? 'flex flex-col overflow-hidden p-3 sm:p-4' : 'p-6 overflow-y-auto scrollbar-thin'}`}
						// Keep the Library's sticky strip flush with the scrollport. Its
						// summary owns the top inset so content cannot scroll above the strip.
						style={{
							paddingTop: activeTab === 'models' && modelsNav.panel === 'library' ? 0 : undefined,
						}}
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
								onConfigureNotificationShortcut={() => setActiveTab('shortcuts')}
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
								toastPosition={toastPosition}
								setToastPosition={setToastPosition}
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

						{activeTab === 'models' && <ModelsSettingsTab theme={theme} nav={modelsNav} />}

						{activeTab === 'encore' && (
							<EncoreTab theme={theme} isOpen={isOpen} tileRequest={encoreTileRequest} />
						)}

						{settingsPanels.map(
							(panel) =>
								activeTab === pluginSettingsId(panel.id) && (
									<PluginSettingsCard key={panel.id} panel={panel} theme={theme} />
								)
						)}

						{activeTab === 'about' && <AboutTab theme={theme} />}
					</div>
				</div>
			</div>
		</div>
	);
});
