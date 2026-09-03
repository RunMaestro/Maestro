import { useCallback, useState } from 'react';
import { RotateCcw, Sparkles, Terminal } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import {
	TYPOGRAPHY_PRESETS,
	TYPOGRAPHY_PRESET_IDS,
	matchTypographyPreset,
	type TypographyPresetFonts,
	type TypographyPresetId,
	type TypographyPresetSizes,
} from '../../../../../../shared/typographyPresets';

interface TypographyResetSectionProps {
	theme: Theme;
	/** Current font settings, used to show which preset (if any) is active. */
	fonts: TypographyPresetFonts;
	/** Current size settings, so a size-only edit also shows as "customized". */
	sizes: TypographyPresetSizes;
	onReset: (id: TypographyPresetId) => void;
}

/**
 * Factory Reset Fonts - restore all five font families AND all five sizes to a
 * preset in one click.
 *
 * Sits BELOW the pickers it overwrites. It used to lead the Display tab, which
 * put the one destructive control on the tab first and offered a way out before
 * the user had seen anything to get out of. It reads as an escape hatch where it
 * is now: the fine controls, then the one button back. It is also the only way
 * back to the first-run chooser's presets once that modal has been dismissed.
 *
 * Reset is destructive to deliberate work (ten settings at once), so it asks
 * for a second click rather than firing on the first. The confirmation is
 * inline rather than a modal: this is recoverable by picking the other preset,
 * so a blocking dialog would cost more than the mistake.
 */
export function TypographyResetSection({
	theme,
	fonts,
	sizes,
	onReset,
}: TypographyResetSectionProps) {
	const [pending, setPending] = useState<TypographyPresetId | null>(null);
	const activePreset = matchTypographyPreset(fonts, sizes);

	const handleClick = useCallback(
		(id: TypographyPresetId) => {
			if (pending === id) {
				onReset(id);
				setPending(null);
				return;
			}
			setPending(id);
		},
		[pending, onReset]
	);

	return (
		<div data-setting-id="display-typography-reset">
			<SettingsSectionHeading
				icon={RotateCcw}
				description={
					<>
						Set every font and size above at once. Default is proportional to read and monospace to
						work; Hacker is monospace everywhere.
						{activePreset
							? ` You're on ${TYPOGRAPHY_PRESETS[activePreset].label}.`
							: " You've customized these, so neither preset is active."}
					</>
				}
			>
				Factory Reset Fonts
			</SettingsSectionHeading>
			<div className="flex gap-2">
				{TYPOGRAPHY_PRESET_IDS.map((id) => {
					const preset = TYPOGRAPHY_PRESETS[id];
					const isPending = pending === id;
					const isActive = activePreset === id;
					return (
						<button
							key={id}
							type="button"
							onClick={() => handleClick(id)}
							onBlur={() => setPending((p) => (p === id ? null : p))}
							data-testid={`typography-reset-${id}`}
							className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded border text-xs font-bold transition-colors hover:bg-white/5"
							style={{
								borderColor: isPending
									? theme.colors.warning
									: isActive
										? theme.colors.accent
										: theme.colors.border,
								color: isPending ? theme.colors.warning : theme.colors.textMain,
								backgroundColor: isActive ? `${theme.colors.accent}12` : 'transparent',
							}}
						>
							{id === 'hacker' ? (
								<Terminal className="w-3.5 h-3.5" />
							) : (
								<Sparkles className="w-3.5 h-3.5" />
							)}
							{isPending ? `Reset to ${preset.label}?` : preset.label}
						</button>
					);
				})}
			</div>
			{pending && (
				<p className="text-xs mt-2" style={{ color: theme.colors.warning }}>
					Click again to overwrite all five fonts and all five sizes. Your zoom level is kept.
				</p>
			)}
		</div>
	);
}
