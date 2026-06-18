/**
 * GitStatusPanel component for Maestro mobile web interface
 *
 * Displays git status for the active session including branch info,
 * ahead/behind counts, and categorized file lists (staged, modified, untracked).
 * Tapping a file triggers a diff view.
 */

import { useState, useCallback, useEffect } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import type { GitStatusFile, UseGitStatusReturn } from '../hooks/useGitStatus';

/**
 * Props for GitStatusPanel component
 */
export interface GitStatusPanelProps {
	sessionId: string;
	gitStatus: UseGitStatusReturn;
	onViewDiff?: (filePath: string) => void;
}

/**
 * Status icon character for git file status codes
 */
function statusIcon(status: string): string {
	switch (status.trim().charAt(0)) {
		case 'M':
			return 'M';
		case 'A':
			return 'A';
		case 'D':
			return 'D';
		case 'R':
			return 'R';
		case 'C':
			return 'C';
		case '?':
			return '?';
		default:
			return status.trim().charAt(0) || '?';
	}
}

/**
 * Color for a git file status icon
 */
function statusColor(status: string, colors: ReturnType<typeof useThemeColors>): string {
	const code = status.trim().charAt(0);
	switch (code) {
		case 'M':
			return colors.warning;
		case 'A':
			return colors.success;
		case 'D':
			return colors.error;
		case 'R':
			return colors.accent;
		case '?':
			return colors.textDim;
		default:
			return colors.textMain;
	}
}

/**
 * Collapsible file section
 */
function FileSection({
	title,
	files,
	accentColor,
	colors,
	onFileSelect,
}: {
	title: string;
	files: GitStatusFile[];
	accentColor: string;
	colors: ReturnType<typeof useThemeColors>;
	onFileSelect: (path: string) => void;
}) {
	const [collapsed, setCollapsed] = useState(false);

	if (files.length === 0) return null;

	return (
		<div style={{ marginBottom: '12px' }}>
			<button
				onClick={() => {
					triggerHaptic(HAPTIC_PATTERNS.tap);
					setCollapsed((c) => !c);
				}}
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '8px',
					width: '100%',
					padding: '8px 12px',
					border: 'none',
					borderLeft: `3px solid ${accentColor}`,
					borderRadius: '0 6px 6px 0',
					backgroundColor: `${accentColor}10`,
					color: colors.textMain,
					fontSize: '13px',
					fontWeight: 600,
					cursor: 'pointer',
					touchAction: 'manipulation',
					WebkitTapHighlightColor: 'transparent',
					textAlign: 'left',
				}}
			>
				<span
					style={{
						transition: 'transform 0.2s ease',
						transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
						fontSize: '10px',
					}}
				>
					&#9660;
				</span>
				{title}
				<span
					style={{
						marginLeft: 'auto',
						fontSize: '12px',
						color: colors.textDim,
						fontWeight: 400,
					}}
				>
					{files.length}
				</span>
			</button>

			{!collapsed && (
				<div style={{ marginTop: '4px' }}>
					{files.map((file) => (
						<button
							key={file.path}
							onClick={() => {
								triggerHaptic(HAPTIC_PATTERNS.tap);
								onFileSelect(file.path);
							}}
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: '10px',
								width: '100%',
								padding: '10px 12px 10px 20px',
								border: 'none',
								borderBottom: `1px solid ${colors.border}`,
								backgroundColor: 'transparent',
								color: colors.textMain,
								fontSize: '13px',
								fontFamily: 'monospace',
								cursor: 'pointer',
								touchAction: 'manipulation',
								WebkitTapHighlightColor: 'transparent',
								textAlign: 'left',
								minHeight: '44px',
							}}
						>
							<span
								style={{
									fontWeight: 700,
									fontSize: '12px',
									color: statusColor(file.status, colors),
									minWidth: '16px',
									textAlign: 'center',
								}}
							>
								{statusIcon(file.status)}
							</span>
							<span
								style={{
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									whiteSpace: 'nowrap',
									flex: 1,
								}}
							>
								{file.path}
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

/**
 * GitStatusPanel component
 *
 * Displays git branch info, ahead/behind badges, and categorized file lists.
 */
export function GitStatusPanel({ sessionId, gitStatus, onViewDiff }: GitStatusPanelProps) {
	const colors = useThemeColors();
	const { status, isLoading, refresh } = gitStatus;

	// Load status on mount
	useEffect(() => {
		if (sessionId) {
			refresh(sessionId);
		}
	}, [sessionId, refresh]);

	const handleRefresh = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		refresh(sessionId);
	}, [sessionId, refresh]);

	const handleFileSelect = useCallback(
		(filePath: string) => {
			if (onViewDiff) {
				onViewDiff(filePath);
			}
		},
		[onViewDiff]
	);

	// Categorize files
	const staged = status?.files.filter((f) => f.staged) ?? [];
	const modified =
		status?.files.filter((f) => !f.staged && f.status.trim().charAt(0) !== '?') ?? [];
	const untracked =
		status?.files.filter((f) => !f.staged && f.status.trim().charAt(0) === '?') ?? [];

	const isClean = status !== null && status.files.length === 0;

	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				height: '100%',
			}}
		>
			{/* Header: branch info + refresh */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '12px 16px',
					borderBottom: `1px solid ${colors.border}`,
					backgroundColor: colors.bgSidebar,
					flexShrink: 0,
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
					{/* Branch icon */}
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke={colors.accent}
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<line x1="6" y1="3" x2="6" y2="15" />
						<circle cx="18" cy="6" r="3" />
						<circle cx="6" cy="18" r="3" />
						<path d="M18 9a9 9 0 0 1-9 9" />
					</svg>

					<span
						style={{
							fontSize: '14px',
							fontWeight: 600,
							color: colors.textMain,
							fontFamily: 'monospace',
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
						}}
					>
						{status?.branch || '...'}
					</span>

					{/* Ahead/behind badges */}
					{status && status.ahead > 0 && (
						<span
							style={{
								fontSize: '11px',
								fontWeight: 600,
								color: colors.success,
								backgroundColor: `${colors.success}20`,
								padding: '2px 6px',
								borderRadius: '10px',
							}}
						>
							&uarr;{status.ahead}
						</span>
					)}
					{status && status.behind > 0 && (
						<span
							style={{
								fontSize: '11px',
								fontWeight: 600,
								color: colors.warning,
								backgroundColor: `${colors.warning}20`,
								padding: '2px 6px',
								borderRadius: '10px',
							}}
						>
							&darr;{status.behind}
						</span>
					)}
				</div>

				{/* Refresh button */}
				<button
					onClick={handleRefresh}
					disabled={isLoading}
					style={{
						width: '36px',
						height: '36px',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						borderRadius: '8px',
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.bgMain,
						color: isLoading ? colors.textDim : colors.textMain,
						cursor: isLoading ? 'not-allowed' : 'pointer',
						touchAction: 'manipulation',
						WebkitTapHighlightColor: 'transparent',
						opacity: isLoading ? 0.5 : 1,
						transition: 'opacity 0.2s ease',
					}}
					aria-label="Refresh git status"
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
						style={{
							animation: isLoading ? 'gitRefreshSpin 1s linear infinite' : 'none',
						}}
					>
						<polyline points="23 4 23 10 17 10" />
						<polyline points="1 20 1 14 7 14" />
						<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
						<path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
					</svg>
				</button>
			</div>

			{/* File list */}
			<div
				style={{
					flex: 1,
					overflowY: 'auto',
					overflowX: 'hidden',
					padding: '12px 8px',
				}}
			>
				{isLoading && !status && (
					<div
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							padding: '40px 16px',
							color: colors.textDim,
							fontSize: '14px',
						}}
					>
						Loading git status...
					</div>
				)}

				{isClean && (
					<div
						style={{
							display: 'flex',
							flexDirection: 'column',
							alignItems: 'center',
							justifyContent: 'center',
							padding: '40px 16px',
							gap: '12px',
						}}
					>
						<svg
							width="32"
							height="32"
							viewBox="0 0 24 24"
							fill="none"
							stroke={colors.success}
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
							<polyline points="22 4 12 14.01 9 11.01" />
						</svg>
						<span
							style={{
								fontSize: '14px',
								color: colors.textDim,
								fontWeight: 500,
							}}
						>
							Working tree clean
						</span>
					</div>
				)}

				{!isClean && status && (
					<>
						<FileSection
							title="Staged"
							files={staged}
							accentColor={colors.success}
							colors={colors}
							onFileSelect={handleFileSelect}
						/>
						<FileSection
							title="Modified"
							files={modified}
							accentColor={colors.warning}
							colors={colors}
							onFileSelect={handleFileSelect}
						/>
						<FileSection
							title="Untracked"
							files={untracked}
							accentColor={colors.textDim}
							colors={colors}
							onFileSelect={handleFileSelect}
						/>
					</>
				)}
			</div>

			{/* Spin animation for refresh button */}
			<style>{`
				@keyframes gitRefreshSpin {
					from { transform: rotate(0deg); }
					to { transform: rotate(360deg); }
				}
			`}</style>
		</div>
	);
}

export default GitStatusPanel;
