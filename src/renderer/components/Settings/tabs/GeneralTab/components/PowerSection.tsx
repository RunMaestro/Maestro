import { Battery } from 'lucide-react';
import { isLinux } from '../../../../../../shared/platformDetection';
import { isMacOSPlatform } from '../../../../../utils/platformUtils';
import type { Theme } from '../../../../../types';
import { ToggleSwitch } from '../../../../ui/ToggleSwitch';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface PowerSectionProps {
	theme: Theme;
	preventSleepEnabled: boolean;
	setPreventSleepEnabled: (enabled: boolean) => void;
	preventDisplaySleepEnabled: boolean;
	setPreventDisplaySleepEnabled: (enabled: boolean) => void;
}

export function PowerSection({
	theme,
	preventSleepEnabled,
	setPreventSleepEnabled,
	preventDisplaySleepEnabled,
	setPreventDisplaySleepEnabled,
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

				{/*
				 * Display sleep is a separate, stronger claim than staying awake.
				 * It is what stops the screen saver, the screen lock, and idle
				 * logout - and on macOS it is also what tells the OS a human is
				 * present, which parks discretionary maintenance. Off by default,
				 * and only meaningful while the parent toggle holds a blocker.
				 */}
				<div data-setting-id="general-display-sleep">
					<div
						className={`flex items-center justify-between pl-3 border-l ${
							preventSleepEnabled ? 'cursor-pointer' : 'opacity-50'
						}`}
						style={{ borderColor: theme.colors.border }}
						onClick={() => {
							if (preventSleepEnabled) setPreventDisplaySleepEnabled(!preventDisplaySleepEnabled);
						}}
						role="button"
						tabIndex={preventSleepEnabled ? 0 : -1}
						aria-disabled={!preventSleepEnabled}
						onKeyDown={(e) => {
							if (!preventSleepEnabled) return;
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								setPreventDisplaySleepEnabled(!preventDisplaySleepEnabled);
							}
						}}
					>
						<div className="flex-1 pr-3">
							<div className="font-medium" style={{ color: theme.colors.textMain }}>
								Keep the display awake
							</div>
							<div className="text-xs opacity-50 mt-0.5">
								Also blocks the screen saver, the screen lock, and idle logout, so a long run stays
								on screen and you stay signed in
							</div>
						</div>
						<ToggleSwitch
							checked={preventDisplaySleepEnabled}
							onChange={setPreventDisplaySleepEnabled}
							theme={theme}
							disabled={!preventSleepEnabled}
							ariaLabel="Keep the display awake"
							title={
								preventSleepEnabled
									? undefined
									: 'Turn on "Prevent sleep while working" to use this'
							}
						/>
					</div>

					{/* macOS maintenance warning */}
					{isMacOSPlatform() && preventSleepEnabled && preventDisplaySleepEnabled && (
						<div
							className="text-xs p-2 rounded mt-2"
							style={{
								backgroundColor: theme.colors.warning + '15',
								color: theme.colors.warning,
							}}
						>
							Warning: macOS reads a lit display as you sitting at the machine, so routine
							housekeeping stays parked while agents work - Spotlight indexing, Photos analysis,
							XProtect scans, Time Machine thinning, and background updates. In exchange the session
							stays active: no screen saver, no lock screen, no idle logout.
						</div>
					)}
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
