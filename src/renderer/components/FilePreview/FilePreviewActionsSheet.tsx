/**
 * FilePreviewActionsSheet - the file preview header's toolbar, on a phone.
 *
 * The desktop header puts up to fourteen icon buttons in one row beside the file
 * name, then a directory path line, then a stats subbar. At 390px that costs
 * roughly 400px of an 844px screen before a word of the file is readable: the
 * 44px tap-target floor `src/web/index.css` sets on every button under 767px
 * turns seven visible icons into two full rows on its own. So on a phone the
 * header keeps the file name, Save (a primary action with a dirty state, which
 * must not go two taps deep), and a single "..." that opens this sheet.
 *
 * The sheet holds the same buttons as labelled rows plus the path and the stats,
 * which have nowhere else to go once the header is one line. The ACTIONS ARE NOT
 * RESTATED HERE - `FilePreviewHeader` builds one list that both it and this
 * sheet render, so a button can never exist in the toolbar and be missing from
 * the sheet, and `toolbarVisibility` is honoured once for both.
 *
 * The preview tier is the one entry that is not a plain button. On the desktop
 * it is `PreviewTierChip`, whose menu is an anchored popover - inside a
 * scrolling sheet body that would be clipped, so it becomes an accordion, the
 * same shape `ComposerOptionsSheet` uses for every multi-choice control.
 */

import React, { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { Theme } from '../../types';
import { PhoneBottomSheet } from '../ui/PhoneBottomSheet';
import { PhoneSheetActionRow, PhoneSheetOptionRow, PhoneSheetSection } from '../ui/PhoneSheetRows';
import { TIER_DESCRIPTION, TIER_META } from './PreviewTierChip';
import type { PreviewTier } from './filePreviewUtils';

/** One ordinary toolbar button: an icon, a label, and something it does. */
export interface FilePreviewHeaderButton {
	kind: 'button';
	key: string;
	icon: LucideIcon;
	/** Tooltip text on the desktop, row label in the sheet. Already phrased as
	 *  an action ("Hide remote images"), so it reads correctly in both. */
	label: string;
	onClick: () => void;
	/** Draws the icon in the accent color - a toggle that is currently on. */
	active?: boolean;
	/** Announces the on/off state to assistive tech. Set it only on a real
	 *  toggle: `active` also colors buttons whose meaning merely changed (the
	 *  gist button, once one exists), and claiming those are pressed is a lie. */
	pressed?: boolean;
	/** Shortcut shown in the desktop tooltip. Dropped in the sheet: a phone has
	 *  no keyboard, matching the `data-shortcut-hint` rule. */
	shortcut?: string;
	testId?: string;
}

/** The preview-tier control, which is a chip rather than a button. */
export interface FilePreviewHeaderTier {
	kind: 'tier';
	key: 'previewTier';
	autoTier: PreviewTier;
	override: PreviewTier | undefined;
	onSelect: (tier: PreviewTier | undefined) => void;
}

export type FilePreviewHeaderAction = FilePreviewHeaderButton | FilePreviewHeaderTier;

/** One entry of the stats subbar, so the bar and the sheet cannot disagree. */
export interface FilePreviewHeaderStat {
	key: string;
	label: string;
	value: React.ReactNode;
	/** Color for the value. Defaults to the main text color. */
	valueColor?: string;
}

interface FilePreviewActionsSheetProps {
	open: boolean;
	onClose: () => void;
	theme: Theme;
	/** Directory holding the file, without the file name. */
	directoryPath: string;
	stats: FilePreviewHeaderStat[];
	actions: FilePreviewHeaderAction[];
}

export function FilePreviewActionsSheet({
	open,
	onClose,
	theme,
	directoryPath,
	stats,
	actions,
}: FilePreviewActionsSheetProps) {
	const [tierExpanded, setTierExpanded] = useState(false);

	// The path and the stats are what the header gives up to become one line, so
	// they ride the non-scrolling header rather than the body: the user opened
	// the sheet and should see them without scrolling to find them. They are NOT
	// gated on `showStatsBar` - that flag hides the subbar while the reader
	// scrolls the document, which has nothing to say about a sheet opened by hand.
	const header =
		directoryPath || stats.length > 0 ? (
			<div
				className="px-4 pt-1 pb-3 border-b"
				style={{ borderColor: theme.colors.border }}
				data-testid="file-preview-actions-sheet-info"
			>
				{directoryPath && (
					<div className="text-xs break-all" style={{ color: theme.colors.textDim }}>
						{directoryPath}
					</div>
				)}
				{stats.length > 0 && (
					<div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
						{stats.map((stat) => (
							<div key={stat.key} className="text-2xs" style={{ color: theme.colors.textDim }}>
								<span className="opacity-60">{stat.label}:</span>{' '}
								<span style={{ color: stat.valueColor ?? theme.colors.textMain }}>
									{stat.value}
								</span>
							</div>
						))}
					</div>
				)}
			</div>
		) : null;

	return (
		<PhoneBottomSheet
			open={open}
			onClose={onClose}
			theme={theme}
			ariaLabel="File actions"
			// Taller than the composer sheet: this is a menu the user came to read,
			// and it can carry a dozen rows plus an expanded tier list.
			maxHeight="80dvh"
			// Opened by a plain tap, so no synthesized click trails the gesture and
			// the scrim can be live immediately.
			scrimArmMs={0}
			header={header}
			testId="file-preview-actions-sheet"
		>
			{actions.map((action) => {
				if (action.kind === 'tier') {
					const effective = action.override ?? action.autoTier;
					return (
						<PhoneSheetSection
							key={action.key}
							icon={TIER_META[effective].icon}
							label="Preview mode"
							value={
								action.override
									? TIER_META[effective].label
									: `${TIER_META[effective].label} · auto`
							}
							accent={action.override ? theme.colors.accent : theme.colors.textDim}
							expanded={tierExpanded}
							onToggle={() => setTierExpanded((v) => !v)}
							theme={theme}
							testId="file-preview-actions-tier"
						>
							<PhoneSheetOptionRow
								label="Auto"
								description={`Auto picks ${TIER_META[action.autoTier].label} for this file`}
								selected={!action.override}
								accent={theme.colors.accent}
								onSelect={() => {
									action.onSelect(undefined);
									onClose();
								}}
								theme={theme}
							/>
							{(['rich', 'fast', 'giant'] as const).map((tier) => (
								<PhoneSheetOptionRow
									key={tier}
									label={TIER_META[tier].label}
									description={TIER_DESCRIPTION[tier]}
									selected={action.override === tier}
									accent={theme.colors.accent}
									onSelect={() => {
										action.onSelect(tier);
										onClose();
									}}
									theme={theme}
								/>
							))}
						</PhoneSheetSection>
					);
				}
				return (
					<PhoneSheetActionRow
						key={action.key}
						icon={action.icon}
						label={action.label}
						iconColor={action.active ? theme.colors.accent : undefined}
						pressed={action.pressed}
						// Every row here either navigates away or changes something the
						// user can see behind the sheet, so the sheet has done its job
						// once one is tapped.
						onSelect={() => {
							action.onClick();
							onClose();
						}}
						theme={theme}
						testId={action.testId ? `${action.testId}-sheet` : undefined}
					/>
				);
			})}
		</PhoneBottomSheet>
	);
}
