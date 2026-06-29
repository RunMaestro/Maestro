import { Download, FlaskConical } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { ToggleSwitch } from '../../../../ui/ToggleSwitch';

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
			<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
				<Download className="w-3 h-3" />
				Updates
			</div>
			<div
				className="p-3 rounded border space-y-3"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div
					data-setting-id="general-updates"
					className="flex items-center justify-between cursor-pointer"
					onClick={() => setCheckForUpdatesOnStartup(!checkForUpdatesOnStartup)}
					role="button"
					tabIndex={0}
					onKeyDown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							setCheckForUpdatesOnStartup(!checkForUpdatesOnStartup);
						}
					}}
				>
					<div className="flex-1 pr-3">
						<div className="font-medium" style={{ color: theme.colors.textMain }}>
							Check for updates automatically
						</div>
						<div className="text-xs opacity-50 mt-0.5" style={{ color: theme.colors.textDim }}>
							Check for new Maestro versions on startup and once per day while the app is running
						</div>
					</div>
					<ToggleSwitch
						checked={checkForUpdatesOnStartup}
						onChange={setCheckForUpdatesOnStartup}
						theme={theme}
						ariaLabel="Check for updates automatically"
					/>
				</div>

				<div
					data-setting-id="general-beta-updates"
					className="flex items-center justify-between cursor-pointer pt-3 border-t"
					style={{ borderColor: theme.colors.border }}
					onClick={() => setEnableBetaUpdates(!enableBetaUpdates)}
					role="button"
					tabIndex={0}
					onKeyDown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							setEnableBetaUpdates(!enableBetaUpdates);
						}
					}}
				>
					<div className="flex-1 pr-3">
						<div
							className="font-medium flex items-center gap-2"
							style={{ color: theme.colors.textMain }}
						>
							<FlaskConical className="w-4 h-4" />
							Include beta and release candidate updates
						</div>
						<div className="text-xs opacity-50 mt-0.5" style={{ color: theme.colors.textDim }}>
							Opt-in to receive pre-release versions (e.g., v0.11.1-rc, v0.12.0-beta). These may
							contain experimental features and bugs.
						</div>
					</div>
					<ToggleSwitch
						checked={enableBetaUpdates}
						onChange={setEnableBetaUpdates}
						theme={theme}
						ariaLabel="Include beta and release candidate updates"
					/>
				</div>
			</div>
		</div>
	);
}
