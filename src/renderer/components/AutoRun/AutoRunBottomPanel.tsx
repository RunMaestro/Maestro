import { memo, useEffect, useRef, useState } from 'react';
import { RotateCcw, Save } from 'lucide-react';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { formatTokenCount } from '../../utils/tokenCounter';
import type { Theme } from '../../types';

export interface AutoRunBottomPanelProps {
	theme: Theme;
	taskCounts: { completed: number; total: number };
	tokenCount: number | null;
	isDirty: boolean;
	isLocked: boolean;
	onSave: () => void;
	onRevert: () => void;
	onOpenResetTasksModal: () => void;
}

export const AutoRunBottomPanel = memo(function AutoRunBottomPanel({
	theme,
	taskCounts,
	tokenCount,
	isDirty,
	isLocked,
	onSave,
	onRevert,
	onOpenResetTasksModal,
}: AutoRunBottomPanelProps) {
	const bottomPanelRef = useRef<HTMLDivElement>(null);
	const [isCompact, setIsCompact] = useState(false);

	// Threshold: 350px - below this, use icons only for save/revert and hide "completed"
	useEffect(() => {
		if (!bottomPanelRef.current) return;

		const observer = new ResizeObserver((entries) => {
			for (const entry of entries) {
				const width = entry.contentRect.width;
				// Use compact mode when width is below 350px
				setIsCompact(width < 350);
			}
		});

		observer.observe(bottomPanelRef.current);

		return () => observer.disconnect();
	}, []);

	return (
		<div
			ref={bottomPanelRef}
			className="flex-shrink-0 px-3 py-1.5 mt-[5px] text-xs border-t flex items-center justify-between"
			style={{
				backgroundColor: theme.colors.bgActivity,
				borderColor: theme.colors.border,
			}}
		>
			{/* Revert button - left side (visible in both edit and preview when dirty) */}
			{isDirty && !isLocked ? (
				<button
					onClick={onRevert}
					className={`${isCompact ? 'p-1.5' : 'px-2 py-0.5'} rounded text-xs transition-colors hover:opacity-80 flex items-center gap-1`}
					style={{
						backgroundColor: 'transparent',
						color: theme.colors.textDim,
						border: `1px solid ${theme.colors.border}`,
					}}
					title="Discard changes"
				>
					{isCompact ? <RotateCcw className="w-3.5 h-3.5" /> : 'Revert'}
				</button>
			) : (
				<div />
			)}

			{/* Center info: Reset button, Task count, and/or Token count */}
			<div className="flex items-center gap-3">
				{/* Reset button - only show when there are completed tasks */}
				{taskCounts.completed > 0 && !isLocked && (
					<button
						onClick={onOpenResetTasksModal}
						className="p-0.5 rounded transition-colors hover:bg-white/10"
						style={{ color: theme.colors.textDim }}
						title={`Reset ${taskCounts.completed} completed task${taskCounts.completed !== 1 ? 's' : ''}`}
					>
						<RotateCcw className="w-3.5 h-3.5" />
					</button>
				)}
				{taskCounts.total > 0 && (
					<span style={{ color: theme.colors.textDim }}>
						<span
							style={{
								color:
									taskCounts.completed === taskCounts.total
										? theme.colors.success
										: theme.colors.accent,
							}}
						>
							{taskCounts.completed}
						</span>{' '}
						of <span style={{ color: theme.colors.accent }}>{taskCounts.total}</span> task
						{taskCounts.total !== 1 ? 's' : ''}
						{!isCompact && ' completed'}
					</span>
				)}
				{tokenCount !== null && (
					<span style={{ color: theme.colors.textDim }}>
						<span className="opacity-60">Tokens:</span>{' '}
						<span style={{ color: theme.colors.accent }}>{formatTokenCount(tokenCount)}</span>
					</span>
				)}
				{taskCounts.total === 0 && tokenCount === null && isDirty && !isLocked && (
					<span style={{ color: theme.colors.textDim }}>Unsaved changes</span>
				)}
			</div>

			{/* Save button - right side (visible in both edit and preview when dirty) */}
			{isDirty && !isLocked ? (
				<button
					onClick={onSave}
					className={`group relative ${isCompact ? 'p-1.5' : 'px-2 py-0.5'} rounded text-xs transition-colors hover:opacity-80 flex items-center gap-1`}
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
						border: `1px solid ${theme.colors.accent}`,
					}}
					title={`Save changes (${formatShortcutKeys(['Meta', 's'])})`}
				>
					{isCompact ? <Save className="w-3.5 h-3.5" /> : 'Save'}
					{/* Keyboard shortcut overlay on hover - only show in non-compact mode */}
					{!isCompact && (
						<span
							className="absolute -top-7 left-1/2 -translate-x-1/2 px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none"
							style={{
								backgroundColor: theme.colors.bgMain,
								color: theme.colors.textDim,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							{formatShortcutKeys(['Meta', 's'])}
						</span>
					)}
				</button>
			) : (
				<div />
			)}
		</div>
	);
});
