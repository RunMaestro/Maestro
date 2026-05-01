/**
 * RightPanel component for Maestro web interface
 *
 * An inline panel (not overlay) that sits alongside the main content area.
 * Provides Files, History, Auto Run, and Git tabs — same content as RightDrawer
 * but rendered as a persistent, toggleable side panel for desktop-like UX.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { GitStatusPanel } from './GitStatusPanel';
import { FilesTabContent, HistoryTabContent, AutoRunTabContent } from './RightDrawer';
import { DevCrewPanel } from './DevCrewPanel';
import { useSwipeGestures } from '../hooks/useSwipeGestures';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import type {
	AutoRunState,
	UseWebSocketReturn,
	AgentDispatchClaimStartedMessage,
	AgentDispatchClaimEndedMessage,
} from '../hooks/useWebSocket';
import type { UseGitStatusReturn } from '../hooks/useGitStatus';
import type { RightDrawerTab } from './RightDrawer';

export interface RightPanelProps {
	sessionId: string;
	activeTab?: RightDrawerTab;
	autoRunState: AutoRunState | null;
	gitStatus: UseGitStatusReturn;
	onClose: () => void;
	onFileSelect?: (path: string) => void;
	projectPath?: string;
	onAutoRunOpenDocument?: (filename: string) => void;
	onAutoRunOpenSetup?: () => void;
	sendRequest: UseWebSocketReturn['sendRequest'];
	send: UseWebSocketReturn['send'];
	onViewDiff?: (filePath: string) => void;
	panelRef?: React.RefObject<HTMLDivElement>;
	width?: number;
	onResizeStart?: (e: React.MouseEvent) => void;
	/** When true, renders as a full-screen overlay (mobile) instead of an inline side panel */
	isFullScreen?: boolean;
	/** When true, the Dev Crew tab is shown (Encore: agentDispatch). */
	devCrewEnabled?: boolean;
	/** Latest claim event message forwarded from the WebSocket hook. */
	lastClaimMessage?: AgentDispatchClaimStartedMessage | AgentDispatchClaimEndedMessage | null;
}

const BASE_TABS: { id: RightDrawerTab; label: string }[] = [
	{ id: 'files', label: 'Files' },
	{ id: 'history', label: 'History' },
	{ id: 'autorun', label: 'Auto Run' },
	{ id: 'git', label: 'Git' },
];

/**
 * Inline right panel — renders as a flex child alongside main content.
 */
export function RightPanel({
	sessionId,
	activeTab = 'files',
	autoRunState,
	gitStatus,
	onClose,
	onFileSelect,
	projectPath,
	onAutoRunOpenDocument,
	onAutoRunOpenSetup,
	sendRequest,
	send,
	onViewDiff,
	panelRef,
	width,
	onResizeStart,
	isFullScreen,
	devCrewEnabled = false,
	lastClaimMessage,
}: RightPanelProps) {
	const colors = useThemeColors();
	const [currentTab, setCurrentTab] = useState<RightDrawerTab>(activeTab);

	// Build tab list: include Dev Crew when Encore flag is on.
	const tabs = devCrewEnabled
		? [...BASE_TABS, { id: 'dev-crew' as RightDrawerTab, label: 'Dev Crew' }]
		: BASE_TABS;

	// Slide-in animation state (full-screen overlay mode only)
	const [isOpen, setIsOpen] = useState(false);
	useEffect(() => {
		if (isFullScreen) {
			requestAnimationFrame(() => setIsOpen(true));
		}
	}, [isFullScreen]);

	// Swipe right to close (full-screen overlay mode only)
	const {
		handlers: swipeHandlers,
		offsetX,
		isSwiping,
	} = useSwipeGestures({
		onSwipeRight: () => handleClose(),
		trackOffset: true,
		maxOffset: 200,
		threshold: 50,
		lockDirection: true,
		enabled: !!isFullScreen,
	});

	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
		},
		[]
	);

	const handleClose = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setIsOpen(false);
		// Wait for close animation before unmounting
		closeTimerRef.current = setTimeout(() => onClose(), 300);
	}, [onClose]);

	const handleTabChange = useCallback((tab: RightDrawerTab) => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setCurrentTab(tab);
	}, []);

	// Calculate drawer transform based on open state and swipe offset
	const swipeOffset = isSwiping && offsetX > 0 ? offsetX : 0;
	const drawerTransform = isOpen ? `translateX(${swipeOffset}px)` : 'translateX(100%)';

	const panelStyle: React.CSSProperties = isFullScreen
		? {
				position: 'fixed',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				zIndex: 50,
				display: 'flex',
				flexDirection: 'column',
				backgroundColor: colors.bgMain,
				overflow: 'hidden',
				transform: drawerTransform,
				transition: isSwiping ? 'none' : 'transform 0.3s ease',
				touchAction: 'pan-y',
			}
		: {
				width: `${width ?? 320}px`,
				display: 'flex',
				flexDirection: 'column',
				borderLeft: `1px solid ${colors.border}`,
				backgroundColor: colors.bgMain,
				height: '100%',
				overflow: 'hidden',
				position: 'relative',
			};

	return (
		<>
			{isFullScreen && (
				<div
					onClick={handleClose}
					style={{
						position: 'fixed',
						top: 0,
						left: 0,
						right: 0,
						bottom: 0,
						backgroundColor: isOpen ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0)',
						zIndex: 49,
						transition: 'background-color 0.3s ease',
					}}
					aria-label="Close panel"
				/>
			)}
			<div ref={panelRef} {...(isFullScreen ? swipeHandlers : {})} style={panelStyle}>
				{!isFullScreen && onResizeStart && (
					<div
						onMouseDown={onResizeStart}
						style={{
							position: 'absolute',
							top: 0,
							left: 0,
							width: '4px',
							height: '100%',
							cursor: 'col-resize',
							zIndex: 10,
						}}
						onMouseEnter={(e) => {
							(e.currentTarget as HTMLElement).style.backgroundColor = colors.accent;
						}}
						onMouseLeave={(e) => {
							(e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
						}}
					/>
				)}
				{/* Header with tabs and close button */}
				<div
					style={{
						display: 'flex',
						alignItems: 'stretch',
						borderBottom: `1px solid ${colors.border}`,
						backgroundColor: colors.bgSidebar,
						flexShrink: 0,
					}}
				>
					{tabs.map((tab) => {
						const isActive = currentTab === tab.id;
						return (
							<button
								key={tab.id}
								onClick={() => handleTabChange(tab.id)}
								style={{
									flex: 1,
									minWidth: 0,
									padding: '10px 6px 8px',
									border: 'none',
									borderBottom: `2px solid ${isActive ? colors.accent : 'transparent'}`,
									backgroundColor: 'transparent',
									color: isActive ? colors.accent : colors.textDim,
									fontSize: '11px',
									fontWeight: isActive ? 600 : 500,
									cursor: 'pointer',
									touchAction: 'manipulation',
									WebkitTapHighlightColor: 'transparent',
									transition: 'color 0.15s ease, border-color 0.15s ease',
									whiteSpace: 'nowrap',
									textAlign: 'center',
								}}
								aria-selected={isActive}
								role="tab"
							>
								{tab.label}
							</button>
						);
					})}
					{/* Close button */}
					<button
						onClick={onClose}
						style={{
							padding: '8px 10px',
							border: 'none',
							backgroundColor: 'transparent',
							color: colors.textDim,
							cursor: 'pointer',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							flexShrink: 0,
							touchAction: 'manipulation',
						}}
						aria-label="Close panel"
						title="Close panel"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>

				{/* Tab content */}
				<div
					style={{
						flex: 1,
						overflowY: 'auto',
						overflowX: 'hidden',
					}}
				>
					{currentTab === 'files' && (
						<FilesTabContent
							sessionId={sessionId}
							onFileSelect={onFileSelect}
							sendRequest={sendRequest}
							projectPath={projectPath}
						/>
					)}
					{currentTab === 'history' && (
						<HistoryTabContent sessionId={sessionId} projectPath={projectPath} />
					)}
					{currentTab === 'autorun' && (
						<AutoRunTabContent
							sessionId={sessionId}
							autoRunState={autoRunState}
							onOpenSetup={onAutoRunOpenSetup}
							sendRequest={sendRequest}
							send={send}
							onOpenDocument={onAutoRunOpenDocument}
						/>
					)}
					{currentTab === 'git' && (
						<GitStatusPanel sessionId={sessionId} gitStatus={gitStatus} onViewDiff={onViewDiff} />
					)}
					{currentTab === 'dev-crew' && (
						<DevCrewPanel projectPath={projectPath} lastMessage={lastClaimMessage} />
					)}
				</div>
			</div>
		</>
	);
}
