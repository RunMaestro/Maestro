import { Cpu } from 'lucide-react';
import type { Theme } from '../../../../../types';
import type { LibraryRuntimeStatus } from '../../../../../../shared/libraryRuntime';
import { ToggleSwitch } from '../../../../ui/ToggleSwitch';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface LibraryRuntimeSectionProps {
	theme: Theme;
	libraryRuntime: boolean;
	setLibraryRuntime: (value: boolean) => void;
	/** What main is doing this run. `null` until it answers. */
	status: LibraryRuntimeStatus | null;
}

export function LibraryRuntimeSection({
	theme,
	libraryRuntime,
	setLibraryRuntime,
	status,
}: LibraryRuntimeSectionProps) {
	// The setting is read once at startup, so the stored value can differ from what this run does.
	const needsRestart = status !== null && status.hosting !== libraryRuntime;

	return (
		<div data-setting-id="general-library-runtime">
			<SettingsSectionHeading icon={Cpu}>Library Runtime (experimental)</SettingsSectionHeading>
			<div
				className="p-3 rounded border space-y-2"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div
					className="flex items-center justify-between cursor-pointer"
					onClick={() => setLibraryRuntime(!libraryRuntime)}
					role="button"
					tabIndex={0}
					onKeyDown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							setLibraryRuntime(!libraryRuntime);
						}
					}}
				>
					<div className="flex-1 pr-3">
						<div className="font-medium" style={{ color: theme.colors.textMain }}>
							Run agent state through the maestro-lib runtime
						</div>
						<div className="text-xs opacity-70 mt-0.5">
							The main process owns agents, groups, and tabs, and every window applies its changes
							instead of keeping its own copy. Work in progress: leave this off until the desktop
							migration lands. Takes effect after a restart.
						</div>
					</div>
					<ToggleSwitch
						checked={libraryRuntime}
						onChange={setLibraryRuntime}
						theme={theme}
						ariaLabel="Run agent state through the maestro-lib runtime"
					/>
				</div>
				{needsRestart && (
					<div className="text-xs" style={{ color: theme.colors.warning }}>
						Restart Maestro to apply.
					</div>
				)}
				{libraryRuntime && status !== null && !status.hosting && status.reason && (
					<div className="text-xs opacity-70">This run is not using it: {status.reason}</div>
				)}
			</div>
		</div>
	);
}
