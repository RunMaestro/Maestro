import { AlertTriangle, Camera } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface AutoRunCheckpointsSectionProps {
	theme: Theme;
	autoRunCheckpointsEnabled: boolean;
	setAutoRunCheckpointsEnabled: (enabled: boolean) => void;
	autoRunCheckpointsIncludeIgnored: boolean;
	setAutoRunCheckpointsIncludeIgnored: (enabled: boolean) => void;
}

/**
 * Auto Run task-boundary checkpoints.
 *
 * Off by default, and the copy says why rather than leaving the user to guess:
 * the payoff only shows up on a long unattended run, so charging every user a
 * snapshot per task would be a cost most of them never collect on.
 *
 * The ignored-files sub-toggle only appears once the feature is on. It is
 * meaningless otherwise, and a control that has no effect is worse than an
 * absent one - it reads as a setting that isn't working.
 */
export function AutoRunCheckpointsSection({
	theme,
	autoRunCheckpointsEnabled,
	setAutoRunCheckpointsEnabled,
	autoRunCheckpointsIncludeIgnored,
	setAutoRunCheckpointsIncludeIgnored,
}: AutoRunCheckpointsSectionProps) {
	return (
		<div data-setting-id="general-autorun-checkpoints">
			<SettingsSectionHeading icon={Camera}>Auto Run Checkpoints</SettingsSectionHeading>
			<p className="text-xs opacity-70 mb-3">
				Snapshot the working tree each time an Auto Run task completes, so a long playbook can be
				rewound to any finished step. Snapshots are git objects stored under
				<span className="font-mono"> refs/maestro/checkpoints</span>, not copies of your files, and
				they never move your branch. Browse and restore them from the branch pill&apos;s Checkpoints
				view or with <span className="font-mono">maestro-cli worktree checkpoint</span>.
			</p>

			<div
				className="p-3 rounded border"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div className="font-medium" style={{ color: theme.colors.textMain }}>
					Checkpoint at Task Boundaries
				</div>
				<div className="text-xs opacity-70 mt-0.5 mb-2">
					{autoRunCheckpointsEnabled
						? 'A checkpoint is taken after each completed task. Useful for runs left unattended for hours.'
						: 'Off. Take checkpoints by hand from the branch pill, or turn this on for long unattended runs.'}
				</div>

				<ToggleButtonGroup
					options={[
						{ value: 'off' as const, label: 'Off' },
						{ value: 'on' as const, label: 'Every Task' },
					]}
					value={autoRunCheckpointsEnabled ? 'on' : 'off'}
					onChange={(value) => setAutoRunCheckpointsEnabled(value === 'on')}
					theme={theme}
				/>

				{autoRunCheckpointsEnabled && (
					<div className="mt-3 pt-3 border-t" style={{ borderColor: theme.colors.border }}>
						<div className="font-medium" style={{ color: theme.colors.textMain }}>
							Ignored Files
						</div>
						<div className="text-xs opacity-70 mt-0.5 mb-2">
							{autoRunCheckpointsIncludeIgnored
								? "Checkpoints also capture .gitignore'd files, so a restore brings back your .env and local state."
								: "Checkpoints skip .gitignore'd files. A restore leaves your .env and build output exactly as they are now."}
						</div>

						{autoRunCheckpointsIncludeIgnored && (
							<div
								className="flex items-start gap-1.5 text-xs mb-2"
								style={{ color: theme.colors.warning }}
							>
								<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
								{/* The failure mode is disk, and it arrives weeks later, so it
								    is named here rather than left to be discovered. */}
								<span>
									In a repo that ignores large build output or dependencies, this snapshots all of
									it on every task. Turn it on when ignored files are real state (a .env, a local
									database), not derivable output.
								</span>
							</div>
						)}

						<ToggleButtonGroup
							options={[
								{ value: 'skip' as const, label: 'Skip Ignored' },
								{ value: 'include' as const, label: 'Include Ignored' },
							]}
							value={autoRunCheckpointsIncludeIgnored ? 'include' : 'skip'}
							onChange={(value) => setAutoRunCheckpointsIncludeIgnored(value === 'include')}
							theme={theme}
						/>
					</div>
				)}
			</div>
		</div>
	);
}
