/**
 * AppShell - spatial layout for MaestroConsoleInner.
 *
 * Owns the shell chrome (title bar, sidebars, center workspace, overlays).
 * Modal wiring and complex view assembly (AppModals, group chat, log viewer)
 * stay in App.tsx and are passed in as slots.
 */

import React, { type ComponentProps, type ReactNode } from 'react';
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
import { PermissionPrompt } from './PermissionPrompt';
import type { Group, GroupChat, Session, Theme } from '../types';

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

	activeGroupChatId: string | null;
	groupChats: GroupChat[];
	groups: Group[];
	activeSession: Session | null;

	modals: ReactNode;
	standaloneModals: ReactNode;
	logViewerOpen: boolean;
	logViewer: ReactNode | null;
	groupChatView: ReactNode | null;

	sessions: Session[];
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
	activeGroupChatId,
	groupChats,
	groups,
	activeSession,
	modals,
	standaloneModals,
	logViewerOpen,
	logViewer,
	groupChatView,
	sessions,
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
	const showTitleBar =
		!isMobileLandscape && !useNativeTitleBar && !isMdDownViewport && !isWebDesktop();

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
						activeSession && (
							<span
								className="text-xs select-none opacity-50"
								style={{ color: theme.colors.textDim }}
							>
								{(() => {
									const parts: string[] = [];
									const group = groups.find((g) => g.id === activeSession.groupId);
									if (group) {
										parts.push(`${group.emoji} ${group.name}`);
									}
									parts.push(activeSession.name);
									const activeTab = activeSession.aiTabs?.find(
										(t) => t.id === activeSession.activeTabId
									);
									if (activeTab) {
										const tabLabel =
											activeTab.name ||
											(activeTab.agentSessionId
												? activeTab.agentSessionId.split('-')[0].toUpperCase()
												: null);
										if (tabLabel) {
											parts.push(tabLabel);
										}
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

			{sessions.length === 0 && !sessionsLoaded && !isMobileLandscape ? (
				<AgentsLoadingView theme={theme} />
			) : null}

			{sessions.length === 0 && sessionsLoaded && !isMobileLandscape ? (
				<EmptyStateView theme={theme} {...emptyStateProps} />
			) : null}

			{!isMobileLandscape && sessions.length > 0 && (
				<ErrorBoundary>
					<SessionList {...sessionListProps} />
				</ErrorBoundary>
			)}

			<PluginPanelSlot
				theme={theme}
				placement="left"
				className="flex flex-col shrink-0 overflow-hidden border-r w-[320px]"
			/>

			{isNarrowViewport && sessions.length > 0 && (leftSidebarOpen || rightPanelOpen) && (
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

			{sessions.length > 0 && !activeGroupChatId && !logViewerOpen && (
				<MainPanel ref={mainPanelRef} {...mainPanelProps} />
			)}

			<PluginPanelSlot
				theme={theme}
				placement="main"
				className="flex flex-col flex-1 min-w-0 overflow-hidden"
			/>

			{!isMobileLandscape && sessions.length > 0 && !activeGroupChatId && !logViewerOpen && (
				<ErrorBoundary>
					<RightPanel ref={rightPanelRef} {...rightPanelProps} />
				</ErrorBoundary>
			)}

			<PluginPanelSlot theme={theme} placement="right" />

			<ToastContainer theme={theme} onSessionClick={onToastSessionClick} />
			<CenterFlash theme={theme} />
			<ThoughtStreamPanel theme={theme} />
			{/* --- PERMISSION PROMPT (Claude Code standard mode; portal) --- */}
			<PermissionPrompt theme={theme} />
		</div>
	);
}
