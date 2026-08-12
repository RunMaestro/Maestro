/**
 * AnnotatorSettingsDrawer - Slide-in right-side panel with brush configuration.
 *
 * Bound directly to the persisted settings via `useSettingsStore` selectors so
 * `AnnotatorCanvas` re-renders strokes live as sliders move (the canvas reads
 * the same selectors). Mirror values from `src/main/stores/defaults.ts` -
 * keep ANNOTATOR_DEFAULTS in sync there.
 */

import { ArrowDownUp, Ban, Brush, Palette, RotateCcw, SlidersHorizontal, Type } from 'lucide-react';
import type { Theme } from '../../../shared/theme-types';
import { useSettingsStore } from '../../stores/settingsStore';
import { SettingsSectionHeading } from '../Settings/SettingsSectionHeading';
import { ANNOTATOR_PALETTE } from './annotatorConstants';
import type {
	Shape,
	ShapeStyle,
	TextBox,
	TextStyle,
	UseAnnotatorStateReturn,
} from './useAnnotatorState';

interface AnnotatorSettingsDrawerProps {
	open: boolean;
	onClose: () => void;
	theme: Theme;
	state: UseAnnotatorStateReturn;
}

// Mirror of `src/main/stores/defaults.ts`. Keep these in lock-step.
const ANNOTATOR_DEFAULTS = {
	annotatorPenColor: '#9146FF',
	annotatorPenSize: 10,
	annotatorThinning: 0.5,
	annotatorSmoothing: 0.5,
	annotatorStreamline: 0.5,
	annotatorTaperStart: 0,
	annotatorTaperEnd: 0,
	annotatorTextColor: '#9146FF',
	annotatorTextSize: 24,
	annotatorTextFont: 'sans-serif',
	annotatorTextBgColor: '',
} as const;

// Cross-platform default stack: each option is a CSS font-family string. The
// first family in each stack is the friendly label; subsequent entries give
// the renderer fallback choices when the named face isn't installed.
const TEXT_FONT_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
	{ label: 'Sans-serif', value: 'sans-serif' },
	{ label: 'Serif', value: 'serif' },
	{ label: 'Monospace', value: 'monospace' },
	{ label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
	{ label: 'Georgia', value: 'Georgia, "Times New Roman", serif' },
	{ label: 'Courier', value: '"Courier New", Courier, monospace' },
	{ label: 'Comic Sans', value: '"Comic Sans MS", "Comic Sans", cursive' },
];

export function AnnotatorSettingsDrawer({
	open,
	onClose,
	theme,
	state,
}: AnnotatorSettingsDrawerProps) {
	const defPenColor = useSettingsStore((s) => s.annotatorPenColor);
	const defPenSize = useSettingsStore((s) => s.annotatorPenSize);
	const thinning = useSettingsStore((s) => s.annotatorThinning);
	const smoothing = useSettingsStore((s) => s.annotatorSmoothing);
	const streamline = useSettingsStore((s) => s.annotatorStreamline);
	const taperStart = useSettingsStore((s) => s.annotatorTaperStart);
	const taperEnd = useSettingsStore((s) => s.annotatorTaperEnd);
	const defTextColor = useSettingsStore((s) => s.annotatorTextColor);
	const defTextSize = useSettingsStore((s) => s.annotatorTextSize);
	const defTextFont = useSettingsStore((s) => s.annotatorTextFont);
	const defTextBgColor = useSettingsStore((s) => s.annotatorTextBgColor);

	const setDefPenColor = useSettingsStore((s) => s.setAnnotatorPenColor);
	const setDefPenSize = useSettingsStore((s) => s.setAnnotatorPenSize);
	const setThinning = useSettingsStore((s) => s.setAnnotatorThinning);
	const setSmoothing = useSettingsStore((s) => s.setAnnotatorSmoothing);
	const setStreamline = useSettingsStore((s) => s.setAnnotatorStreamline);
	const setTaperStart = useSettingsStore((s) => s.setAnnotatorTaperStart);
	const setTaperEnd = useSettingsStore((s) => s.setAnnotatorTaperEnd);
	const setDefTextColor = useSettingsStore((s) => s.setAnnotatorTextColor);
	const setDefTextSize = useSettingsStore((s) => s.setAnnotatorTextSize);
	const setDefTextFont = useSettingsStore((s) => s.setAnnotatorTextFont);
	const setDefTextBgColor = useSettingsStore((s) => s.setAnnotatorTextBgColor);

	// Selection-aware proxies: when a shape or text is selected, the relevant
	// controls read from + write to that item's style instead of the global
	// defaults. Drawing a new item still picks up whatever the defaults are at
	// commit time, so editing a selection doesn't accidentally rewrite the
	// user's preferred next-stroke / next-text appearance.
	const selectedShape: Shape | null = state.selectedShapeId
		? (state.shapes.find((s) => s.id === state.selectedShapeId) ?? null)
		: null;
	const selectedText: TextBox | null = state.selectedTextId
		? (state.texts.find((t) => t.id === state.selectedTextId) ?? null)
		: null;

	const updateSelectedShapeStyle = (partial: Partial<ShapeStyle>) => {
		if (!selectedShape) return;
		state.updateShape(selectedShape.id, { style: { ...selectedShape.style, ...partial } });
	};
	const updateSelectedTextStyle = (partial: Partial<TextStyle>) => {
		if (!selectedText) return;
		state.updateText(selectedText.id, { style: { ...selectedText.style, ...partial } });
	};

	// Pen color/size row routes to the selected shape if one is active. Text
	// has its own section below, so it doesn't intercept the pen row.
	const penColor = selectedShape ? selectedShape.style.color : defPenColor;
	const penSize = selectedShape ? selectedShape.style.size : defPenSize;
	const setPenColor = (c: string) => {
		if (selectedShape) updateSelectedShapeStyle({ color: c });
		else setDefPenColor(c);
	};
	const setPenSize = (n: number) => {
		if (selectedShape) updateSelectedShapeStyle({ size: n });
		else setDefPenSize(n);
	};

	// Text section reads from the selected text (if any) or the defaults.
	const textColor = selectedText ? selectedText.style.color : defTextColor;
	const textSize = selectedText ? selectedText.style.size : defTextSize;
	const textFont = selectedText ? selectedText.style.font : defTextFont;
	const textBgColor = selectedText ? (selectedText.style.bgColor ?? '') : defTextBgColor;
	const setTextColor = (c: string) => {
		if (selectedText) updateSelectedTextStyle({ color: c });
		else setDefTextColor(c);
	};
	const setTextSize = (n: number) => {
		if (selectedText) updateSelectedTextStyle({ size: n });
		else setDefTextSize(n);
	};
	const setTextFont = (f: string) => {
		if (selectedText) updateSelectedTextStyle({ font: f });
		else setDefTextFont(f);
	};
	const setTextBgColor = (c: string) => {
		if (selectedText) updateSelectedTextStyle({ bgColor: c === '' ? null : c });
		else setDefTextBgColor(c);
	};
	const swapTextColors = () => {
		const fg = textColor;
		const bg = textBgColor;
		// Swapping with an empty bg would discard the foreground, so fall back
		// to white as a sane default when the user "swaps in" a missing bg.
		const nextFg = bg === '' ? '#ffffff' : bg;
		const nextBg = fg;
		// Apply both changes in a single mutation. Two sequential setters would
		// each spread from `selectedText.style` (the closure-captured value at
		// render time), so the second call would clobber the first's update.
		if (selectedText) {
			state.updateText(selectedText.id, {
				style: {
					...selectedText.style,
					color: nextFg,
					bgColor: nextBg === '' ? null : nextBg,
				},
			});
		} else {
			setDefTextColor(nextFg);
			setDefTextBgColor(nextBg);
		}
	};

	const penEditingSelection = !!selectedShape;
	const textEditingSelection = !!selectedText;

	const handleResetDefaults = () => {
		// Reset always operates on the global defaults - never the live selection.
		setDefPenColor(ANNOTATOR_DEFAULTS.annotatorPenColor);
		setDefPenSize(ANNOTATOR_DEFAULTS.annotatorPenSize);
		setThinning(ANNOTATOR_DEFAULTS.annotatorThinning);
		setSmoothing(ANNOTATOR_DEFAULTS.annotatorSmoothing);
		setStreamline(ANNOTATOR_DEFAULTS.annotatorStreamline);
		setTaperStart(ANNOTATOR_DEFAULTS.annotatorTaperStart);
		setTaperEnd(ANNOTATOR_DEFAULTS.annotatorTaperEnd);
		setDefTextColor(ANNOTATOR_DEFAULTS.annotatorTextColor);
		setDefTextSize(ANNOTATOR_DEFAULTS.annotatorTextSize);
		setDefTextFont(ANNOTATOR_DEFAULTS.annotatorTextFont);
		setDefTextBgColor(ANNOTATOR_DEFAULTS.annotatorTextBgColor);
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
					// 360px fits a 9-column swatch grid (8 colors + the "None"
					// tile in the background palette) without wrap. Bumping this
					// width also requires the matching `DRAWER_WIDTH` in
					// `AnnotatorToolbar.tsx` so the toolbar slides clear of the
					// drawer's new edge.
					width: 360,
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
					transform: open ? 'translateX(0)' : 'translateX(100%)',
					transition: 'transform 200ms',
					pointerEvents: open ? 'auto' : 'none',
					// The top 40px of the window is the Electron drag region
					// (`-webkit-app-region: drag`). Without explicit no-drag,
					// the OS hijacks clicks on the drawer header - including
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
					<div className="flex items-center justify-between mb-2">
						<SettingsSectionHeading icon={Palette}>Color</SettingsSectionHeading>
						{penEditingSelection && <SelectionBadge theme={theme} label="Editing selection" />}
					</div>
					<ColorPalette
						value={penColor}
						onChange={setPenColor}
						theme={theme}
						ariaLabelPrefix="Use color"
						customInputAriaLabel="Custom pen color"
					/>
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

				<section className="space-y-4">
					<div className="flex items-center justify-between">
						<SettingsSectionHeading icon={Type}>Text</SettingsSectionHeading>
						{textEditingSelection && <SelectionBadge theme={theme} label="Editing selection" />}
					</div>
					<div>
						<div className="text-xs mb-1.5" style={{ color: theme.colors.textDim }}>
							Foreground
						</div>
						<ColorPalette
							value={textColor}
							onChange={setTextColor}
							theme={theme}
							ariaLabelPrefix="Use foreground color"
							customInputAriaLabel="Custom foreground color"
						/>
					</div>

					<div>
						<div className="flex items-center justify-between mb-1.5">
							<div className="text-xs" style={{ color: theme.colors.textDim }}>
								Background
							</div>
							<button
								type="button"
								onClick={swapTextColors}
								aria-label="Swap foreground and background"
								title="Swap foreground and background"
								className="text-xs flex items-center gap-1 px-2 py-1 rounded hover:bg-white/10 transition-colors"
								style={{
									color: theme.colors.textDim,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								<ArrowDownUp className="w-3 h-3" />
								Swap
							</button>
						</div>
						<ColorPalette
							value={textBgColor}
							onChange={setTextBgColor}
							theme={theme}
							ariaLabelPrefix="Use background color"
							customInputAriaLabel="Custom background color"
							includeNone
						/>
					</div>

					<div>
						<div className="flex items-center justify-between mb-1.5">
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								Size
							</span>
							<span className="text-xs font-mono" style={{ color: theme.colors.textMain }}>
								{textSize}
							</span>
						</div>
						<input
							type="range"
							min={10}
							max={120}
							step={1}
							value={textSize}
							onChange={(e) => setTextSize(Number(e.target.value))}
							className="w-full h-2 rounded-lg appearance-none cursor-pointer"
							style={{ background: sliderBackground(textSize, 10, 120) }}
							aria-label="Text size"
						/>
					</div>

					<div>
						<div className="flex items-center justify-between mb-1.5">
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								Font
							</span>
						</div>
						<select
							value={textFont}
							onChange={(e) => setTextFont(e.target.value)}
							aria-label="Text font"
							className="w-full text-sm rounded px-2 py-1.5"
							style={{
								backgroundColor: theme.colors.bgMain,
								color: theme.colors.textMain,
								border: `1px solid ${theme.colors.border}`,
								fontFamily: textFont,
							}}
						>
							{TEXT_FONT_OPTIONS.map((opt) => (
								<option key={opt.value} value={opt.value} style={{ fontFamily: opt.value }}>
									{opt.label}
								</option>
							))}
						</select>
					</div>
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

interface ColorPaletteProps {
	value: string;
	onChange: (next: string) => void;
	theme: Theme;
	ariaLabelPrefix: string;
	customInputAriaLabel: string;
	/** When true, prepends a "None" tile that clears the value (sends ''). */
	includeNone?: boolean;
}

/**
 * Swatch grid + native color picker + hex readout. Used three times in the
 * drawer (pen color, text foreground, text background) - extracted so the
 * "None" variant for backgrounds stays a single-prop change rather than a
 * forked copy.
 */
function ColorPalette({
	value,
	onChange,
	theme,
	ariaLabelPrefix,
	customInputAriaLabel,
	includeNone = false,
}: ColorPaletteProps) {
	const isNone = value === '';
	return (
		<>
			<div className="grid grid-cols-9 gap-2 mb-3">
				{includeNone && (
					<button
						type="button"
						onClick={() => onChange('')}
						aria-label="No color"
						aria-pressed={isNone}
						title="None"
						className="w-7 h-7 rounded-full transition-transform hover:scale-110 flex items-center justify-center"
						style={{
							backgroundColor: 'transparent',
							boxShadow: isNone
								? `0 0 0 2px ${theme.colors.bgSidebar}, 0 0 0 4px ${theme.colors.accent}`
								: `0 0 0 1px ${theme.colors.border}`,
						}}
					>
						<Ban className="w-4 h-4" style={{ color: theme.colors.textDim }} />
					</button>
				)}
				{ANNOTATOR_PALETTE.map((color) => {
					const active = !isNone && color.toLowerCase() === value.toLowerCase();
					return (
						<button
							key={color}
							type="button"
							onClick={() => onChange(color)}
							aria-label={`${ariaLabelPrefix} ${color}`}
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
					// Native color inputs don't accept empty string - fall back to a
					// neutral placeholder when the value is "None" so the swatch
					// preview stays readable.
					value={isNone ? '#000000' : value}
					onChange={(e) => onChange(e.target.value)}
					className="w-8 h-8 rounded cursor-pointer bg-transparent border-0 p-0"
					aria-label={customInputAriaLabel}
				/>
				<span className="font-mono" style={{ color: theme.colors.textMain }}>
					{isNone ? 'None' : value}
				</span>
			</label>
		</>
	);
}

function SelectionBadge({ theme, label }: { theme: Theme; label: string }) {
	return (
		<span
			className="text-[10px] uppercase tracking-wide px-2 py-0.5 rounded"
			style={{
				color: theme.colors.accent,
				backgroundColor: `${theme.colors.accent}1f`,
				border: `1px solid ${theme.colors.accent}40`,
			}}
		>
			{label}
		</span>
	);
}

export default AnnotatorSettingsDrawer;
