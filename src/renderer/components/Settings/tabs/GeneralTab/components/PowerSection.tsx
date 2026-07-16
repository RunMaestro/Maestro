import { Battery } from 'lucide-react';
import { isLinux } from '../../../../../../shared/platformDetection';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { ToggleSettingRow } from '../../DisplayTab/components/ToggleSettingRow';

interface PowerSectionProps {
	theme: Theme;
	preventSleepEnabled: boolean;
	setPreventSleepEnabled: (enabled: boolean) => void;
}

export function PowerSection({
	theme,
	preventSleepEnabled,
	setPreventSleepEnabled,
}: PowerSectionProps) {
	return (
		<div data-setting-id="general-power">
			<SettingsSectionHeading icon={Battery}>Power</SettingsSectionHeading>
			<div
				className="p-3 rounded border space-y-3"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<ToggleSettingRow
					theme={theme}
					title={
						<span className="font-medium" style={{ color: theme.colors.textMain }}>
							Prevent sleep while working
						</span>
					}
					description={
						<span style={{ color: theme.colors.textDim }}>
							Keeps your computer awake when AI agents are busy, Auto Run is active, or Cue
							pipelines are scheduled
						</span>
					}
					checked={preventSleepEnabled}
					onChange={setPreventSleepEnabled}
					ariaLabel="Prevent sleep while working"
					clickableRow
				/>

				{isLinux() && (
					<div
						className="text-xs p-2 rounded"
						style={{
							backgroundColor: theme.colors.warning + '15',
							color: theme.colors.warning,
						}}
					>
						Note: May have limited support on some Linux desktop environments.
					</div>
				)}
			</div>
		</div>
	);
}
