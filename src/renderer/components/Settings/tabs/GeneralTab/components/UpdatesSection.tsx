import { Download, FlaskConical } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { ToggleSettingRow } from '../../DisplayTab/components/ToggleSettingRow';

interface UpdatesSectionProps {
	theme: Theme;
	checkForUpdatesOnStartup: boolean;
	setCheckForUpdatesOnStartup: (enabled: boolean) => void;
	enableBetaUpdates: boolean;
	setEnableBetaUpdates: (enabled: boolean) => void;
}

export function UpdatesSection({
	theme,
	checkForUpdatesOnStartup,
	setCheckForUpdatesOnStartup,
	enableBetaUpdates,
	setEnableBetaUpdates,
}: UpdatesSectionProps) {
	return (
		<div>
			<SettingsSectionHeading icon={Download}>Updates</SettingsSectionHeading>
			<div
				className="p-3 rounded border space-y-3"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<ToggleSettingRow
					theme={theme}
					title={
						<span className="font-medium" style={{ color: theme.colors.textMain }}>
							Check for updates automatically
						</span>
					}
					description={
						<span style={{ color: theme.colors.textDim }}>
							Check for new Maestro versions on startup and once per day while the app is running
						</span>
					}
					checked={checkForUpdatesOnStartup}
					onChange={setCheckForUpdatesOnStartup}
					ariaLabel="Check for updates automatically"
					clickableRow
					data-setting-id="general-updates"
				/>

				<ToggleSettingRow
					theme={theme}
					title={
						<span
							className="font-medium flex items-center gap-2"
							style={{ color: theme.colors.textMain }}
						>
							<FlaskConical className="w-4 h-4" />
							Include beta and release candidate updates
						</span>
					}
					description={
						<span style={{ color: theme.colors.textDim }}>
							Opt-in to receive pre-release versions (e.g., v0.11.1-rc, v0.12.0-beta). These may
							contain experimental features and bugs.
						</span>
					}
					checked={enableBetaUpdates}
					onChange={setEnableBetaUpdates}
					ariaLabel="Include beta and release candidate updates"
					borderTop
					clickableRow
					data-setting-id="general-beta-updates"
				/>
			</div>
		</div>
	);
}
