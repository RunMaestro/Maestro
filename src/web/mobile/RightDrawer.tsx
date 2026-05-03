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
import { AutoRunInline } from './AutoRunInline';
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
	/** Bubbled up from `AutoRunInline` so the launch sheet can pre-fill the active doc. */
	onAutoRunSelectedDocumentChange?: (filename: string | null) => void;
	/** Open the server-driven folder picker (desktop parity for `dialog.selectFolder`). */
	onAutoRunOpenFolderPicker?: () => void;
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
	onAutoRunOpenDocument,
	onAutoRunOpenSetup,
	onAutoRunSelectedDocumentChange,
	onAutoRunOpenFolderPicker,
	sendRequest,
	send,
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
							onSelectedDocumentChange={onAutoRunSelectedDocumentChange}
							onOpenFolderPicker={onAutoRunOpenFolderPicker}
						/>
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
 * File node in the tree
 */
interface FileNode {
	name: string;
	type: 'file' | 'folder';
	children?: FileNode[];
	path: string;
}

/**
 * Props for FilesTabContent
 */
interface FilesTabContentProps {
	sessionId: string;
	onFileSelect?: (path: string) => void;
	sendRequest?: UseWebSocketReturn['sendRequest'];
	projectPath?: string;
}

/**
 * Files tab content - file explorer tree
 */
function FilesTabContent({
	sessionId,
	onFileSelect,
	sendRequest,
	projectPath,
}: FilesTabContentProps) {
	const colors = useThemeColors();
	const [tree, setTree] = useState<FileNode[]>([]);
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState('');

	const loadTree = useCallback(() => {
		if (!sendRequest || !projectPath) return;
		setLoading(true);
		setError(null);
		sendRequest<{ tree: FileNode[]; error?: string }>('get_file_tree', {
			sessionId,
			path: projectPath,
			maxDepth: 3,
		})
			.then((response) => {
				setTree(response.tree || []);
				if (response.error) setError(response.error);
				setLoading(false);
			})
			.catch((err: any) => {
				setError(err.message || 'Failed to load');
				setLoading(false);
			});
	}, [sendRequest, projectPath, sessionId]);

	// Load on mount and when dependencies change
	useEffect(() => {
		loadTree();
	}, [loadTree]);

	const toggleFolder = useCallback((path: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}, []);

	const filterLower = filter.toLowerCase();

	const matchesFilter = useCallback(
		(node: FileNode): boolean => {
			if (!filterLower) return true;
			if (node.name.toLowerCase().includes(filterLower)) return true;
			if (node.type === 'folder' && node.children) {
				return node.children.some((c) => matchesFilter(c));
			}
			return false;
		},
		[filterLower]
	);

	const renderNode = (node: FileNode, depth: number) => {
		if (!matchesFilter(node)) return null;
		const isExpanded = expanded.has(node.path) || (!!filterLower && node.type === 'folder');
		const isFolder = node.type === 'folder';

		return (
			<div key={node.path}>
				<button
					onClick={() => {
						if (isFolder) {
							toggleFolder(node.path);
						} else {
							onFileSelect?.(node.path);
						}
					}}
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: '4px',
						width: '100%',
						padding: '3px 8px',
						paddingLeft: `${8 + depth * 16}px`,
						border: 'none',
						backgroundColor: 'transparent',
						color: colors.textMain,
						fontSize: '12px',
						fontFamily: 'monospace',
						cursor: 'pointer',
						textAlign: 'left',
						whiteSpace: 'nowrap',
						overflow: 'hidden',
						textOverflow: 'ellipsis',
					}}
					onMouseEnter={(e) => {
						(e.currentTarget as HTMLElement).style.backgroundColor = `${colors.textDim}10`;
					}}
					onMouseLeave={(e) => {
						(e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
					}}
					title={node.path}
				>
					{isFolder ? (
						<>
							<svg
								width="10"
								height="10"
								viewBox="0 0 24 24"
								fill="none"
								stroke={colors.textDim}
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								style={{
									flexShrink: 0,
									transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
									transition: 'transform 0.1s ease',
								}}
							>
								<polyline points="9 18 15 12 9 6" />
							</svg>
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill={isExpanded ? colors.accent : colors.textDim}
								stroke="none"
								style={{ flexShrink: 0, opacity: 0.7 }}
							>
								<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
							</svg>
						</>
					) : (
						<>
							<span style={{ width: '10px', flexShrink: 0 }} />
							<svg
								width="14"
								height="14"
								viewBox="0 0 24 24"
								fill="none"
								stroke={colors.textDim}
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								style={{ flexShrink: 0, opacity: 0.5 }}
							>
								<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
								<polyline points="14 2 14 8 20 8" />
							</svg>
						</>
					)}
					<span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{node.name}</span>
				</button>
				{isFolder && isExpanded && node.children && (
					<div>{node.children.map((child) => renderNode(child, depth + 1))}</div>
				)}
			</div>
		);
	};

	if (!sendRequest || !projectPath) {
		return (
			<div
				style={{ padding: '24px', textAlign: 'center', color: colors.textDim, fontSize: '13px' }}
			>
				No project path available
			</div>
		);
	}

	return (
		<div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
			{/* Filter + refresh bar */}
			<div
				style={{
					display: 'flex',
					gap: '4px',
					padding: '8px',
					borderBottom: `1px solid ${colors.border}`,
					flexShrink: 0,
				}}
			>
				<input
					type="text"
					placeholder="Filter files..."
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					style={{
						flex: 1,
						padding: '4px 8px',
						fontSize: '12px',
						border: `1px solid ${colors.border}`,
						borderRadius: '4px',
						backgroundColor: 'transparent',
						color: colors.textMain,
						outline: 'none',
					}}
				/>
				<button
					onClick={loadTree}
					disabled={loading}
					style={{
						padding: '4px 8px',
						border: `1px solid ${colors.border}`,
						borderRadius: '4px',
						backgroundColor: 'transparent',
						color: colors.textDim,
						cursor: loading ? 'wait' : 'pointer',
						fontSize: '12px',
						flexShrink: 0,
					}}
					title="Refresh file tree"
				>
					{loading ? '...' : '\u21BB'}
				</button>
			</div>
			{/* Tree content */}
			<div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '4px 0' }}>
				{error && (
					<div style={{ padding: '12px', color: '#ef4444', fontSize: '12px' }}>{error}</div>
				)}
				{loading && tree.length === 0 && (
					<div
						style={{
							padding: '24px',
							textAlign: 'center',
							color: colors.textDim,
							fontSize: '13px',
						}}
					>
						Loading files...
					</div>
				)}
				{!loading && !error && tree.length === 0 && (
					<div
						style={{
							padding: '24px',
							textAlign: 'center',
							color: colors.textDim,
							fontSize: '13px',
						}}
					>
						No files found
					</div>
				)}
				{tree.map((node) => renderNode(node, 0))}
			</div>
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
 * Auto Run tab content — single-document editor with full desktop parity.
 * Wraps {@link AutoRunInline} so the inline tab matches the full-screen
 * `AutoRunPanel` exactly.
 */
function AutoRunTabContent({
	sessionId,
	autoRunState,
	onOpenSetup,
	sendRequest,
	send,
	onOpenDocument,
	onSelectedDocumentChange,
	onOpenFolderPicker,
}: {
	sessionId: string;
	autoRunState: AutoRunState | null;
	onOpenSetup?: () => void;
	sendRequest: UseWebSocketReturn['sendRequest'];
	send: UseWebSocketReturn['send'];
	onOpenDocument?: (filename: string) => void;
	onSelectedDocumentChange?: (filename: string | null) => void;
	onOpenFolderPicker?: () => void;
}) {
	const handleOpenSetup = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		onOpenSetup?.();
	}, [onOpenSetup]);

	return (
		<div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
			<AutoRunInline
				sessionId={sessionId}
				autoRunState={autoRunState}
				sendRequest={sendRequest}
				send={send}
				onOpenSetup={handleOpenSetup}
				onExpandDocument={onOpenDocument}
				onSelectedDocumentChange={onSelectedDocumentChange}
				onOpenFolderPicker={onOpenFolderPicker}
			/>
		</div>
	);
}

export default RightDrawer;

// Export tab content components for reuse in RightPanel (inline mode)
export { FilesTabContent, HistoryTabContent, AutoRunTabContent };
