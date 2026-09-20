import { memo } from 'react';
import { Wand2 } from 'lucide-react';

interface BusyWandProps {
	/** True when any agent is working. Drives the breathe and the glints. */
	busy: boolean;
	/** True while a performance trace is being captured. Takes visual priority. */
	profiling: boolean;
	/** Tailwind size classes for the icon, e.g. `w-5 h-5`. */
	sizeClass: string;
	/** Theme accent. Set on the WRAPPER so the glints inherit it too. */
	color: string;
}

/**
 * The Left Bar header wand, with its busy animation.
 *
 * Exists so the expanded and collapsed headers cannot drift apart. They render
 * the same indicator at two sizes, and the animation underneath it has been
 * rebuilt three times - keeping two hand-rolled copies of the glint markup in
 * sync across a fourth revision is a bug waiting to happen.
 *
 * Deliberately NOT used by `WizardIndicator`: that wand is 12px and renders
 * once per agent row, where glints would be both invisible and multiplied by
 * the agent count. It keeps the bare `wand-sparkle-active` breathe.
 *
 * The color lives on the wrapper rather than the `<svg>` because the glints are
 * `currentColor` and are siblings of the icon, not children of it.
 *
 * See the comment above `.wand-glints` in index.css for why the twinkle is
 * built from overlay elements instead of animating the icon's own `<path>`
 * children.
 */
export const BusyWand = memo(function BusyWand({
	busy,
	profiling,
	sizeClass,
	color,
}: BusyWandProps) {
	// Profiling suppresses the glints rather than layering them over the red
	// pulse. Both at once reads as two competing signals, and when profiling is
	// on it is the one that matters - it is also the only state the user did not
	// ask for and might want to turn off.
	const showGlints = busy && !profiling;

	return (
		<span className="wand-glints" style={{ color }}>
			<Wand2
				className={`${sizeClass}${busy ? ' wand-sparkle-active' : ''}${
					profiling ? ' wand-profiling-active' : ''
				}`}
			/>
			{showGlints && (
				<>
					{/* aria-hidden: decoration. The button that owns this already has an
					    accessible name, and a screen reader announcing three unnamed
					    spans would be noise. */}
					<span className="wand-glint wand-glint-1" aria-hidden="true" />
					<span className="wand-glint wand-glint-2" aria-hidden="true" />
					<span className="wand-glint wand-glint-3" aria-hidden="true" />
				</>
			)}
		</span>
	);
});
