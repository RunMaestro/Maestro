/**
 * AppShell - spatial layout for MaestroConsoleInner.
 *
 * Owns the shell chrome (title bar, sidebars, center workspace, overlays).
 * Modal wiring and complex view assembly (AppModals, group chat, log viewer)
 * stay in App.tsx and are passed in as slots.
 */

import React, { useEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { withMonoFallback } from '../../shared/fontStack';
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
import { ThoughtStreamPanel } from './ThoughtStreamPanel';
import { ContextTimelinePanel } from './ContextTimelinePanel';
import { PermissionPrompt } from './PermissionPrompt';
import { CadenzaLayer } from './Cadenza';
import { MovementOverlay } from './Movement';
import { useCadenzaStore } from '../stores/cadenzaStore';
import { selectHasVisibleMovement, useMovementStore } from '../stores/movementStore';
import { selectActiveSession, useSessionStore } from '../stores/sessionStore';
import type { Group, GroupChat, Theme } from '../types';

type SessionListProps = ComponentProps<typeof SessionList>;
type MainPanelProps = ComponentProps<typeof MainPanel>;
type RightPanelProps = ComponentProps<typeof RightPanel>;
type EmptyStateViewProps = ComponentProps<typeof EmptyStateView>;

export interface AppShellProps {
	theme: Theme;
	fontFamily: string;
	fontSize: number;
	keyboardShellOffset: number;
	isMobileLandscape: boolean;
	useNativeTitleBar: boolean;
	isMdDownViewport: boolean;
	concertoEnabled: boolean;

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
	drawerSwipeEnabled: boolean;
	leftEdgeSwipeHandlers: React.HTMLAttributes<HTMLDivElement>;
	rightEdgeSwipeHandlers: React.HTMLAttributes<HTMLDivElement>;

	onToastSessionClick: (sessionId: string, tabId?: string) => void;
}

export function AppShell({
	theme,
	fontFamily,
	fontSize,
	keyboardShellOffset,
	isMobileLandscape,
	useNativeTitleBar,
	isMdDownViewport,
	concertoEnabled,
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
	drawerSwipeEnabled,
	leftEdgeSwipeHandlers,
	rightEdgeSwipeHandlers,
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
	const hasVisibleConcerto = useMovementStore(selectHasVisibleMovement);
	const concertoChatBoundaryRef = useRef<HTMLDivElement>(null);

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
	const concertoWorkspaceActive =
		concertoEnabled && hasVisibleConcerto && hasSessions && !activeGroupChatId && !logViewerOpen;
	const concertoWorkspaceLayout = concertoWorkspaceActive
		? isNarrowViewport
			? 'stacked'
			: 'side'
		: undefined;

	return (
		<div
			className={`flex maestro-app-shell w-full font-mono overflow-hidden transition-colors duration-300 ${
				showTitleBar ? 'pt-10' : 'pt-0'
			}`}
			style={
				{
					backgroundColor: theme.colors.bgMain,
					color: theme.colors.textMain,
					fontFamily: withMonoFallback(fontFamily),
					fontSize: `${fontSize}px`,
					'--keyboard-offset': `${keyboardShellOffset}px`,
				} as React.CSSProperties
			}
		>
			{showTitleBar && (
				<div
					className="fixed top-0 left-0 right-0 h-10 flex items-center justify-center"
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

			{!isMobileLandscape && hasSessions && (
				<ErrorBoundary>
					<SessionList {...sessionListProps} />
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

			{drawerSwipeEnabled && !leftSidebarOpen && !rightPanelOpen && (
				<>
					<div
						className="maestro-edge-swipe-zone maestro-edge-swipe-zone--left"
						{...leftEdgeSwipeHandlers}
						aria-hidden
					/>
					<div
						className="maestro-edge-swipe-zone maestro-edge-swipe-zone--right"
						{...rightEdgeSwipeHandlers}
						aria-hidden
					/>
				</>
			)}

			{logViewer}

			{groupChatView}

			{hasSessions &&
				!activeGroupChatId &&
				!logViewerOpen &&
				(concertoWorkspaceActive ? (
					<div
						ref={concertoChatBoundaryRef}
						data-testid="concerto-chat-surface"
						data-concerto-workspace
						className="flex flex-col min-w-0 min-h-0 overflow-hidden"
						style={
							isNarrowViewport
								? {
										position: 'fixed',
										left: 0,
										right: 0,
										bottom: 0,
										height: 'clamp(280px, 42vh, 460px)',
										zIndex: 90001,
										borderTop: `1px solid ${theme.colors.border}`,
										boxShadow: '0 -16px 40px -24px rgba(0,0,0,0.7)',
									}
								: {
										flex: '0 1 clamp(400px, 34vw, 520px)',
										width: 'clamp(400px, 34vw, 520px)',
										minWidth: 400,
										position: 'relative',
										zIndex: 1,
										borderRight: `1px solid ${theme.colors.border}`,
										boxShadow: '16px 0 40px -28px rgba(0,0,0,0.75)',
									}
						}
					>
						<MainPanel ref={mainPanelRef} {...mainPanelProps} />
					</div>
				) : (
					<MainPanel ref={mainPanelRef} {...mainPanelProps} />
				))}

			<PluginPanelSlot
				theme={theme}
				placement="main"
				className="flex flex-col flex-1 min-w-0 overflow-hidden"
			/>

			{!isMobileLandscape && hasSessions && !activeGroupChatId && !logViewerOpen && (
				<ErrorBoundary>
					<RightPanel ref={rightPanelRef} {...rightPanelProps} />
				</ErrorBoundary>
			)}

			<PluginPanelSlot theme={theme} placement="right" />

			<ToastContainer theme={theme} onSessionClick={onToastSessionClick} />
			<CenterFlash theme={theme} />
			<ThoughtStreamPanel theme={theme} />
			{/* --- CONTEXT TIMELINE (single, app-wide; opened from the header gauge) --- */}
			<ContextTimelinePanel theme={theme} />
			{/* --- PERMISSION PROMPT (Claude Code standard mode; portal) --- */}
			<PermissionPrompt theme={theme} />
			{concertoEnabled && (
				<>
					<CadenzaLayer theme={theme} />
					<MovementOverlay
						theme={theme}
						workspaceBoundaryRef={concertoWorkspaceActive ? concertoChatBoundaryRef : undefined}
						workspaceLayout={concertoWorkspaceLayout}
						workspaceTopInset={showTitleBar ? 40 : 0}
					/>
				</>
			)}
		</div>
	);
}
