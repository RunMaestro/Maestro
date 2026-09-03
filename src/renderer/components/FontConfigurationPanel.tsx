import React, { useState, useMemo, useCallback } from 'react';
import { Type } from 'lucide-react';
import type { Theme } from '../types';
import { SettingsSectionHeading } from './Settings/SettingsSectionHeading';
import { BUNDLED_FONTS, BUNDLED_FONT_NAMES, isBundledFont } from '../../shared/bundledFonts';
import { displayFontLabel, withMonoFallback, FONT_PREVIEW_PROSE } from '../../shared/fontStack';

/**
 * Common monospace fonts that are typically available across different systems.
 * These are shown in the font dropdown for quick selection.
 */
const COMMON_MONOSPACE_FONTS = [
	'Roboto Mono',
	'JetBrains Mono',
	'Fira Code',
	'Monaco',
	'Menlo',
	'Consolas',
	'Courier New',
	'SF Mono',
	'Cascadia Code',
	'Source Code Pro',
];

/**
 * Proportional faces offered alongside the monospace list. Maestro was fixed
 * width on every surface before per-surface fonts existed, so prose surfaces
 * (AI chat, the file preview) had no way to reach a reading face at all.
 * Availability is annotated the same way as the monospace group, so a face this
 * platform lacks reads as "(Not Found)" rather than silently falling back.
 */
const COMMON_PROPORTIONAL_FONTS = [
	'Arial',
	'Helvetica',
	'Helvetica Neue',
	'Verdana',
	'Avenir Next',
	'Segoe UI',
	'Tahoma',
	'Trebuchet MS',
	'Georgia',
];

export interface FontConfigurationPanelProps {
	/** Currently selected font family */
	fontFamily: string;
	/** Callback when font family changes */
	setFontFamily: (font: string) => void;
	/** List of system fonts detected on the machine */
	systemFonts: string[];
	/** Whether fonts have been loaded from the system */
	fontsLoaded: boolean;
	/**
	 * Whether the loaded list actually reflects this machine. False when
	 * detection fell back to a hard-coded guess, in which case availability
	 * annotations are suppressed entirely: labelling an installed Arial
	 * "(Not Found)" reads as a broken feature, and the fallback list mentions
	 * seven faces out of hundreds.
	 */
	fontsReliable?: boolean;
	/** Whether fonts are currently loading */
	fontLoading: boolean;
	/** List of user-added custom fonts */
	customFonts: string[];
	/** Callback to add a new custom font */
	onAddCustomFont: (font: string) => void;
	/** Callback to remove a custom font */
	onRemoveCustomFont: (font: string) => void;
	/** Callback when user interacts with font selector (triggers lazy loading) */
	onFontInteraction: () => void;
	/** Current theme for styling */
	theme: Theme;
	/** Section heading. Defaults to "Interface Font". */
	heading?: string;
	/** Optional helper text rendered under the heading. */
	description?: string;
	/**
	 * Options rendered above the font groups, for the roots this surface may
	 * follow. A list rather than a single entry because a surface can follow
	 * either the interface or the terminal, and the picker has to offer both.
	 */
	inheritOptions?: ReadonlyArray<{ value: string; label: string }>;
	/** Per-surface size control rendered beside the picker. */
	sizeControl?: React.ReactNode;
	/**
	 * CSS font-family the live sample under the picker is drawn in.
	 *
	 * Pass the surface's RESOLVED value - a `var(--maestro-font-*)` reference is
	 * ideal, since those are the very properties the app paints with, so the
	 * sample cannot claim a face the surface is not actually using. Needed
	 * because the selected value alone is not always a face: a surface sitting on
	 * "Same as interface font" stores an inherit sentinel, and drawing the sample
	 * in that would render no family at all. Defaults to the selected value with
	 * the monospace fallback appended.
	 */
	previewFontFamily?: string;
	/**
	 * CSS font-size for the live sample, e.g. `var(--maestro-size-chat)`. Omitted
	 * means "inherit", which is right for a picker with no surface behind it.
	 */
	previewFontSize?: string;
	/**
	 * Drop the section heading and the custom-font manager, leaving just the
	 * dropdown and its size control.
	 *
	 * The custom-font list is global, so rendering its input once per surface
	 * showed five controls editing one list. In compact mode it is hoisted to a
	 * single row above the surfaces (see CustomFontsRow) and the pickers below
	 * become small enough to sit two across.
	 */
	compact?: boolean;
}

/**
 * FontConfigurationPanel - A component for configuring the interface font settings.
 *
 * Features:
 * - Dropdown with common monospace fonts
 * - Font availability indicators (shows if font is installed)
 * - Custom font input for adding user-specified fonts
 * - Custom fonts list with removal capability
 * - Lazy loading of system fonts on first interaction
 */
export function FontConfigurationPanel({
	fontFamily,
	setFontFamily,
	systemFonts,
	fontsLoaded,
	fontsReliable = true,
	fontLoading,
	customFonts,
	onAddCustomFont,
	onRemoveCustomFont,
	onFontInteraction,
	theme,
	heading = 'Interface Font',
	description,
	inheritOptions,
	sizeControl,
	previewFontFamily,
	previewFontSize,
	compact = false,
}: FontConfigurationPanelProps) {
	const [customFontInput, setCustomFontInput] = useState('');

	// The face the sample is drawn in. The caller's resolved value wins because
	// only it can follow an inherit sentinel back to a real family; without one,
	// the selected value is already a family and just needs a fallback chain.
	const previewFace = previewFontFamily ?? withMonoFallback(fontFamily);

	// Memoize normalized font set for O(1) lookup instead of O(n) array search
	const normalizedFontsSet = useMemo(() => {
		const normalize = (str: string) => str.toLowerCase().replace(/[\s-]/g, '');
		const fontSet = new Set<string>();
		systemFonts.forEach((font) => {
			fontSet.add(normalize(font));
			// Also add the original name for exact matches
			fontSet.add(font.toLowerCase());
		});
		return fontSet;
	}, [systemFonts]);

	// Only annotate availability when detection actually enumerated the machine.
	const canAnnotateAvailability = fontsLoaded && fontsReliable;

	// The common groups list SYSTEM faces. Several are also bundled (JetBrains
	// Mono, Fira Code, Roboto Mono, Source Code Pro, Arial's substitute), and a
	// family in two groups renders two rows that mean different things - one
	// guaranteed, one only maybe present. Drop the duplicates from the system
	// groups, since the bundled row is the stronger claim.
	const systemMonospaceFonts = useMemo(
		() => COMMON_MONOSPACE_FONTS.filter((font) => !isBundledFont(font)),
		[]
	);
	const systemProportionalFonts = useMemo(
		() => COMMON_PROPORTIONAL_FONTS.filter((font) => !isBundledFont(font)),
		[]
	);

	const isFontAvailable = useCallback(
		(fontName: string) => {
			const normalize = (str: string) => str.toLowerCase().replace(/[\s-]/g, '');
			const normalizedSearch = normalize(fontName);

			// Fast O(1) lookup
			if (normalizedFontsSet.has(normalizedSearch)) return true;
			if (normalizedFontsSet.has(fontName.toLowerCase())) return true;

			// Fallback to substring search (slower but comprehensive)
			for (const font of normalizedFontsSet) {
				if (font.includes(normalizedSearch) || normalizedSearch.includes(font)) {
					return true;
				}
			}
			return false;
		},
		[normalizedFontsSet]
	);

	// All detected system fonts, excluding ones already surfaced in the common
	// and custom groups so the "All Installed Fonts" group has no duplicates.
	const installedFonts = useMemo(() => {
		const normalize = (str: string) => str.toLowerCase().replace(/[\s-]/g, '');
		const shown = new Set(
			[
				...BUNDLED_FONT_NAMES,
				...COMMON_MONOSPACE_FONTS,
				...COMMON_PROPORTIONAL_FONTS,
				...customFonts,
			].map((f) => normalize(f))
		);
		return [...systemFonts]
			.filter((font) => !shown.has(normalize(font)))
			.sort((a, b) => a.localeCompare(b));
	}, [systemFonts, customFonts]);

	// A <select> whose value matches none of its options silently displays the
	// first one instead, so a font that isn't in any group (a custom font saved
	// on a previous run, or one the system sweep doesn't report) made the
	// dropdown claim the user was on Roboto Mono while the app rendered the
	// real font. Surface the current value as its own option so the control
	// can never misreport what is actually set.
	const unlistedValue = useMemo(() => {
		if (!fontFamily) return null;
		if (inheritOptions?.some((option) => option.value === fontFamily)) return null;
		const known = [
			...BUNDLED_FONT_NAMES,
			...COMMON_MONOSPACE_FONTS,
			...COMMON_PROPORTIONAL_FONTS,
			...customFonts,
			...installedFonts,
		];
		return known.includes(fontFamily) ? null : fontFamily;
	}, [fontFamily, customFonts, installedFonts, inheritOptions]);

	// Every value the dropdown offers, in the order it is rendered, so Up/Down
	// can walk the whole list rather than just one group.
	const orderedFontValues = useMemo(() => {
		const values: string[] = [];
		if (inheritOptions) values.push(...inheritOptions.map((option) => option.value));
		if (unlistedValue) values.push(unlistedValue);
		values.push(
			...BUNDLED_FONT_NAMES,
			...systemMonospaceFonts,
			...systemProportionalFonts,
			...customFonts,
			...installedFonts
		);
		return values;
	}, [
		inheritOptions,
		unlistedValue,
		systemMonospaceFonts,
		systemProportionalFonts,
		customFonts,
		installedFonts,
	]);

	const stepFont = (delta: number) => {
		if (orderedFontValues.length === 0) return;
		const current = orderedFontValues.indexOf(fontFamily);
		// A value the list doesn't contain steps in from the near end, so the
		// first press still moves instead of eating the keystroke.
		const next = current === -1 ? (delta > 0 ? 0 : orderedFontValues.length - 1) : current + delta;
		if (next < 0 || next >= orderedFontValues.length) return;
		setFontFamily(orderedFontValues[next]);
	};

	const handleSelectKeyDown = (e: React.KeyboardEvent<HTMLSelectElement>) => {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		// macOS opens the native popup on an arrow key instead of stepping the
		// value, so previewing font by font has to be driven by hand. Windows and
		// Linux step natively; preventing that keeps one press to one font
		// everywhere. A popup that is already open swallows the key itself, so
		// this cannot double-step.
		e.preventDefault();
		stepFont(e.key === 'ArrowDown' ? 1 : -1);
	};

	const handleAddCustomFont = () => {
		const trimmedFont = customFontInput.trim();
		if (trimmedFont && !customFonts.includes(trimmedFont)) {
			onAddCustomFont(trimmedFont);
			setCustomFontInput('');
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter') {
			handleAddCustomFont();
		}
	};

	return (
		<div>
			{!compact && (
				<>
					<SettingsSectionHeading icon={Type}>{heading}</SettingsSectionHeading>
					{description && <p className="text-xs opacity-70 mb-2 -mt-1">{description}</p>}
				</>
			)}
			{/*
			 * Keep the <select> mounted while fonts lazy-load. Swapping it for a
			 * "Loading fonts..." placeholder mid-click unmounts the element that
			 * was opening its dropdown, so the first click just blinked and did
			 * nothing (issue #1228). The select works without the availability
			 * annotations, which fill in once loading finishes.
			 */}
			<select
				value={fontFamily}
				onChange={(e) => setFontFamily(e.target.value)}
				onFocus={onFontInteraction}
				onClick={onFontInteraction}
				onKeyDown={handleSelectKeyDown}
				// Sized down in compact mode to match its own label. The select
				// otherwise inherits the interface font size, so at a 16px setting
				// with a 1.2 zoom it rendered near 19px - larger than the "Interface"
				// heading above it, which inverts the hierarchy and truncates long
				// font stacks that much sooner.
				className={`w-full rounded border bg-transparent outline-none mb-1 ${
					compact ? 'px-2 py-1.5 text-xs' : 'p-2'
				}`}
				style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				// The visible text truncates at the control's width; the tooltip is
				// how a user reads a long stack without opening the menu.
				title={fontFamily || undefined}
			>
				{inheritOptions?.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
				{unlistedValue && (
					<optgroup label="Current">
						{/* The typography presets store a full CSS stack, so the raw
						    value here is "Inter, -apple-system, BlinkMacSystemFont, ..."
						    and the closed select rendered that whole chain as the name
						    of the user's font. The option's text IS what the select
						    displays, so labelling it with the leading family fixes both
						    at once; the stored value is untouched and the full stack
						    stays readable in the control's tooltip. */}
						<option value={unlistedValue} style={{ fontFamily: unlistedValue }}>
							{displayFontLabel(unlistedValue)}
						</option>
					</optgroup>
				)}
				{/* Every option naming a FACE is drawn in that face: Chromium honors
				    font-family on an option, so the list itself becomes the preview
				    and a user can read the difference between two candidates without
				    selecting either. The inherit entries above deliberately opt out -
				    they name a relationship, not a font, so drawing one in a face
				    would assert something the option is not saying. */}
				{/* Bundled fonts ship inside the app, so they are never annotated
				    "(Not Found)" - unlike a system font, their presence is a fact
				    rather than a guess. Listed first for that reason. */}
				<optgroup label="Bundled with Maestro (always available)">
					{BUNDLED_FONTS.map((font) => (
						<option key={font.name} value={font.name} style={{ fontFamily: font.name }}>
							{font.name}
							{font.substituteFor ? ` - like ${font.substituteFor}` : ''}
							{font.note ? ` (${font.note})` : ''}
						</option>
					))}
				</optgroup>
				<optgroup label="Common Monospace Fonts">
					{systemMonospaceFonts.map((font) => {
						const available = canAnnotateAvailability ? isFontAvailable(font) : true;
						return (
							<option
								key={font}
								value={font}
								style={{ fontFamily: font, opacity: available ? 1 : 0.4 }}
							>
								{font} {canAnnotateAvailability && !available && '(Not Found)'}
							</option>
						);
					})}
				</optgroup>
				<optgroup label="Common Proportional Fonts">
					{systemProportionalFonts.map((font) => {
						const available = canAnnotateAvailability ? isFontAvailable(font) : true;
						return (
							<option
								key={font}
								value={font}
								style={{ fontFamily: font, opacity: available ? 1 : 0.4 }}
							>
								{font} {canAnnotateAvailability && !available && '(Not Found)'}
							</option>
						);
					})}
				</optgroup>
				{customFonts.length > 0 && (
					<optgroup label="Custom Fonts">
						{customFonts.map((font) => (
							<option key={font} value={font} style={{ fontFamily: font }}>
								{font}
							</option>
						))}
					</optgroup>
				)}
				{installedFonts.length > 0 && (
					<optgroup label="All Installed Fonts">
						{installedFonts.map((font) => (
							<option key={font} value={font} style={{ fontFamily: font }}>
								{font}
							</option>
						))}
					</optgroup>
				)}
			</select>
			{/*
			 * Live sample, in the face and at the size this surface actually
			 * renders at. The dropdown answers "which fonts are there"; this
			 * answers "what does mine look like right now" without making the user
			 * leave Settings and go find the surface.
			 *
			 * Deliberately ONE line, truncated rather than wrapped. In compact mode
			 * this sits inside a six-cell grid whose rows are already stretched to
			 * their tallest cell, so a fixed single line lands in slack the cells
			 * reserve instead of adding a row of height per surface; a sample that
			 * re-wrapped with the pane width would move that height around as the
			 * modal is resized.
			 */}
			<div
				className={`rounded border overflow-hidden mb-2 ${compact ? 'px-2 py-1' : 'px-3 py-2'}`}
				style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
				data-testid="font-preview"
			>
				<p
					className="truncate leading-snug"
					style={{
						color: theme.colors.textMain,
						fontFamily: previewFace,
						fontSize: previewFontSize,
					}}
					title={FONT_PREVIEW_PROSE}
				>
					{FONT_PREVIEW_PROSE}
				</p>
			</div>
			{/* The size row is the LAST thing in a compact cell, so a trailing
			    `mb-2` there is margin below the final element of a grid cell: it
			    adds to the grid's own row gap and makes the six cells sit
			    further apart than the gap says. Full mode keeps it, because the
			    custom-font manager follows and the two need separating. */}
			<div
				className={`flex items-center justify-between gap-3 min-h-[1.5rem] ${
					compact ? '' : 'mb-2'
				}`}
			>
				{/* The hint is one line for the whole group in compact mode, printed
				    once above the grid rather than repeated under every picker. */}
				{!compact && (
					<span className="text-xs opacity-70">
						{fontLoading
							? 'Loading installed fonts...'
							: canAnnotateAvailability || !fontsLoaded
								? 'Press Up/Down to preview each font.'
								: "Installed fonts couldn't be listed, so none are marked missing."}
					</span>
				)}
				{sizeControl}
			</div>

			{/* Hoisted out of the per-surface pickers in compact mode: the list is
			    global, so one manager sits above the whole group instead of five
			    identical copies all editing the same array. */}
			{!compact && (
				<div className="space-y-2">
					<div className="flex gap-2">
						<input
							type="text"
							value={customFontInput}
							onChange={(e) => setCustomFontInput(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="Add custom font name..."
							className="flex-1 p-2 rounded border bg-transparent outline-none text-sm"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						/>
						<button
							onClick={handleAddCustomFont}
							className="px-3 py-2 rounded text-xs font-bold"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}}
						>
							Add
						</button>
					</div>

					{customFonts.length > 0 && (
						<div className="flex flex-wrap gap-2">
							{customFonts.map((font) => (
								<div
									key={font}
									className="flex items-center gap-2 px-2 py-1 rounded text-xs"
									style={{
										backgroundColor: theme.colors.bgActivity,
										borderColor: theme.colors.border,
									}}
								>
									<span style={{ color: theme.colors.textMain }}>{font}</span>
									<button
										onClick={() => onRemoveCustomFont(font)}
										className="hover:opacity-70"
										style={{ color: theme.colors.error }}
									>
										×
									</button>
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
