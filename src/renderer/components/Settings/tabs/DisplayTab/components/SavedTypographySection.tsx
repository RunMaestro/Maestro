import { useCallback, useState } from 'react';
import { BookmarkCheck, Save, Undo2 } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from './SectionCard';
import { formatRelativeTime } from '../../../../../../shared/formatters';
import type { TypographySnapshot } from '../../../../../../shared/typographySnapshot';

interface SavedTypographySectionProps {
	theme: Theme;
	/** The saved setup, or null when nothing has been saved yet. */
	snapshot: TypographySnapshot | null;
	/** Whether the live fonts and sizes already equal the saved ones. */
	isCurrent: boolean;
	onSave: () => void;
	onRestore: () => void;
}

/**
 * Save / Restore Customizations - the escape hatch that makes the two controls
 * around it safe to use.
 *
 * Factory Reset overwrites every font and size at once, so a user who had spent
 * ten picker changes arriving at something they liked could not try Default or
 * Hacker without losing it. Saving first turns that from a decision into an
 * experiment.
 *
 * Sits above the pickers rather than below them because it is about the whole
 * set: read top to bottom the tab now goes reset-to-a-preset, keep-your-own,
 * then the individual controls those two operate on.
 *
 * Save asks for a second click ONLY when it would overwrite an existing save -
 * that is the one action here with nothing behind it. Restore does not: the
 * button says exactly what it does, and needing two clicks to get back to your
 * own fonts would defeat the point of having them one click away.
 */
export function SavedTypographySection({
	theme,
	snapshot,
	isCurrent,
	onSave,
	onRestore,
}: SavedTypographySectionProps) {
	const [confirmingSave, setConfirmingSave] = useState(false);
	// An existing save that already matches the live settings is not at risk:
	// re-saving it writes the same values back, so the confirmation would ask
	// about a loss that cannot happen.
	const saveOverwrites = Boolean(snapshot) && !isCurrent;

	const handleSave = useCallback(() => {
		if (saveOverwrites && !confirmingSave) {
			setConfirmingSave(true);
			return;
		}
		onSave();
		setConfirmingSave(false);
	}, [saveOverwrites, confirmingSave, onSave]);

	const status = !snapshot
		? 'Nothing saved yet.'
		: isCurrent
			? `Your saved fonts are active. Saved ${formatRelativeTime(snapshot.savedAt)}.`
			: `Saved ${formatRelativeTime(snapshot.savedAt)}. The fonts below are not it.`;

	return (
		<div data-setting-id="display-typography-snapshot">
			<SettingsSectionHeading
				icon={BookmarkCheck}
				description={
					<>
						Keep the fonts and sizes you like as your own setup, then try a preset above or keep
						tinkering below and put yours back in one click. One slot, overwritten each time you
						save. Your zoom level is not part of it.
					</>
				}
			>
				Save &amp; Restore Customizations
			</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<div className="space-y-2">
					<div className="flex items-baseline justify-between gap-3">
						<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
							Your saved fonts
						</span>
						<span className="text-xs-plus opacity-55">{status}</span>
					</div>
					<div className="flex gap-2">
						<button
							type="button"
							onClick={handleSave}
							onBlur={() => setConfirmingSave(false)}
							data-testid="typography-snapshot-save"
							className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded border text-xs font-bold transition-colors hover:bg-white/5"
							style={{
								borderColor: confirmingSave ? theme.colors.warning : theme.colors.border,
								color: confirmingSave ? theme.colors.warning : theme.colors.textMain,
							}}
						>
							<Save className="w-3.5 h-3.5" />
							{confirmingSave ? 'Replace your saved fonts?' : 'Save Customizations'}
						</button>
						<button
							type="button"
							onClick={onRestore}
							disabled={!snapshot || isCurrent}
							data-testid="typography-snapshot-restore"
							title={
								!snapshot
									? 'Save your fonts first.'
									: isCurrent
										? 'Your saved fonts are already active.'
										: undefined
							}
							className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded border text-xs font-bold transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:hover:bg-transparent"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
								// Dimmed rather than hidden: a Restore button that
								// disappears when there is nothing to restore leaves no
								// hint that saving is what turns it on.
								opacity: !snapshot || isCurrent ? 0.45 : 1,
							}}
						>
							<Undo2 className="w-3.5 h-3.5" />
							Restore Customizations
						</button>
					</div>
					{confirmingSave && (
						<p className="text-xs" style={{ color: theme.colors.warning }}>
							Click again to replace the setup you saved earlier. This cannot be undone.
						</p>
					)}
				</div>
			</SectionCard>
		</div>
	);
}
