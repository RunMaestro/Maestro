/**
 * RightDrawer component for Maestro mobile web interface
 *
 * A unified slide-out drawer combining Files, History, Auto Run, and Git tabs.
 * Slides in from the right edge with overlay backdrop.
 * Supports swipe-right-to-close gesture.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { useSwipeGestures } from '../hooks/useSwipeGestures';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import { GitStatusPanel } from './GitStatusPanel';
import type { AutoRunState, UseWebSocketReturn } from '../hooks/useWebSocket';
import type { UseGitStatusReturn } from '../hooks/useGitStatus';

/**
 * Tab identifiers for the drawer
 */
export type RightDrawerTab = 'files' | 'history' | 'autorun' | 'git';

/**
 * Props for RightDrawer component
 */
export interface RightDrawerProps {
	sessionId: string;
	activeTab?: RightDrawerTab;
	autoRunState: AutoRunState | null;
	gitStatus: UseGitStatusReturn;
	onClose: () => void;
	onFileSelect?: (path: string) => void;
	/** Props forwarded to the history panel */
	projectPath?: string;
	/** Props forwarded to AutoRunPanel */
	onAutoRunOpenDocument?: (filename: string) => void;
	onAutoRunOpenSetup?: () => void;
	sendRequest: UseWebSocketReturn['sendRequest'];
	send: UseWebSocketReturn['send'];
	/** Callback when a git file is tapped for diff viewing */
	onViewDiff?: (filePath: string) => void;
}

/**
 * Tab configuration
 */
const TABS: { id: RightDrawerTab; label: string }[] = [
	{ id: 'files', label: 'Files' },
	{ id: 'history', label: 'History' },
	{ id: 'autorun', label: 'Auto Run' },
	{ id: 'git', label: 'Git' },
];

/**
 * RightDrawer component
 *
 * Slide-out drawer from right edge with tabbed content.
 */
export function RightDrawer({
	sessionId,
	activeTab = 'history',
	autoRunState,
	gitStatus,
	onClose,
	onFileSelect,
	projectPath,
	onAutoRunOpenDocument: _onAutoRunOpenDocument,
	onAutoRunOpenSetup,
	sendRequest: _sendRequest,
	send: _send,
	onViewDiff,
}: RightDrawerProps) {
	const colors = useThemeColors();
	const [currentTab, setCurrentTab] = useState<RightDrawerTab>(activeTab);
	const [isOpen, setIsOpen] = useState(false);
	const drawerRef = useRef<HTMLDivElement>(null);

	// Animate in on mount
	useEffect(() => {
		// Trigger opening animation on next frame
		requestAnimationFrame(() => setIsOpen(true));
	}, []);

	// Swipe right to close
	const {
		handlers: swipeHandlers,
		offsetX,
		isSwiping,
	} = useSwipeGestures({
		onSwipeRight: () => handleClose(),
		trackOffset: true,
		maxOffset: 200,
		threshold: 100,
		lockDirection: true,
	});

	const handleClose = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setIsOpen(false);
		// Wait for close animation before unmounting
		setTimeout(() => onClose(), 300);
	}, [onClose]);

	const handleOverlayClick = useCallback(() => {
		handleClose();
	}, [handleClose]);

	const handleTabChange = useCallback((tab: RightDrawerTab) => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setCurrentTab(tab);
	}, []);

	// Close on Escape
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				handleClose();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [handleClose]);

	// Calculate drawer transform based on open state and swipe offset
	const swipeOffset = isSwiping && offsetX > 0 ? offsetX : 0;
	const drawerTransform = isOpen ? `translateX(${swipeOffset}px)` : 'translateX(100%)';

	return (
		<>
			{/* Overlay backdrop */}
			<div
				onClick={handleOverlayClick}
				style={{
					position: 'fixed',
					top: 0,
					left: 0,
					right: 0,
					bottom: 0,
					backgroundColor: isOpen ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0)',
					zIndex: 299,
					transition: 'background-color 0.3s ease-out',
				}}
				aria-label="Close drawer"
			/>

			{/* Drawer panel */}
			<div
				ref={drawerRef}
				{...swipeHandlers}
				style={{
					position: 'fixed',
					top: 0,
					right: 0,
					bottom: 0,
					width: '85vw',
					maxWidth: '400px',
					backgroundColor: colors.bgMain,
					zIndex: 300,
					display: 'flex',
					flexDirection: 'column',
					transform: drawerTransform,
					transition: isSwiping ? 'none' : 'transform 0.3s ease-out',
					boxShadow: isOpen ? '-4px 0 24px rgba(0, 0, 0, 0.3)' : 'none',
					touchAction: 'pan-y',
				}}
				role="dialog"
				aria-label="Right drawer"
			>
				{/* Tab bar */}
				<div
					style={{
						display: 'flex',
						alignItems: 'stretch',
						borderBottom: `1px solid ${colors.border}`,
						backgroundColor: colors.bgSidebar,
						paddingTop: 'max(0px, env(safe-area-inset-top))',
						flexShrink: 0,
						overflowX: 'auto',
						overflowY: 'hidden',
						WebkitOverflowScrolling: 'touch',
					}}
				>
					{TABS.map((tab) => {
						const isActive = currentTab === tab.id;
						return (
							<button
								key={tab.id}
								onClick={() => handleTabChange(tab.id)}
								style={{
									flex: 1,
									minWidth: 0,
									padding: '14px 8px 12px',
									border: 'none',
									borderBottom: `2px solid ${isActive ? colors.accent : 'transparent'}`,
									backgroundColor: 'transparent',
									color: isActive ? colors.accent : colors.textDim,
									fontSize: '12px',
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
						<FilesTabContent sessionId={sessionId} onFileSelect={onFileSelect} />
					)}
					{currentTab === 'history' && (
						<HistoryTabContent sessionId={sessionId} projectPath={projectPath} />
					)}
					{currentTab === 'autorun' && (
						<AutoRunTabContent autoRunState={autoRunState} onOpenSetup={onAutoRunOpenSetup} />
					)}
					{currentTab === 'git' && (
						<GitStatusPanel sessionId={sessionId} gitStatus={gitStatus} onViewDiff={onViewDiff} />
					)}
				</div>
			</div>
		</>
	);
}

/**
 * Files tab content - placeholder for file explorer
 * (No FileExplorerPanel exists in mobile yet)
 */
function FilesTabContent(_props: { sessionId: string; onFileSelect?: (path: string) => void }) {
	const colors = useThemeColors();

	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				justifyContent: 'center',
				padding: '40px 20px',
				textAlign: 'center',
				height: '100%',
			}}
		>
			<svg
				width="32"
				height="32"
				viewBox="0 0 24 24"
				fill="none"
				stroke={colors.textDim}
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
			</svg>
			<p style={{ fontSize: '14px', color: colors.textDim, marginTop: '12px' }}>
				File explorer coming soon
			</p>
		</div>
	);
}

/**
 * History tab content - inline history entries
 * Uses the same fetch logic as MobileHistoryPanel but rendered inline
 */
function HistoryTabContent({
	sessionId,
	projectPath,
}: {
	sessionId: string;
	projectPath?: string;
}) {
	const colors = useThemeColors();
	const [entries, setEntries] = useState<any[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchHistory = useCallback(async () => {
		setIsLoading(true);
		setError(null);
		try {
			const { buildApiUrl } = await import('../utils/config');
			const params = new URLSearchParams();
			if (projectPath) params.set('projectPath', projectPath);
			if (sessionId) params.set('sessionId', sessionId);

			const queryString = params.toString();
			const apiUrl = buildApiUrl(`/history${queryString ? `?${queryString}` : ''}`);

			const response = await fetch(apiUrl);
			if (!response.ok) {
				throw new Error(`Failed to fetch history: ${response.statusText}`);
			}
			const data = await response.json();
			setEntries(data.entries || []);
		} catch (err: any) {
			setError(err.message || 'Failed to load history');
		} finally {
			setIsLoading(false);
		}
	}, [projectPath, sessionId]);

	useEffect(() => {
		void fetchHistory();
	}, [fetchHistory]);

	if (isLoading) {
		return (
			<div
				style={{
					padding: '40px 20px',
					textAlign: 'center',
					color: colors.textDim,
					fontSize: '14px',
				}}
			>
				Loading history...
			</div>
		);
	}

	if (error) {
		return (
			<div style={{ padding: '40px 20px', textAlign: 'center' }}>
				<p style={{ fontSize: '14px', color: colors.error, marginBottom: '8px' }}>{error}</p>
				<p style={{ fontSize: '13px', color: colors.textDim }}>
					Make sure the desktop app is running
				</p>
			</div>
		);
	}

	if (entries.length === 0) {
		return (
			<div style={{ padding: '40px 20px', textAlign: 'center' }}>
				<p style={{ fontSize: '14px', color: colors.textDim }}>No history entries</p>
			</div>
		);
	}

	return (
		<div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
			{entries.map((entry: any) => (
				<div
					key={entry.id}
					style={{
						padding: '12px 14px',
						borderRadius: '10px',
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.bgSidebar,
					}}
				>
					<div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
						<span
							style={{
								fontSize: '10px',
								fontWeight: 600,
								textTransform: 'uppercase',
								padding: '2px 6px',
								borderRadius: '10px',
								backgroundColor:
									entry.type === 'AUTO' ? `${colors.warning}20` : `${colors.accent}20`,
								color: entry.type === 'AUTO' ? colors.warning : colors.accent,
								border: `1px solid ${entry.type === 'AUTO' ? `${colors.warning}40` : `${colors.accent}40`}`,
							}}
						>
							{entry.type}
						</span>
						<span style={{ fontSize: '11px', color: colors.textDim, marginLeft: 'auto' }}>
							{new Date(entry.timestamp).toLocaleTimeString([], {
								hour: '2-digit',
								minute: '2-digit',
							})}
						</span>
					</div>
					<p
						style={{
							fontSize: '13px',
							lineHeight: 1.4,
							color: colors.textMain,
							margin: 0,
							overflow: 'hidden',
							display: '-webkit-box',
							WebkitLineClamp: 2,
							WebkitBoxOrient: 'vertical' as const,
						}}
					>
						{entry.summary || 'No summary available'}
					</p>
				</div>
			))}
		</div>
	);
}

/**
 * Auto Run tab content - inline auto run info
 * Reuses the AutoRunPanel logic but rendered inline
 */
function AutoRunTabContent({
	autoRunState,
	onOpenSetup,
}: {
	autoRunState: AutoRunState | null;
	onOpenSetup?: () => void;
}) {
	const colors = useThemeColors();
	const isRunning = autoRunState?.isRunning ?? false;
	const totalTasks = autoRunState?.totalTasks ?? 0;
	const completedTasks = autoRunState?.completedTasks ?? 0;
	const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

	return (
		<div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
			{/* Status */}
			{isRunning && (
				<div
					style={{
						backgroundColor: colors.accent,
						padding: '12px 16px',
						borderRadius: '10px',
						display: 'flex',
						alignItems: 'center',
						gap: '12px',
					}}
				>
					<div
						style={{
							fontSize: '14px',
							fontWeight: 700,
							color: colors.accent,
							backgroundColor: 'white',
							padding: '6px 12px',
							borderRadius: '16px',
							flexShrink: 0,
						}}
					>
						{progress}%
					</div>
					<div style={{ flex: 1 }}>
						<span style={{ fontSize: '13px', color: 'white', fontWeight: 500 }}>
							Task {(autoRunState?.currentTaskIndex ?? 0) + 1}/{totalTasks}
						</span>
						<div
							style={{
								height: '4px',
								backgroundColor: 'rgba(255,255,255,0.3)',
								borderRadius: '2px',
								marginTop: '6px',
								overflow: 'hidden',
							}}
						>
							<div
								style={{
									width: `${progress}%`,
									height: '100%',
									backgroundColor: 'white',
									borderRadius: '2px',
									transition: 'width 0.3s ease-out',
								}}
							/>
						</div>
					</div>
				</div>
			)}

			{!isRunning && (
				<div style={{ padding: '20px', textAlign: 'center' }}>
					<p style={{ fontSize: '14px', color: colors.textDim, margin: 0 }}>
						Auto Run is not active
					</p>
				</div>
			)}

			{/* Actions */}
			<div style={{ display: 'flex', gap: '8px' }}>
				{onOpenSetup && (
					<button
						onClick={() => {
							triggerHaptic(HAPTIC_PATTERNS.tap);
							onOpenSetup();
						}}
						disabled={isRunning}
						style={{
							flex: 1,
							padding: '12px',
							borderRadius: '10px',
							backgroundColor: isRunning ? `${colors.accent}40` : colors.accent,
							border: 'none',
							color: 'white',
							fontSize: '13px',
							fontWeight: 600,
							cursor: isRunning ? 'not-allowed' : 'pointer',
							opacity: isRunning ? 0.5 : 1,
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
							minHeight: '44px',
						}}
					>
						Configure & Launch
					</button>
				)}
			</div>
		</div>
	);
}

export default RightDrawer;
