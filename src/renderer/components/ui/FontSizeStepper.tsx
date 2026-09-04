import { Minus, Plus } from 'lucide-react';
import type { Theme } from '../../types';
import { SURFACE_FONT_SIZE_MAX, SURFACE_FONT_SIZE_MIN } from '../../../shared/typography';

export interface FontSizeStepperProps {
	theme: Theme;
	/** Current stored size in px. `0` means "inherit the interface size". */
	value: number;
	onChange: (value: number) => void;
	/**
	 * The size actually rendered when `value` is 0, shown so the row reads
	 * "Inherit (15px)" rather than a bare zero the user has to decode.
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

	const buttonStyle = {
		borderColor: theme.colors.border,
		color: theme.colors.textMain,
	};

	return (
		<div className="flex items-center gap-2">
			<span className="text-xs opacity-60 shrink-0">{label}</span>
			<button
				type="button"
				onClick={() => step(-1)}
				disabled={effective <= SURFACE_FONT_SIZE_MIN}
				aria-label="Decrease font size"
				data-testid={testId ? `${testId}-decrease` : undefined}
				className="w-6 h-6 flex items-center justify-center rounded border hover:bg-white/5 transition-colors disabled:opacity-30"
				style={buttonStyle}
			>
				<Minus className="w-3 h-3" />
			</button>
			<span
				className="text-xs tabular-nums text-center min-w-[5.5rem]"
				data-testid={testId ? `${testId}-value` : undefined}
				style={{ color: inheriting ? theme.colors.textDim : theme.colors.textMain }}
			>
				{inheriting ? `Inherit (${effective}px)` : `${effective}px`}
			</span>
			<button
				type="button"
				onClick={() => step(1)}
				disabled={effective >= SURFACE_FONT_SIZE_MAX}
				aria-label="Increase font size"
				data-testid={testId ? `${testId}-increase` : undefined}
				className="w-6 h-6 flex items-center justify-center rounded border hover:bg-white/5 transition-colors disabled:opacity-30"
				style={buttonStyle}
			>
				<Plus className="w-3 h-3" />
			</button>
			{allowInherit && !inheriting && (
				<button
					type="button"
					onClick={() => onChange(0)}
					data-testid={testId ? `${testId}-inherit` : undefined}
					className="text-xs underline underline-offset-2 hover:opacity-80 transition-opacity"
					style={{ color: theme.colors.textDim }}
				>
					Inherit
				</button>
			)}
		</div>
	);
}
