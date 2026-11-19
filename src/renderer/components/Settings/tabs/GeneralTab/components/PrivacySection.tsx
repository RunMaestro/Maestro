import { BarChart3, Bug, Footprints } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingCheckbox } from '../../../../SettingCheckbox';

interface PrivacySectionProps {
	theme: Theme;
	crashReportingEnabled: boolean;
	setCrashReportingEnabled: (enabled: boolean) => void;
	userJourneyEnabled: boolean;
	setUserJourneyEnabled: (enabled: boolean) => void;
	playbookTelemetryEnabled: boolean;
	setPlaybookTelemetryEnabled: (enabled: boolean) => void;
}

export function PrivacySection({
	theme,
	crashReportingEnabled,
	setCrashReportingEnabled,
	userJourneyEnabled,
	setUserJourneyEnabled,
	playbookTelemetryEnabled,
	setPlaybookTelemetryEnabled,
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
			<div data-setting-id="general-playbook-telemetry">
				<SettingCheckbox
					icon={BarChart3}
					sectionLabel="Playbook Exchange"
					title="Share anonymous playbook usage"
					description="Sends installs, runs, and outcomes of official Exchange playbooks to runmaestro.ai, so the Exchange can show which playbooks are popular and which are broken. Playbook ids are public; paths, parameter values, and agent names are never sent."
					checked={playbookTelemetryEnabled}
					onChange={setPlaybookTelemetryEnabled}
					theme={theme}
				/>
			</div>
		</>
	);
}
