import React, { useState, useMemo, useCallback } from 'react';
import { Type } from 'lucide-react';
import type { Theme } from '../types';
import { SettingsSectionHeading } from './Settings/SettingsSectionHeading';

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

export interface FontConfigurationPanelProps {
	/** Currently selected font family */
	fontFamily: string;
	/** Callback when font family changes */
	setFontFamily: (font: string) => void;
	/** List of system fonts detected on the machine */
	systemFonts: string[];
	/** Whether fonts have been loaded from the system */
	fontsLoaded: boolean;
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
	fontLoading,
	customFonts,
	onAddCustomFont,
	onRemoveCustomFont,
	onFontInteraction,
	theme,
}: FontConfigurationPanelProps) {
	const [customFontInput, setCustomFontInput] = useState('');

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

	// A <select> whose value matches none of its options silently displays the
	// first one instead, so a font that isn't in any group (a custom font saved
	// on a previous run, or one the system sweep doesn't report) made the
	// dropdown claim the user was on Roboto Mono while the app rendered the
	// real font. Surface the current value as its own option so the control
	// can never misreport what is actually set.
	const unlistedValue = useMemo(() => {
		if (!fontFamily) return null;
		const known = [...COMMON_MONOSPACE_FONTS, ...customFonts];
		return known.includes(fontFamily) ? null : fontFamily;
	}, [fontFamily, customFonts]);

	// Every value the dropdown offers, in the order it is rendered, so Up/Down
	// can walk the whole list rather than just one group.
	const orderedFontValues = useMemo(() => {
		const values: string[] = [];
		if (unlistedValue) values.push(unlistedValue);
		values.push(...COMMON_MONOSPACE_FONTS, ...customFonts);
		return values;
	}, [unlistedValue, customFonts]);

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
			<SettingsSectionHeading icon={Type}>Interface Font</SettingsSectionHeading>
			{fontLoading ? (
				<div className="text-sm opacity-50 p-2">Loading fonts...</div>
			) : (
				<>
					<select
						value={fontFamily}
						onChange={(e) => setFontFamily(e.target.value)}
						onFocus={onFontInteraction}
						onClick={onFontInteraction}
						onKeyDown={handleSelectKeyDown}
						className="w-full p-2 rounded border bg-transparent outline-none mb-3"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						{unlistedValue && (
							<optgroup label="Current">
								<option value={unlistedValue}>{unlistedValue}</option>
							</optgroup>
						)}
						<optgroup label="Common Monospace Fonts">
							{COMMON_MONOSPACE_FONTS.map((font) => {
								const available = fontsLoaded ? isFontAvailable(font) : true;
								return (
									<option key={font} value={font} style={{ opacity: available ? 1 : 0.4 }}>
										{font} {fontsLoaded && !available && '(Not Found)'}
									</option>
								);
							})}
						</optgroup>
						{customFonts.length > 0 && (
							<optgroup label="Custom Fonts">
								{customFonts.map((font) => (
									<option key={font} value={font}>
										{font}
									</option>
								))}
							</optgroup>
						)}
					</select>
					<div className="-mt-2 mb-3 text-xs opacity-50">Press Up/Down to preview each font.</div>

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
				</>
			)}
		</div>
	);
}
