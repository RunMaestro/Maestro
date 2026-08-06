/**
 * RankedChoice
 *
 * Starter input primitive for the shared widget library: a controlled,
 * reorderable list that emits a `RankedChoiceValue { orderedIds }`. Minimal but
 * real - reordering uses plain accessible up/down buttons (no drag-and-drop
 * dependency) so it works with keyboard and screen readers out of the box, and
 * it validates the `InputWidgetProps<T>` contract for a non-trivial value shape.
 *
 * The caller owns the id→label mapping via `items`; the control only renders and
 * re-emits the ordering, keeping the emitted value compact and serializable for
 * the upcoming dynamic-interface payloads.
 */

import { memo, useMemo } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import type { InputWidgetProps, RankedChoiceValue } from './types';

/** A single choosable option. */
export interface RankedChoiceItem {
	id: string;
	label: string;
}

interface RankedChoiceProps extends InputWidgetProps<RankedChoiceValue> {
	/** All selectable items; the id→label source. */
	items: RankedChoiceItem[];
}

/** Return a copy of `ids` with the entry at `index` swapped toward `delta`. */
function reorder(ids: string[], index: number, delta: number): string[] {
	const target = index + delta;
	if (target < 0 || target >= ids.length) return ids;
	const next = ids.slice();
	[next[index], next[target]] = [next[target], next[index]];
	return next;
}

export const RankedChoice = memo(function RankedChoice({
	theme,
	value,
	onChange,
	disabled = false,
	label,
	items,
}: RankedChoiceProps) {
	const labelById = useMemo(() => {
		const map = new Map<string, string>();
		for (const item of items) map.set(item.id, item.label);
		return map;
	}, [items]);

	// Render in the requested order; fall back to any items the order omitted so
	// the control never silently drops a choice.
	const orderedIds = useMemo(() => {
		const known = value.orderedIds.filter((id) => labelById.has(id));
		const missing = items.map((i) => i.id).filter((id) => !known.includes(id));
		return [...known, ...missing];
	}, [value.orderedIds, items, labelById]);

	const move = (index: number, delta: number) => {
		if (disabled) return;
		const next = reorder(orderedIds, index, delta);
		if (next !== orderedIds) onChange({ orderedIds: next });
	};

	return (
		<div className="flex flex-col gap-1.5" style={{ opacity: disabled ? 0.5 : 1 }}>
			{label && (
				<span
					className="text-[11px] font-medium uppercase tracking-wide"
					style={{ color: theme.colors.textDim }}
				>
					{label}
				</span>
			)}
			<ol className="flex flex-col gap-1.5">
				{orderedIds.map((id, index) => (
					<li
						key={id}
						className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border"
						style={{
							backgroundColor: theme.colors.bgActivity,
							borderColor: theme.colors.border,
						}}
					>
						<span
							className="text-xs font-bold tabular-nums w-4 text-center"
							style={{ color: theme.colors.accent }}
							aria-hidden="true"
						>
							{index + 1}
						</span>
						<span className="flex-1 text-sm truncate" style={{ color: theme.colors.textMain }}>
							{labelById.get(id) ?? id}
						</span>
						<div className="flex items-center gap-1">
							<button
								type="button"
								onClick={() => move(index, -1)}
								disabled={disabled || index === 0}
								className="focus-ring p-1 rounded transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
								style={{ color: theme.colors.textDim }}
								aria-label={`Move ${labelById.get(id) ?? id} up`}
							>
								<ChevronUp className="w-3.5 h-3.5" />
							</button>
							<button
								type="button"
								onClick={() => move(index, 1)}
								disabled={disabled || index === orderedIds.length - 1}
								className="focus-ring p-1 rounded transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
								style={{ color: theme.colors.textDim }}
								aria-label={`Move ${labelById.get(id) ?? id} down`}
							>
								<ChevronDown className="w-3.5 h-3.5" />
							</button>
						</div>
					</li>
				))}
			</ol>
		</div>
	);
});

export default RankedChoice;
