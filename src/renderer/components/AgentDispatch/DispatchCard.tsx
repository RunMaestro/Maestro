/**
 * DispatchCard — a single work-item card for the Kanban board.
 *
 * Visually distinguishes agent-ready, blocked, claimed, stale, failed, and
 * completed states using Maestro theme tokens.
 */

import React, { memo, useCallback } from 'react';
import {
	// AlertTriangle, // TODO: port - unused in RC base, may be re-used when more status states land
	CheckCircle2,
	CircleDot,
	Clock,
	GitBranch,
	Loader2,
	Lock,
	Tag,
	XCircle,
} from 'lucide-react';
import type { Theme, WorkItem } from '../../types';
import { WORK_GRAPH_READY_TAG } from '../../types';
import { LineageChip } from '../CrossMajor/LineageChip';
import { SyncStateIndicator } from './SyncStateIndicator';
import type { TrackerSyncState } from '../../../shared/tracker-backend-types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CardVariant =
	| 'agent-ready'
	| 'blocked'
	| 'claimed'
	| 'stale'
	| 'failed'
	| 'completed'
	| 'default';

export interface DispatchCardProps {
	item: WorkItem;
	theme: Theme;
	/** Whether this card is currently being dragged */
	isDragging?: boolean;
	/** Called when the card is clicked to open detail view */
	onSelect?: (item: WorkItem) => void;
	/** Called to start a drag operation */
	onDragStart?: (e: React.DragEvent<HTMLDivElement>, item: WorkItem) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function deriveVariant(item: WorkItem): CardVariant {
	if (item.status === 'done' || item.status === 'canceled') return 'completed';
	if (item.status === 'blocked') return 'blocked';
	if (item.claim && item.claim.status === 'active') return 'claimed';
	if (item.tags.includes(WORK_GRAPH_READY_TAG)) return 'agent-ready';

	const updatedAge = Date.now() - new Date(item.updatedAt).getTime();
	if (updatedAge > STALE_MS) return 'stale';

	return 'default';
}

function getVariantStyles(
	variant: CardVariant,
	theme: Theme
): { border: string; badge: string; badgeText: string; icon: React.ReactNode } {
	switch (variant) {
		case 'agent-ready':
			return {
				border: theme.colors.success,
				badge: `${theme.colors.success}20`,
				badgeText: theme.colors.success,
				icon: <CircleDot className="w-3 h-3" />,
			};
		case 'blocked':
			return {
				border: theme.colors.error,
				badge: `${theme.colors.error}20`,
				badgeText: theme.colors.error,
				icon: <Lock className="w-3 h-3" />,
			};
		case 'claimed':
			return {
				border: theme.colors.warning,
				badge: `${theme.colors.warning}20`,
				badgeText: theme.colors.warning,
				icon: <Loader2 className="w-3 h-3 animate-spin" />,
			};
		case 'stale':
			return {
				border: theme.colors.textDim,
				badge: `${theme.colors.textDim}20`,
				badgeText: theme.colors.textDim,
				icon: <Clock className="w-3 h-3" />,
			};
		case 'failed':
			return {
				border: theme.colors.error,
				badge: `${theme.colors.error}20`,
				badgeText: theme.colors.error,
				icon: <XCircle className="w-3 h-3" />,
			};
		case 'completed':
			return {
				border: theme.colors.textDim,
				badge: `${theme.colors.textDim}15`,
				badgeText: theme.colors.textDim,
				icon: <CheckCircle2 className="w-3 h-3" />,
			};
		default:
			return {
				border: theme.colors.border,
				badge: `${theme.colors.accent}15`,
				badgeText: theme.colors.accent,
				icon: <Tag className="w-3 h-3" />,
			};
	}
}

const VARIANT_LABELS: Record<CardVariant, string> = {
	'agent-ready': 'agent-ready',
	blocked: 'blocked',
	claimed: 'claimed',
	stale: 'stale',
	failed: 'failed',
	completed: 'done',
	default: '',
};

function formatRelativeDate(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	const days = Math.floor(diff / 86_400_000);
	if (days < 1) return 'today';
	if (days === 1) return 'yesterday';
	if (days < 7) return `${days}d ago`;
	if (days < 30) return `${Math.floor(days / 7)}w ago`;
	return `${Math.floor(days / 30)}mo ago`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const DispatchCard = memo(function DispatchCard({
	item,
	theme,
	isDragging = false,
	onSelect,
	onDragStart,
}: DispatchCardProps) {
	const variant = deriveVariant(item);
	const { border, badge, badgeText, icon } = getVariantStyles(variant, theme);
	const label = VARIANT_LABELS[variant];

	const handleClick = useCallback(() => {
		onSelect?.(item);
	}, [item, onSelect]);

	const handleDragStart = useCallback(
		(e: React.DragEvent<HTMLDivElement>) => {
			e.dataTransfer.setData('workItemId', item.id);
			e.dataTransfer.effectAllowed = 'move';
			onDragStart?.(e, item);
		},
		[item, onDragStart]
	);

	return (
		<div
			draggable
			role="button"
			tabIndex={0}
			aria-label={item.title}
			data-testid="dispatch-card"
			data-item-id={item.id}
			onClick={handleClick}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					handleClick();
				}
			}}
			onDragStart={handleDragStart}
			className="rounded border px-3 py-2.5 cursor-grab select-none transition-opacity outline-none focus-visible:ring-1"
			style={{
				borderColor: border,
				backgroundColor: theme.colors.bgActivity,
				opacity: isDragging ? 0.5 : 1,
				// @ts-expect-error -- CSS custom property for focus ring
				'--tw-ring-color': theme.colors.accent,
			}}
		>
			{/* Header row */}
			<div className="flex items-start justify-between gap-2">
				<span
					className="text-xs font-medium leading-snug line-clamp-2 flex-1 min-w-0"
					style={{ color: theme.colors.textMain }}
				>
					{item.title}
				</span>
				{label && (
					<span
						className="shrink-0 flex items-center gap-1 text-[10px] font-bold rounded px-1.5 py-0.5 mt-0.5"
						style={{ backgroundColor: badge, color: badgeText }}
					>
						{icon}
						{label}
					</span>
				)}
			</div>

			{/* Meta row */}
			<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
				{/* Type badge */}
				<span className="text-[10px] font-medium" style={{ color: theme.colors.textDim }}>
					{item.type}
				</span>

				{/* GitHub issue */}
				{item.github?.issueNumber && (
					<span
						className="flex items-center gap-0.5 text-[10px]"
						style={{ color: theme.colors.textDim }}
					>
						<GitBranch className="w-2.5 h-2.5" />#{item.github.issueNumber}
					</span>
				)}

				{/* Claim holder */}
				{item.claim?.status === 'active' && item.claim.owner?.name && (
					<span
						className="text-[10px] rounded px-1 py-0.5"
						style={{ backgroundColor: `${theme.colors.warning}15`, color: theme.colors.warning }}
					>
						{item.claim.owner.name}
					</span>
				)}

				{/* Sync-state indicator (local-first tracker) */}
				{item.trackerSyncState && (
					<SyncStateIndicator
						state={item.trackerSyncState as TrackerSyncState}
						externalUrl={item.trackerExternalUrl}
						lastError={item.trackerLastError}
						theme={theme}
					/>
				)}

				{/* Updated date */}
				<span className="ml-auto text-[10px] shrink-0" style={{ color: theme.colors.textDim }}>
					{formatRelativeDate(item.updatedAt)}
				</span>
			</div>

			{/* Tag chips — show up to 3 */}
			{item.tags.length > 0 && (
				<div className="mt-1.5 flex flex-wrap gap-1">
					{item.tags.slice(0, 3).map((t) => (
						<span
							key={t}
							className="text-[10px] rounded px-1 py-0.5"
							style={{
								backgroundColor: `${theme.colors.accent}15`,
								color: theme.colors.accentText,
							}}
						>
							{t}
						</span>
					))}
					{item.tags.length > 3 && (
						<span className="text-[10px]" style={{ color: theme.colors.textDim }}>
							+{item.tags.length - 3}
						</span>
					)}
				</div>
			)}

			{/* Cross-major lineage chips */}
			<div className="mt-1.5">
				<LineageChip workItem={item} theme={theme} />
			</div>
		</div>
	);
});
