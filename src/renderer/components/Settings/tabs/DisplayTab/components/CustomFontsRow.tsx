import { useState } from 'react';
import type { Theme } from '../../../../../types';

interface CustomFontsRowProps {
	theme: Theme;
	customFonts: string[];
	onAddCustomFont: (font: string) => void;
	onRemoveCustomFont: (font: string) => void;
}

/**
 * The one place custom font names are added and removed.
 *
 * `customFonts` is a single global list shared by every surface, but the input
 * and pill row used to render inside each surface's picker - five identical
 * controls editing one list, which read as five separate lists and accounted
 * for a large share of the section's height. Typing a name into the terminal's
 * box added it to the interface's dropdown too, which is correct behaviour and
 * looked like a bug.
 *
 * Hoisting it above the surfaces states the truth: one list, offered to all of
 * them.
 */
export function CustomFontsRow({
	theme,
	customFonts,
	onAddCustomFont,
	onRemoveCustomFont,
}: CustomFontsRowProps) {
	const [draft, setDraft] = useState('');

	const commit = () => {
		const trimmed = draft.trim();
		if (!trimmed || customFonts.includes(trimmed)) return;
		onAddCustomFont(trimmed);
		setDraft('');
	};

	return (
		// No heading of its own. The section this renders into already prints
		// "Custom Fonts" and the same sentence about being offered in every
		// picker, so a second copy inside the card restated the two lines
		// directly above it.
		<div className="space-y-2">
			<div className="flex gap-2">
				<input
					type="text"
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') commit();
					}}
					placeholder="Add custom font name..."
					aria-label="Add custom font name"
					data-testid="custom-font-input"
					className="flex-1 min-w-0 p-2 rounded border bg-transparent outline-none text-sm"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				/>
				<button
					type="button"
					onClick={commit}
					data-testid="custom-font-add"
					className="px-3 py-2 rounded text-xs font-bold shrink-0"
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
						<span
							key={font}
							className="flex items-center gap-2 px-2 py-1 rounded text-xs"
							style={{
								backgroundColor: theme.colors.bgActivity,
								borderColor: theme.colors.border,
							}}
						>
							<span style={{ color: theme.colors.textMain }}>{font}</span>
							<button
								type="button"
								onClick={() => onRemoveCustomFont(font)}
								aria-label={`Remove ${font}`}
								className="hover:opacity-70"
								style={{ color: theme.colors.error }}
							>
								×
							</button>
						</span>
					))}
				</div>
			)}
		</div>
	);
}
