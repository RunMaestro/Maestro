/**
 * Shared DocumentCard component for Auto Run document listings.
 *
 * Used by both AutoRunPanel (full-screen) and AutoRunTabContent (inline tab).
 */

import { useCallback } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import type { AutoRunDocument } from '../hooks/useAutoRun';

export interface DocumentCardProps {
	document: AutoRunDocument;
	onTap: (filename: string) => void;
}

export function DocumentCard({ document: doc, onTap }: DocumentCardProps) {
	const colors = useThemeColors();
	const progress = doc.taskCount > 0 ? Math.round((doc.completedCount / doc.taskCount) * 100) : 0;

	const handleTap = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		onTap(doc.filename);
	}, [doc.filename, onTap]);

	return (
		<button
			onClick={handleTap}
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
			{/* Filename */}
			<div
				style={{
					fontSize: '15px',
					fontWeight: 600,
					overflow: 'hidden',
					textOverflow: 'ellipsis',
					whiteSpace: 'nowrap',
					width: '100%',
				}}
			>
				{doc.filename}
			</div>

			{/* Progress row */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '10px',
					width: '100%',
				}}
			>
				<span
					style={{
						fontSize: '12px',
						color: colors.textDim,
						flexShrink: 0,
					}}
				>
					{doc.completedCount}/{doc.taskCount} tasks
				</span>

				{/* Mini progress bar */}
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

				<span
					style={{
						fontSize: '11px',
						color: colors.textDim,
						flexShrink: 0,
					}}
				>
					{progress}%
				</span>
			</div>
		</button>
	);
}
