import { Bug, Footprints } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingCheckbox } from '../../../../SettingCheckbox';

interface PrivacySectionProps {
	theme: Theme;
	crashReportingEnabled: boolean;
	setCrashReportingEnabled: (enabled: boolean) => void;
	userJourneyEnabled: boolean;
	setUserJourneyEnabled: (enabled: boolean) => void;
}

export function PrivacySection({
	theme,
	crashReportingEnabled,
	setCrashReportingEnabled,
	userJourneyEnabled,
	setUserJourneyEnabled,
}: PrivacySectionProps) {
	return (
		<>
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
			<div data-setting-id="general-user-journey">
				<SettingCheckbox
					icon={Footprints}
					sectionLabel="User Journey"
					title="Record the files and pages you open in Maestro"
					description="Agents read it with maestro-cli timeline to follow references like the file you just saved. Only names, paths, and page addresses are kept, on this computer, for 90 days. Turning it off stops recording."
					checked={userJourneyEnabled}
					onChange={setUserJourneyEnabled}
					theme={theme}
				/>
			</div>
		</>
	);
}
