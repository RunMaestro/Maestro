import type { CSSProperties } from 'react';
import { Minus, Plus } from 'lucide-react';
import type { Theme } from '../../types';
import { SURFACE_FONT_SIZE_MAX, SURFACE_FONT_SIZE_MIN } from '../../../shared/typography';

export interface FontSizeStepperProps {
	theme: Theme;
	/** Current stored size in px. `0` means "inherit the interface size". */
	value: number;
	onChange: (value: number) => void;
	/**
	 * The size actually rendered when `value` is 0, shown so the row reads the
	 * size the surface is really drawn at rather than a bare zero the user has
	 * to decode.
	 */
	inheritedSize: number;
	/** Whether 0 is a legal value. False for the interface surface, the base. */
	allowInherit?: boolean;
	testId?: string;
	label?: string;
}

/**
 * A per-surface font size control: minus / value / plus, plus a Reset that
 * returns the surface to inheriting the interface size.
 *
 * Deliberately a stepper rather than the Small/Medium/Large/X-Large toggle the
 * single global size used. Four presets are enough when one number drives the
 * whole app, but five surfaces tuned against each other need single-pixel
 * resolution - the difference between a 13px and a 14px terminal beside a 15px
 * chat is the entire point of per-surface sizes.
 *
 * Values here are pre-zoom. The Cmd+= multiplier is applied downstream, so what
 * the user sets stays what they set no matter how far they have zoomed.
 *
 * The geometry is FIXED on purpose. Six of these sit two-across in the Fonts
 * grid, so every part that can change - the number, the inherit affordance -
 * gets a reserved slot of its own rather than sizing to its content. Otherwise
 * the plus button lands at a different x in each cell and moves under the
 * cursor as the value changes, and the two cells of the first row (interface,
 * which cannot inherit, beside terminal, which can) never line up at all.
 */
export function FontSizeStepper({
	theme,
	value,
	onChange,
	inheritedSize,
	allowInherit = true,
	testId,
	label = 'Size',
}: FontSizeStepperProps) {
	const inheriting = allowInherit && value === 0;
	const effective = inheriting ? inheritedSize : value;

	const step = (delta: number) => {
		// Stepping away from "inherit" starts at the size the user can currently
		// see, so the first click nudges by one pixel rather than jumping to
		// some unrelated default.
		const next = effective + delta;
		if (next < SURFACE_FONT_SIZE_MIN || next > SURFACE_FONT_SIZE_MAX) return;
		onChange(next);
	};

	// The hover wash is the theme's own activity color, published as a local
	// custom property. `hover:bg-white/5` is invisible on a light theme, which
	// leaves the buttons reading as dead on half the palettes we ship.
	const buttonStyle = {
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
		'--stepper-hover-bg': theme.colors.bgActivity,
	} as CSSProperties;

	// Matches ScaleControl, the app's other stepper: 28px square, focus-ring,
	// and a title so the icon-only buttons name themselves on hover.
	const buttonClass =
		'focus-ring w-7 h-7 shrink-0 flex items-center justify-center rounded border ' +
		'hover:bg-[var(--stepper-hover-bg)] transition-colors disabled:opacity-30';

	return (
		<div className="flex items-center gap-2">
			<span className="text-xs opacity-60 shrink-0">{label}</span>
			<button
				type="button"
				onClick={() => step(-1)}
				disabled={effective <= SURFACE_FONT_SIZE_MIN}
				aria-label="Decrease font size"
				title="Decrease font size"
				data-testid={testId ? `${testId}-decrease` : undefined}
				className={buttonClass}
				style={buttonStyle}
			>
				<Minus className="w-4 h-4" />
			</button>
			<span
				className="text-xs tabular-nums text-center min-w-[3rem] shrink-0"
				data-testid={testId ? `${testId}-value` : undefined}
				title={inheriting ? `Inheriting the interface size (${effective}px)` : `${effective}px`}
				style={{ color: inheriting ? theme.colors.textDim : theme.colors.textMain }}
			>
				{effective}px
			</span>
			<button
				type="button"
				onClick={() => step(1)}
				disabled={effective >= SURFACE_FONT_SIZE_MAX}
				aria-label="Increase font size"
				title="Increase font size"
				data-testid={testId ? `${testId}-increase` : undefined}
				className={buttonClass}
				style={buttonStyle}
			>
				<Plus className="w-4 h-4" />
			</button>
			{/*
			 * The inherit slot is always reserved, even for the interface surface
			 * that has nothing to inherit from, so the row is the same width in
			 * every cell of the grid. What it holds is the only thing that
			 * changes: the escape back to inheriting, the word for the state it
			 * is already in, or nothing at all.
			 */}
			<span className="w-16 shrink-0 flex items-center justify-center">
				{allowInherit &&
					(inheriting ? (
						<span
							className="text-xs"
							data-testid={testId ? `${testId}-inheriting` : undefined}
							style={{ color: theme.colors.textDim }}
						>
							Inherited
						</span>
					) : (
						<button
							type="button"
							onClick={() => onChange(0)}
							title="Inherit the interface font size"
							data-testid={testId ? `${testId}-inherit` : undefined}
							className="focus-ring text-xs underline underline-offset-2 rounded hover:opacity-80 transition-opacity"
							style={{ color: theme.colors.textDim }}
						>
							Inherit
						</button>
					))}
			</span>
		</div>
	);
}
