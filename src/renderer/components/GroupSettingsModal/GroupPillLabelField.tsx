/**
 * GroupPillLabelField - the text of the badge drawn beside a group's
 * bookmarked agents in the Left Bar (`Group.shortLabel`).
 *
 * It is the one field in Group Settings that is about the group and not about
 * its agents: it is never copied into a new agent and never published to an
 * existing one. An empty field is the automatic abbreviation, which the
 * placeholder shows, so empty reads as "Maestro picks this" and not as broken.
 *
 * The preview is the real badge (`GroupPill`), always in its short form: that
 * is the thing this field names. Two Display settings can keep the label off
 * screen, and each gets a line that says so and opens the control.
 */

import { abbreviateGroupName, GROUP_SHORT_LABEL_MAX_LENGTH } from '../../../shared/formatters';
import { getModalActions } from '../../stores/modalStore';
import { useSettingsStore } from '../../stores/settingsStore';
import type { Theme } from '../../types';
import { FormInput } from '../ui/FormInput';
import { GroupPill } from '../ui/GroupPill';

/** The Settings anchor on "Show group label on bookmarked agents" (Display). */
const GROUP_LABEL_SETTING_ID = 'display-left-panel-group-label';

export interface GroupPillLabelFieldProps {
	theme: Theme;
	/** The group's name: the source of the automatic abbreviation and the hover title. */
	groupName: string;
	/** The label as typed. Trimmed, and removed when blank, by the save. */
	value: string;
	onChange: (value: string) => void;
	/**
	 * Close the modal this field is in. Settings sits below it in the layer
	 * stack, so the modal must go before Settings can be seen.
	 */
	onLeaveForSettings: () => void;
}

export function GroupPillLabelField({
	theme,
	groupName,
	value,
	onChange,
	onLeaveForSettings,
}: GroupPillLabelFieldProps) {
	const pillsShown = useSettingsStore((s) => s.showGroupLabelInBookmarks);
	const fullNameShown = useSettingsStore((s) => s.showFullGroupLabelInBookmarks);

	const openDisplaySetting = () => {
		onLeaveForSettings();
		getModalActions().openSettings('display', GROUP_LABEL_SETTING_ID);
	};

	const settingButton = (settingName: string) => (
		<button
			type="button"
			onClick={openDisplaySetting}
			className="underline hover:opacity-80"
			style={{ color: theme.colors.accent }}
			title="Open this setting. Group Settings closes, and changes not saved here are lost."
		>
			{settingName}
		</button>
	);

	return (
		<div data-testid="group-settings-pill-label">
			<FormInput
				id="group-settings-pill-label-input"
				theme={theme}
				label="Group Pill Label"
				value={value}
				onChange={onChange}
				placeholder={abbreviateGroupName(groupName)}
				maxLength={GROUP_SHORT_LABEL_MAX_LENGTH}
				helperText="Shown beside bookmarked agents in the Left Bar. Leave blank to let Maestro abbreviate the group name. The full name still appears on hover."
				heightClass="p-2"
				addon={
					<div
						className="flex items-center gap-2 shrink-0 text-xs"
						style={{ color: theme.colors.textDim }}
					>
						<span>Preview</span>
						<GroupPill
							theme={theme}
							group={{ name: groupName, shortLabel: value }}
							testId="group-settings-pill-preview"
						/>
					</div>
				}
			/>
			{!pillsShown ? (
				<p
					className="mt-1 text-xs"
					style={{ color: theme.colors.warning }}
					data-testid="group-settings-pill-hidden-note"
				>
					Group pills are currently hidden. Turn on{' '}
					{settingButton('Show group label on bookmarked agents')} in Settings -&gt; Display to see
					this.
				</p>
			) : (
				fullNameShown && (
					<p
						className="mt-1 text-xs"
						style={{ color: theme.colors.warning }}
						data-testid="group-settings-pill-full-name-note"
					>
						Group pills currently show the full group name, not this label. Turn off{' '}
						{settingButton('Show full group label on bookmarked agents')} in Settings -&gt; Display
						to see this.
					</p>
				)
			)}
		</div>
	);
}
