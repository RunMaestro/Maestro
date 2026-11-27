import { memo } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import type { Theme } from '../../../types';
import type { CueTriggerTypeOption } from '../../../../shared/cue-stats-types';
import { formatNumber } from '../../../../shared/formatters';

/**
 * Chip row at the top of the Cue tab: one toggle per trigger type present in
 * the window. Excluding a trigger re-runs the aggregation without it, which
 * rescales EVERY panel below - the reason this exists is that a heartbeat
 * firing on a timer is 97% of all runs and flattens every other bar.
 */
export const TriggerTypeFilter = memo(function TriggerTypeFilter({
	options,
	excluded,
	onToggle,
	onReset,
	theme,
}: {
	options: CueTriggerTypeOption[];
	excluded: Set<string>;
	onToggle: (key: string) => void;
	onReset: () => void;
	theme: Theme;
}) {
	const hiddenCount = options.filter((o) => excluded.has(o.key)).length;

	return (
		<div
			className="p-3 rounded-lg select-none"
			style={{ backgroundColor: theme.colors.bgMain }}
			data-testid="cue-stats-trigger-filter"
			role="group"
			aria-label="Filter Cue stats by trigger type"
		>
			<div className="flex items-center justify-center gap-2 flex-wrap">
				{options.map((option) => {
					const isExcluded = excluded.has(option.key);
					return (
						<button
							key={option.key}
							type="button"
							onClick={() => onToggle(option.key)}
							aria-pressed={!isExcluded}
							title={
								isExcluded
									? `Include ${option.label} in every panel below`
									: `Hide ${option.label} from every panel below`
							}
							className="flex items-center gap-1.5 px-2 py-1 rounded text-xs transition-colors"
							data-testid={`cue-stats-trigger-chip-${option.key}`}
							data-excluded={isExcluded ? 'true' : 'false'}
							style={{
								border: `1px solid ${isExcluded ? theme.colors.border : theme.colors.accent}`,
								backgroundColor: isExcluded ? 'transparent' : `${theme.colors.accent}22`,
								color: isExcluded ? theme.colors.textDim : theme.colors.textMain,
								opacity: isExcluded ? 0.55 : 1,
							}}
						>
							{isExcluded ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
							<span style={{ textDecoration: isExcluded ? 'line-through' : 'none' }}>
								{option.label}
							</span>
							<span className="font-mono" style={{ color: theme.colors.textDim }}>
								{formatNumber(option.occurrences)}
							</span>
						</button>
					);
				})}
				{hiddenCount > 0 && (
					<button
						type="button"
						onClick={onReset}
						className="px-2 py-1 rounded text-xs"
						data-testid="cue-stats-trigger-filter-reset"
						style={{ color: theme.colors.accent }}
					>
						Show all ({hiddenCount} hidden)
					</button>
				)}
			</div>
		</div>
	);
});
