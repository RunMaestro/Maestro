/**
 * ProgressBar - a determinate horizontal progress track.
 *
 * For work whose completion is genuinely known: a byte count against a total,
 * a step count against a plan. If the total is unknown, use `<Spinner>` and
 * say what is happening in words - a bar that crawls to 90% and waits is worse
 * than a spinner, because it makes a promise about time that nothing behind it
 * can keep.
 *
 * The bar reports for assistive tech as a `progressbar` with real
 * `aria-valuenow` / `valuemin` / `valuemax`, so the percentage is available to
 * a screen reader without it having to read the label text.
 */

import type { Theme } from '../../types';

interface ProgressBarProps {
	/** Completed units. Clamped into `[0, total]`. */
	value: number;
	/** Total units. A total of 0 or less renders an empty track, not a crash. */
	total: number;
	theme: Theme;
	/** Accessible name, e.g. "Copying events.parquet from remote". */
	label: string;
	/** Track height in pixels. */
	height?: number;
	testId?: string;
}

export function ProgressBar({ value, total, theme, label, height = 6, testId }: ProgressBarProps) {
	// Guard the division rather than the render: a zero total is a legitimate
	// state (a file whose size could not be read yet), and it should show an
	// empty track instead of NaN% or a thrown error.
	const fraction = total > 0 ? Math.min(1, Math.max(0, value / total)) : 0;
	const percent = Math.round(fraction * 100);

	return (
		<div
			role="progressbar"
			aria-label={label}
			aria-valuenow={percent}
			aria-valuemin={0}
			aria-valuemax={100}
			className="w-full rounded overflow-hidden"
			style={{ height, backgroundColor: theme.colors.border }}
			data-testid={testId}
		>
			<div
				className="h-full rounded transition-[width] duration-200 ease-out"
				style={{ width: `${percent}%`, backgroundColor: theme.colors.accent }}
			/>
		</div>
	);
}
