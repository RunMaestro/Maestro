/**
 * AnnotatorSettingsDrawer — Slide-in right-side panel with brush configuration.
 *
 * Bound directly to the persisted settings via `useSettingsStore` selectors so
 * `AnnotatorCanvas` re-renders strokes live as sliders move (the canvas reads
 * the same selectors). Mirror values from `src/main/stores/defaults.ts` —
 * keep ANNOTATOR_DEFAULTS in sync there.
 */

import { Brush, Palette, RotateCcw, SlidersHorizontal } from 'lucide-react';
import type { Theme } from '../../../shared/theme-types';
import { useSettingsStore } from '../../stores/settingsStore';
import { SettingsSectionHeading } from '../Settings/SettingsSectionHeading';

interface AnnotatorSettingsDrawerProps {
	open: boolean;
	onClose: () => void;
	theme: Theme;
}

const SWATCHES: readonly string[] = [
	'#ec4899',
	'#ef4444',
	'#f59e0b',
	'#10b981',
	'#3b82f6',
	'#a855f7',
	'#000000',
	'#ffffff',
];

// Mirror of `src/main/stores/defaults.ts`. Keep these in lock-step.
const ANNOTATOR_DEFAULTS = {
	annotatorPenColor: '#9146FF',
	annotatorPenSize: 10,
	annotatorThinning: 0.5,
	annotatorSmoothing: 0.5,
	annotatorStreamline: 0.5,
	annotatorTaperStart: 0,
	annotatorTaperEnd: 0,
} as const;

export function AnnotatorSettingsDrawer({ open, onClose, theme }: AnnotatorSettingsDrawerProps) {
	const penColor = useSettingsStore((s) => s.annotatorPenColor);
	const penSize = useSettingsStore((s) => s.annotatorPenSize);
	const thinning = useSettingsStore((s) => s.annotatorThinning);
	const smoothing = useSettingsStore((s) => s.annotatorSmoothing);
	const streamline = useSettingsStore((s) => s.annotatorStreamline);
	const taperStart = useSettingsStore((s) => s.annotatorTaperStart);
	const taperEnd = useSettingsStore((s) => s.annotatorTaperEnd);

	const setPenColor = useSettingsStore((s) => s.setAnnotatorPenColor);
	const setPenSize = useSettingsStore((s) => s.setAnnotatorPenSize);
	const setThinning = useSettingsStore((s) => s.setAnnotatorThinning);
	const setSmoothing = useSettingsStore((s) => s.setAnnotatorSmoothing);
	const setStreamline = useSettingsStore((s) => s.setAnnotatorStreamline);
	const setTaperStart = useSettingsStore((s) => s.setAnnotatorTaperStart);
	const setTaperEnd = useSettingsStore((s) => s.setAnnotatorTaperEnd);

	const handleResetDefaults = () => {
		setPenColor(ANNOTATOR_DEFAULTS.annotatorPenColor);
		setPenSize(ANNOTATOR_DEFAULTS.annotatorPenSize);
		setThinning(ANNOTATOR_DEFAULTS.annotatorThinning);
		setSmoothing(ANNOTATOR_DEFAULTS.annotatorSmoothing);
		setStreamline(ANNOTATOR_DEFAULTS.annotatorStreamline);
		setTaperStart(ANNOTATOR_DEFAULTS.annotatorTaperStart);
		setTaperEnd(ANNOTATOR_DEFAULTS.annotatorTaperEnd);
	};

	const sliderBackground = (value: number, min: number, max: number) => {
		const pct = ((value - min) / (max - min)) * 100;
		return `linear-gradient(to right, ${theme.colors.accent} 0%, ${theme.colors.accent} ${pct}%, ${theme.colors.bgActivity} ${pct}%, ${theme.colors.bgActivity} 100%)`;
	};

	return (
		<aside
			aria-label="Drawing settings"
			aria-hidden={!open}
			// `inert` removes the closed drawer's swatches/sliders from the tab
			// order; `aria-hidden` alone doesn't prevent keyboard focus.
			{...(!open && { inert: '' as unknown as boolean })}
			className="absolute top-0 right-0 bottom-0 z-20 flex flex-col overflow-y-auto border-l"
			style={
				{
					width: 320,
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
					transform: open ? 'translateX(0)' : 'translateX(100%)',
					transition: 'transform 200ms',
					pointerEvents: open ? 'auto' : 'none',
					// The top 40px of the window is the Electron drag region
					// (`-webkit-app-region: drag`). Without explicit no-drag,
					// the OS hijacks clicks on the drawer header — including
					// the Close button. Opt out for the whole drawer.
					WebkitAppRegion: 'no-drag',
				} as React.CSSProperties
			}
			onPointerDown={(e) => e.stopPropagation()}
			onWheel={(e) => e.stopPropagation()}
		>
			<div
				className="flex items-center justify-between p-4 border-b"
				style={{ borderColor: theme.colors.border }}
			>
				<div className="text-sm font-bold">Drawing settings</div>
				<button
					type="button"
					onClick={onClose}
					className="text-xs px-2 py-1 rounded hover:bg-white/10 transition-colors"
					style={{ color: theme.colors.textDim }}
				>
					Close
				</button>
			</div>

			<div className="flex-1 p-4 space-y-6">
				<section>
					<SettingsSectionHeading icon={Palette}>Color</SettingsSectionHeading>
					<div className="grid grid-cols-8 gap-2 mb-3">
						{SWATCHES.map((color) => {
							const active = color.toLowerCase() === penColor.toLowerCase();
							return (
								<button
									key={color}
									type="button"
									onClick={() => setPenColor(color)}
									aria-label={`Use color ${color}`}
									aria-pressed={active}
									className="w-7 h-7 rounded-full transition-transform hover:scale-110"
									style={{
										backgroundColor: color,
										boxShadow: active
											? `0 0 0 2px ${theme.colors.bgSidebar}, 0 0 0 4px ${theme.colors.accent}`
											: `0 0 0 1px ${theme.colors.border}`,
									}}
								/>
							);
						})}
					</div>
					<label className="flex items-center gap-2 text-xs">
						<span style={{ color: theme.colors.textDim }}>Custom</span>
						<input
							type="color"
							value={penColor}
							onChange={(e) => setPenColor(e.target.value)}
							className="w-8 h-8 rounded cursor-pointer bg-transparent border-0 p-0"
							aria-label="Custom pen color"
						/>
						<span className="font-mono" style={{ color: theme.colors.textMain }}>
							{penColor}
						</span>
					</label>
				</section>

				<section>
					<SettingsSectionHeading icon={Brush}>Size</SettingsSectionHeading>
					<div className="flex items-center gap-3">
						<input
							type="range"
							min={1}
							max={64}
							step={1}
							value={penSize}
							onChange={(e) => setPenSize(Number(e.target.value))}
							className="flex-1 h-2 rounded-lg appearance-none cursor-pointer"
							style={{ background: sliderBackground(penSize, 1, 64) }}
							aria-label="Pen size"
						/>
						<span
							className="text-sm font-mono w-10 text-right"
							style={{ color: theme.colors.textMain }}
						>
							{penSize}
						</span>
					</div>
				</section>

				<section className="space-y-4">
					<SettingsSectionHeading icon={SlidersHorizontal}>Stroke shape</SettingsSectionHeading>
					<UnitSlider
						label="Thinning"
						value={thinning}
						onChange={setThinning}
						theme={theme}
						sliderBackground={sliderBackground}
					/>
					<UnitSlider
						label="Smoothing"
						value={smoothing}
						onChange={setSmoothing}
						theme={theme}
						sliderBackground={sliderBackground}
					/>
					<UnitSlider
						label="Streamline"
						value={streamline}
						onChange={setStreamline}
						theme={theme}
						sliderBackground={sliderBackground}
					/>
					<UnitSlider
						label="Taper Start"
						value={taperStart}
						onChange={setTaperStart}
						theme={theme}
						sliderBackground={sliderBackground}
					/>
					<UnitSlider
						label="Taper End"
						value={taperEnd}
						onChange={setTaperEnd}
						theme={theme}
						sliderBackground={sliderBackground}
					/>
				</section>
			</div>

			<div className="p-4 border-t" style={{ borderColor: theme.colors.border }}>
				<button
					type="button"
					onClick={handleResetDefaults}
					className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded text-sm transition-colors hover:bg-white/10"
					style={{
						color: theme.colors.textMain,
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					<RotateCcw className="w-3.5 h-3.5" />
					Reset to defaults
				</button>
			</div>
		</aside>
	);
}

interface UnitSliderProps {
	label: string;
	value: number;
	onChange: (value: number) => void;
	theme: Theme;
	sliderBackground: (value: number, min: number, max: number) => string;
}

function UnitSlider({ label, value, onChange, theme, sliderBackground }: UnitSliderProps) {
	return (
		<div>
			<div className="flex items-center justify-between mb-1.5">
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					{label}
				</span>
				<span className="text-xs font-mono" style={{ color: theme.colors.textMain }}>
					{value.toFixed(2)}
				</span>
			</div>
			<input
				type="range"
				min={0}
				max={1}
				step={0.05}
				value={value}
				onChange={(e) => onChange(Number(e.target.value))}
				className="w-full h-2 rounded-lg appearance-none cursor-pointer"
				style={{ background: sliderBackground(value, 0, 1) }}
				aria-label={label}
			/>
		</div>
	);
}

export default AnnotatorSettingsDrawer;
