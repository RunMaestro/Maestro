/**
 * SortableTh - a clickable table header that sorts its column.
 *
 * Owns the three things every hand-rolled sortable header gets wrong:
 *
 *   - **Keyboard access.** The click target is a real `<button>`, not a `<th>`
 *     with `role="button"` and an `onClick`. The latter is unreachable by
 *     keyboard: `role` grants the semantics without granting the tab stop or
 *     the Enter/Space activation, so it announces as a button and then does
 *     nothing when you press one.
 *   - **`aria-sort` on the right element.** It belongs on the `<th>`, not on
 *     the inner control, and only the active column may carry a direction.
 *   - **A stable indicator slot.** The caret is always laid out (transparent
 *     when inactive), so switching columns doesn't reflow the header row.
 *
 * Pair with `useTableSort`, which owns the flip-vs-switch direction rule.
 */

import type { CSSProperties, ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { Theme } from '../../types';
import type { SortDirection } from '../../hooks/ui/useTableSort';

export interface SortableThProps<K extends string> {
	/** This column's sort key. */
	columnKey: K;
	label: ReactNode;
	/** Currently sorted column. */
	sortKey: K;
	direction: SortDirection;
	onSort: (key: K) => void;
	theme: Theme;
	/** Right-align numeric / countdown columns. Defaults to left. */
	align?: 'left' | 'right';
	/** Classes for the `<th>`; callers own padding and borders. */
	className?: string;
	style?: CSSProperties;
	/** Native tooltip explaining what the column sorts by. */
	title?: string;
	testId?: string;
}

export function SortableTh<K extends string>({
	columnKey,
	label,
	sortKey,
	direction,
	onSort,
	theme,
	align = 'left',
	className = '',
	style,
	title,
	testId,
}: SortableThProps<K>) {
	const isActive = sortKey === columnKey;
	const Caret = isActive && direction === 'desc' ? ChevronDown : ChevronUp;

	return (
		<th
			className={className}
			style={{ color: theme.colors.textDim, ...style }}
			aria-sort={isActive ? (direction === 'desc' ? 'descending' : 'ascending') : 'none'}
			data-testid={testId}
		>
			<button
				type="button"
				onClick={() => onSort(columnKey)}
				title={title}
				className={`inline-flex items-center gap-0.5 font-medium hover:opacity-100 transition-opacity ${
					align === 'right' ? 'flex-row-reverse' : ''
				}`}
				style={{ color: isActive ? theme.colors.accent : 'inherit' }}
			>
				{label}
				{/* Always laid out so the header row doesn't reflow when the
				    active column changes; only the active one is visible. */}
				<Caret
					className="w-3 h-3 shrink-0"
					style={{ opacity: isActive ? 1 : 0 }}
					aria-hidden="true"
				/>
			</button>
		</th>
	);
}
