/**
 * AppShell - spatial layout for MaestroConsoleInner.
 *
 * Owns the shell chrome (title bar, sidebars, center workspace, overlays).
 * Modal wiring and complex view assembly (AppModals, group chat, log viewer)
 * stay in App.tsx and are passed in as slots.
 */

import React, { useEffect, type ComponentProps, type ReactNode } from 'react';
import { isWebDesktop } from '../utils/runtimeContext';
import { SessionList } from './SessionList';
import { RightPanel, type RightPanelHandle } from './RightPanel';
import { MainPanel, type MainPanelHandle } from './MainPanel';
import { EmptyStateView } from './EmptyStateView';
import { AgentsLoadingView } from './AgentsLoadingView';
import { ErrorBoundary } from './ErrorBoundary';
import { PluginPanelSlot } from './plugins/PluginPanelSlot';
import { ToastContainer } from './Toast';
import { CenterFlash } from './CenterFlash';
import { ImageContextMenuHost } from './ImageContextMenuHost';
import { MediaPlaybackHost } from './MediaPlayback';
import { ThoughtStreamPanel } from './ThoughtStreamPanel';
import { ContextTimelinePanel } from './ContextTimelinePanel';
import { PermissionPrompt } from './PermissionPrompt';
import { CadenzaLayer } from './Cadenza';
import { ConcertoStageModal } from './Concerto/ConcertoStageModal';
import { VoiceHud } from './ACappella';
import { useCadenzaStore } from '../stores/cadenzaStore';
import { useMovementStore } from '../stores/movementStore';
import { selectActiveSession, useSessionStore } from '../stores/sessionStore';
import type { Group, GroupChat, Theme } from '../types';

type SessionListProps = ComponentProps<typeof SessionList>;
type MainPanelProps = ComponentProps<typeof MainPanel>;
type RightPanelProps = ComponentProps<typeof RightPanel>;
type EmptyStateViewProps = ComponentProps<typeof EmptyStateView>;

export interface AppShellProps {
	theme: Theme;
	keyboardShellOffset: number;
	isMobileLandscape: boolean;
	useNativeTitleBar: boolean;
	isMdDownViewport: boolean;
	concertoEnabled: boolean;
	aCappellaEnabled: boolean;

	activeGroupChatId: string | null;
	groupChats: GroupChat[];
	groups: Group[];

	modals: ReactNode;
	standaloneModals: ReactNode;
	logViewerOpen: boolean;
	logViewer: ReactNode | null;
	groupChatView: ReactNode | null;

	hasSessions: boolean;
	sessionsLoaded: boolean;
	emptyStateProps: Omit<EmptyStateViewProps, 'theme'>;

	sessionListProps: SessionListProps;
	mainPanelRef: React.RefObject<MainPanelHandle>;
	mainPanelProps: MainPanelProps;
	rightPanelRef: React.RefObject<RightPanelHandle>;
	rightPanelProps: RightPanelProps;

	isNarrowViewport: boolean;
	leftSidebarOpen: boolean;
	rightPanelOpen: boolean;
	onCloseDrawers: () => void;
	drawerCloseSwipeHandlers: React.HTMLAttributes<HTMLDivElement>;
	/**
	 * Drawer-OPENING swipes, spread on the shell root. Already gated on where a
	 * touch starts (useEdgeSwipeHandlers) and empty when disabled, so the shell
	 * never has to know about edges.
	 */
	edgeSwipeHandlers: React.HTMLAttributes<HTMLDivElement>;

	onToastSessionClick: (sessionId: string, tabId?: string) => void;
}

export function AppShell({
	theme,
	keyboardShellOffset,
	isMobileLandscape,
	useNativeTitleBar,
	isMdDownViewport,
	concertoEnabled,
	aCappellaEnabled,
	activeGroupChatId,
	groupChats,
	groups,
	modals,
	standaloneModals,
	logViewerOpen,
	logViewer,
	groupChatView,
	hasSessions,
	sessionsLoaded,
	emptyStateProps,
	sessionListProps,
	mainPanelRef,
	mainPanelProps,
	rightPanelRef,
	rightPanelProps,
	isNarrowViewport,
	leftSidebarOpen,
	rightPanelOpen,
	onCloseDrawers,
	drawerCloseSwipeHandlers,
	edgeSwipeHandlers,
	onToastSessionClick,
}: AppShellProps) {
	// PERF: Title chrome self-sources a narrow slice so App does not pass
	// activeSession into the shell (busy/log flushes stay off this paint path when
	// App's chrome equality ignores state).
	const titleGroupId = useSessionStore((s) => selectActiveSession(s)?.groupId);
	const titleSessionName = useSessionStore((s) => selectActiveSession(s)?.name);
	const titleTabLabel = useSessionStore((s) => {
		const sess = selectActiveSession(s);
		if (!sess) return null;
		const activeTab = sess.aiTabs?.find((t) => t.id === sess.activeTabId);
		if (!activeTab) return null;
		return (
			activeTab.name ||
			(activeTab.agentSessionId ? activeTab.agentSessionId.split('-')[0].toUpperCase() : null)
		);
	});
	const hasTitleSession = useSessionStore((s) => !!selectActiveSession(s));
	// Unmounting the Concerto surfaces only hides them; their Zustand stores live
	// outside React. Clear both stores when the feature is disabled so stale views
	// do not return if the user enables it again later.
	useEffect(() => {
		if (concertoEnabled) return;
		useCadenzaStore.getState().clearCadenzas();
		useMovementStore.getState().clearItems();
	}, [concertoEnabled]);

	const showTitleBar =
		!isMobileLandscape && !useNativeTitleBar && !isMdDownViewport && !isWebDesktop();

	return (
		<div
			// `font-mono` is deliberately absent. It resolves to the CODE face now
			// (see tailwind.config.mjs), which is not what the shell wants, and it
			// was already dead here - the inline fontFamily below has always won.
			className={`flex maestro-app-shell w-full overflow-hidden transition-colors duration-300 ${
				showTitleBar ? 'pt-10' : 'pt-0'
			}`}
			style={
				{
					backgroundColor: theme.colors.bgMain,
					color: theme.colors.textMain,
					// Read from the published variables rather than re-deriving from
					// props, so the shell and every portal outside it resolve the
					// same value. The literals are the first-paint fallback.
					fontFamily: 'var(--maestro-font-interface, ui-monospace, Menlo, monospace)',
					fontSize: 'var(--maestro-size-interface, 14px)',
					'--keyboard-offset': `${keyboardShellOffset}px`,
				} as React.CSSProperties
			}
			// Drawer-opening edge swipes (phones). Empty unless a drawer may open.
			{...edgeSwipeHandlers}
		>
			{showTitleBar && (
				<div
					className="chrome-sheen fixed top-0 left-0 right-0 h-10 flex items-center justify-center"
					style={
						{
							WebkitAppRegion: 'drag',
							backgroundColor: theme.colors.bgTitleBar ?? theme.colors.bgMain,
						} as React.CSSProperties
					}
				>
					{activeGroupChatId ? (
						<span
							className="text-xs select-none opacity-50"
							style={{ color: theme.colors.textDim }}
						>
							Maestro Group Chat:{' '}
							{groupChats.find((c) => c.id === activeGroupChatId)?.name || 'Unknown'}
						</span>
					) : (
						hasTitleSession &&
						titleSessionName && (
							<span
								className="text-xs select-none opacity-50"
								style={{ color: theme.colors.textDim }}
							>
								{(() => {
									const parts: string[] = [];
									const group = groups.find((g) => g.id === titleGroupId);
									if (group) {
										parts.push(`${group.emoji} ${group.name}`);
									}
									parts.push(titleSessionName);
									if (titleTabLabel) {
										parts.push(titleTabLabel);
									}
									return parts.join(' | ');
								})()}
							</span>
						)
					)}
				</div>
			)}

			{modals}
			{standaloneModals}

			{!hasSessions && !sessionsLoaded && !isMobileLandscape ? (
				<AgentsLoadingView theme={theme} />
			) : null}

			{!hasSessions && sessionsLoaded && !isMobileLandscape ? (
				<EmptyStateView theme={theme} {...emptyStateProps} />
			) : null}

			{/* On a narrow viewport the panels are drawers, and on a phone they cover
			    the whole screen - including the backdrop that carries the close-swipe
			    handlers below. So the drawers carry them too: a `display: contents`
			    wrapper adds no box, but React events from inside the panel still
			    bubble through it. useSwipeGestures only preventDefaults once a
			    gesture locks HORIZONTAL, so vertical scrolling inside the drawer is
			    untouched, and neither drawer scrolls sideways. */}
			{!isMobileLandscape && hasSessions && (
				<ErrorBoundary>
					<div
						className="contents"
						data-testid="left-drawer-swipe-host"
						{...(isNarrowViewport ? drawerCloseSwipeHandlers : {})}
					>
						<SessionList {...sessionListProps} />
					</div>
				</ErrorBoundary>
			)}

			<PluginPanelSlot
				theme={theme}
				placement="left"
				className="flex flex-col shrink-0 overflow-hidden border-r w-[320px]"
			/>

			{isNarrowViewport && hasSessions && (leftSidebarOpen || rightPanelOpen) && (
				<div
					className="maestro-mobile-backdrop"
					onClick={onCloseDrawers}
					{...drawerCloseSwipeHandlers}
					aria-hidden
				/>
			)}

			{logViewer}

			{groupChatView}

			{hasSessions && !activeGroupChatId && !logViewerOpen && (
				<MainPanel ref={mainPanelRef} {...mainPanelProps} />
			)}

			<PluginPanelSlot
				theme={theme}
				placement="main"
				className="flex flex-col flex-1 min-w-0 overflow-hidden"
			/>

			{!isMobileLandscape && hasSessions && !activeGroupChatId && !logViewerOpen && (
				<ErrorBoundary>
					<div
						className="contents"
						data-testid="right-drawer-swipe-host"
						{...(isNarrowViewport ? drawerCloseSwipeHandlers : {})}
					>
						<RightPanel ref={rightPanelRef} {...rightPanelProps} />
					</div>
				</ErrorBoundary>
			)}

			<PluginPanelSlot theme={theme} placement="right" />

			<ToastContainer theme={theme} onSessionClick={onToastSessionClick} />
			<CenterFlash theme={theme} />
			{/* --- IMAGE CONTEXT MENU (single, app-wide) ---
			    One delegated listener gives every image and diagram on screen a
			    right-click Copy / Save. Surfaces wire up nothing. See
			    ImageContextMenuHost. */}
			<ImageContextMenuHost theme={theme} />
			{/* --- MEDIA PLAYBACK (single, app-wide, never unmounted) ---
			    Owns the one <audio>/<video> element so playback survives switching
			    tabs and agents. Media never gets a tab: it renders only as the
			    floating player, which the user can drag anywhere. See
			    MediaPlaybackHost. */}
			<MediaPlaybackHost theme={theme} />
			<ThoughtStreamPanel theme={theme} />
			{/* --- CONTEXT TIMELINE (single, app-wide; opened from the header gauge) --- */}
			<ContextTimelinePanel theme={theme} />
			{/* --- PERMISSION PROMPT (Claude Code standard mode; portal) --- */}
			<PermissionPrompt theme={theme} />
			{/* --- A CAPPELLA VOICE HUD (single, app-wide; Encore-gated) ---
			    Owns the one `acappella:event` subscription, so it is mounted
			    unconditionally and gates itself: a second mount would project every
			    protocol event twice. Renders nothing, and subscribes to nothing,
			    while the Encore Feature is off. */}
			<VoiceHud theme={theme} enabled={aCappellaEnabled} />
			{/* --- CONCERTO ---
			    Cadenzas float over the app; the movement stage lives in its own
			    resizable window (Alt+C / command palette / hamburger menu). Both stay
			    MOUNTED while hidden so an interactive panel keeps its state. */}
			{concertoEnabled && (
				<>
					<CadenzaLayer theme={theme} />
					<ConcertoStageModal theme={theme} />
				</>
			)}
		</div>
	);
}
