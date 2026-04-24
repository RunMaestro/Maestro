/**
 * Shared DocumentCard component for Auto Run document listings.
 *
 * Used by both AutoRunPanel (full-screen) and AutoRunTabContent (inline tab).
 */

import { useCallback, useState } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import type { AutoRunDocument } from '../hooks/useAutoRun';

export interface DocumentCardProps {
	document: AutoRunDocument;
	onTap: (filename: string) => void;
	/**
	 * Optional reset callback. When provided, a small reset button appears on
	 * the card and only fires when the document has any completed tasks.
	 * Returns true if the reset succeeded, false otherwise.
	 */
	onReset?: (filename: string) => Promise<boolean> | void;
	/** When true, shows a small lock badge to indicate the run is in progress. */
	isLocked?: boolean;
}

export function DocumentCard({ document: doc, onTap, onReset, isLocked }: DocumentCardProps) {
	const colors = useThemeColors();
	const [isResetting, setIsResetting] = useState(false);
	const progress = doc.taskCount > 0 ? Math.round((doc.completedCount / doc.taskCount) * 100) : 0;
	const hasCompleted = doc.completedCount > 0;

	const handleTap = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		onTap(doc.filename);
	}, [doc.filename, onTap]);

	const handleReset = useCallback(
		async (e: React.MouseEvent) => {
			e.stopPropagation();
			if (!onReset || isResetting || !hasCompleted) return;
			const confirmed = window.confirm(
				`Reset all completed tasks in "${doc.filename}"? Each "[x]" will revert to "[ ]".`
			);
			if (!confirmed) return;
			triggerHaptic(HAPTIC_PATTERNS.tap);
			setIsResetting(true);
			try {
				await onReset(doc.filename);
			} finally {
				setIsResetting(false);
			}
		},
		[doc.filename, hasCompleted, isResetting, onReset]
	);

	return (
		<div
			onClick={handleTap}
			role="button"
			tabIndex={0}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					handleTap();
				}
			}}
			style={{
				display: 'flex',
				flexDirection: 'column',
				gap: '8px',
				padding: '14px 16px',
				borderRadius: '12px',
				border: `1px solid ${colors.border}`,
				backgroundColor: colors.bgSidebar,
				color: colors.textMain,
				width: '100%',
				textAlign: 'left',
				cursor: 'pointer',
				transition: 'all 0.15s ease',
				touchAction: 'manipulation',
				WebkitTapHighlightColor: 'transparent',
				userSelect: 'none',
				WebkitUserSelect: 'none',
			}}
			aria-label={`${doc.filename}, ${doc.completedCount} of ${doc.taskCount} tasks completed`}
		>
			{/* Header row: filename + optional folder + lock + reset */}
			<div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
				<div
					style={{
						fontSize: '15px',
						fontWeight: 600,
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
						flex: 1,
						minWidth: 0,
					}}
				>
					{doc.filename}
				</div>

				{isLocked && (
					<span
						title="Read-only while Auto Run is in progress"
						aria-label="Read-only while Auto Run is in progress"
						style={{
							fontSize: '11px',
							color: colors.warning,
							display: 'inline-flex',
							alignItems: 'center',
							gap: '3px',
							flexShrink: 0,
						}}
					>
						<svg
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<rect x="3" y="11" width="18" height="11" rx="2" />
							<path d="M7 11V7a5 5 0 0 1 10 0v4" />
						</svg>
					</span>
				)}

				{onReset && hasCompleted && (
					<button
						onClick={handleReset}
						disabled={isResetting || isLocked}
						style={{
							width: '32px',
							height: '32px',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							borderRadius: '8px',
							backgroundColor: colors.bgMain,
							border: `1px solid ${colors.border}`,
							color: isResetting ? colors.textDim : colors.textMain,
							cursor: isResetting || isLocked ? 'not-allowed' : 'pointer',
							flexShrink: 0,
							opacity: isLocked ? 0.4 : 1,
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
						}}
						aria-label={`Reset tasks in ${doc.filename}`}
						title="Reset completed tasks"
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
							<path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
						</svg>
					</button>
				)}
			</div>

			{/* Progress row */}
			<div style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%' }}>
				<span style={{ fontSize: '12px', color: colors.textDim, flexShrink: 0 }}>
					{doc.completedCount}/{doc.taskCount} tasks
				</span>

				<div
					style={{
						flex: 1,
						height: '4px',
						backgroundColor: `${colors.textDim}20`,
						borderRadius: '2px',
						overflow: 'hidden',
					}}
				>
					<div
						style={{
							width: `${progress}%`,
							height: '100%',
							backgroundColor: progress === 100 ? colors.success : colors.accent,
							borderRadius: '2px',
							transition: 'width 0.3s ease-out',
						}}
					/>
				</div>

				<span style={{ fontSize: '11px', color: colors.textDim, flexShrink: 0 }}>{progress}%</span>
			</div>
		</div>
	);
}
