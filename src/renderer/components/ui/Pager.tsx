/**
 * Pager - compact page controls for a client-side paginated list.
 *
 * Deliberately sized to sit in a TOOLBAR ROW rather than under the list. A
 * pager placed below a long grid inside a scrolling modal forces the user to
 * scroll to the bottom, click, then scroll back to the top to see the page they
 * just asked for. Keeping it beside the filter and sort controls means the
 * controls that change what you see all live in one place, always on screen.
 *
 * Pair with `usePagination`, which owns the arithmetic and the clamping:
 *
 * ```tsx
 * const pager = usePagination(rows, 32, `${filter}:${sort}`);
 * {pager.isPaginated && <Pager {...pager} theme={theme} testId="tab-pager" />}
 * ```
 */

import { memo, useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Theme } from '../../types';
import { GhostIconButton } from './GhostIconButton';

export interface PagerProps {
	theme: Theme;
	page: number;
	totalPages: number;
	onPrev: () => void;
	onNext: () => void;
	canGoPrev: boolean;
	canGoNext: boolean;
	/** Accessible label for the group, e.g. "Tab pages". */
	ariaLabel?: string;
	testId?: string;
}

export const Pager = memo(function Pager({
	theme,
	page,
	totalPages,
	onPrev,
	onNext,
	canGoPrev,
	canGoNext,
	ariaLabel = 'Pagination',
	testId,
}: PagerProps) {
	// Left/Right anywhere in the group pages the list. The buttons are the only
	// focusable children, so this fires with either one focused - no roving
	// tabindex needed for two controls.
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			if (e.key === 'ArrowLeft' && canGoPrev) {
				e.preventDefault();
				onPrev();
			} else if (e.key === 'ArrowRight' && canGoNext) {
				e.preventDefault();
				onNext();
			}
		},
		[canGoPrev, canGoNext, onPrev, onNext]
	);

	return (
		<div
			className="flex items-center gap-1"
			role="group"
			aria-label={ariaLabel}
			data-testid={testId}
			onKeyDown={handleKeyDown}
		>
			<GhostIconButton
				onClick={onPrev}
				disabled={!canGoPrev}
				ariaLabel="Previous page"
				title="Previous page"
				padding="p-0.5"
				color={canGoPrev ? theme.colors.textMain : theme.colors.textDim}
				style={{ opacity: canGoPrev ? 1 : 0.4 }}
				testId={testId ? `${testId}-prev` : undefined}
			>
				<ChevronLeft className="w-4 h-4" />
			</GhostIconButton>
			<span
				className="text-xs tabular-nums whitespace-nowrap px-1"
				style={{ color: theme.colors.textDim }}
				// The page number changes without moving focus, so a screen reader
				// would otherwise never announce that the list turned over.
				aria-live="polite"
				data-testid={testId ? `${testId}-label` : undefined}
			>
				{page} / {totalPages}
			</span>
			<GhostIconButton
				onClick={onNext}
				disabled={!canGoNext}
				ariaLabel="Next page"
				title="Next page"
				padding="p-0.5"
				color={canGoNext ? theme.colors.textMain : theme.colors.textDim}
				style={{ opacity: canGoNext ? 1 : 0.4 }}
				testId={testId ? `${testId}-next` : undefined}
			>
				<ChevronRight className="w-4 h-4" />
			</GhostIconButton>
		</div>
	);
});

export default Pager;
