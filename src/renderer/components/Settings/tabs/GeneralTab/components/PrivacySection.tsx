import { Bug } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingCheckbox } from '../../../../SettingCheckbox';

interface PrivacySectionProps {
	theme: Theme;
	crashReportingEnabled: boolean;
	setCrashReportingEnabled: (enabled: boolean) => void;
}

export function PrivacySection({
	theme,
	crashReportingEnabled,
	setCrashReportingEnabled,
}: PrivacySectionProps) {
	return (
		<div data-setting-id="general-crash-reporting">
			<SettingCheckbox
				icon={Bug}
				sectionLabel="Privacy"
				title="Send anonymous crash reports"
				description="Help improve Maestro by automatically sending crash reports. No personal data is collected. Changes take effect after restart."
				checked={crashReportingEnabled}
				onChange={setCrashReportingEnabled}
				theme={theme}
			/>
		</div>
	);
}
