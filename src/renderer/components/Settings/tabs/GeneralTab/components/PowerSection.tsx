import { Battery } from 'lucide-react';
import { isLinux } from '../../../../../../shared/platformDetection';
import type { Theme } from '../../../../../types';
import { ToggleSwitch } from '../../../../ui/ToggleSwitch';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

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
				<div
					className="flex items-center justify-between cursor-pointer"
					onClick={() => setPreventSleepEnabled(!preventSleepEnabled)}
					role="button"
					tabIndex={0}
					onKeyDown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							setPreventSleepEnabled(!preventSleepEnabled);
						}
					}}
				>
					<div className="flex-1 pr-3">
						<div className="font-medium" style={{ color: theme.colors.textMain }}>
							Prevent sleep while working
						</div>
						<div className="text-xs opacity-70 mt-0.5">
							Keeps your computer awake when AI agents are busy, Auto Run is active, or Cue
							pipelines are scheduled
						</div>
					</div>
					<ToggleSwitch
						checked={preventSleepEnabled}
						onChange={setPreventSleepEnabled}
						theme={theme}
						ariaLabel="Prevent sleep while working"
					/>
				</div>

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
