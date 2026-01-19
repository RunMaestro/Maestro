import React, { useState, useMemo, useCallback } from 'react';
import type { Theme } from '../types';

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
			<label className="block text-xs font-bold opacity-70 uppercase mb-2">Interface Font</label>
			{fontLoading ? (
				<div className="text-sm opacity-50 p-2">Loading fonts...</div>
			) : (
				<>
					<select
						value={fontFamily}
						onChange={(e) => setFontFamily(e.target.value)}
						onFocus={onFontInteraction}
						onClick={onFontInteraction}
						className="w-full p-2 rounded border bg-transparent outline-none mb-3"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
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
