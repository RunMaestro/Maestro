import { RotateCcw } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { ToggleSettingRow } from '../../DisplayTab/components/ToggleSettingRow';

interface AutoResumeSectionProps {
	theme: Theme;
	autoResumeOnLimit: boolean;
	setAutoResumeOnLimit: (enabled: boolean) => void;
	autoResumeCheckIntervalHours: number;
	setAutoResumeCheckIntervalHours: (hours: number) => void;
	autoResumeGiveUpDays: number;
	setAutoResumeGiveUpDays: (days: number) => void;
}

export function AutoResumeSection({
	theme,
	autoResumeOnLimit,
	setAutoResumeOnLimit,
	autoResumeCheckIntervalHours,
	setAutoResumeCheckIntervalHours,
	autoResumeGiveUpDays,
	setAutoResumeGiveUpDays,
}: AutoResumeSectionProps) {
	return (
		<div>
			<SettingsSectionHeading icon={RotateCcw}>Auto-Resume on Limit</SettingsSectionHeading>
			<div
				className="p-3 rounded border space-y-3"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<ToggleSettingRow
					theme={theme}
					title={
						<span className="font-medium" style={{ color: theme.colors.textMain }}>
							Resume paused sessions when token/API credits are available
						</span>
					}
					description={
						<span style={{ color: theme.colors.textDim }}>
							Maestro probes every provider on a fixed interval and automatically resumes any queued
							work once the limit window reopens. Probing is cheap, so the give-up window is
							intentionally long.
						</span>
					}
					checked={autoResumeOnLimit}
					onChange={setAutoResumeOnLimit}
					ariaLabel="Resume paused sessions when token/API credits are available"
					clickableRow
					data-setting-id="general-auto-resume"
				/>

				{autoResumeOnLimit && (
					<div
						data-setting-id="general-auto-resume-interval"
						className="pt-3 border-t flex flex-wrap items-center gap-4"
						style={{ borderColor: theme.colors.border }}
					>
						<div className="flex items-center gap-2">
							<label className="text-xs opacity-60" style={{ color: theme.colors.textDim }}>
								Check for availability every (hours)
							</label>
							<input
								type="number"
								min={1}
								value={autoResumeCheckIntervalHours}
								onChange={(e) =>
									setAutoResumeCheckIntervalHours(Math.max(1, parseInt(e.target.value, 10) || 1))
								}
								className="w-20 p-1.5 rounded border bg-transparent outline-none text-xs"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							/>
						</div>
						<div className="flex items-center gap-2">
							<label className="text-xs opacity-60" style={{ color: theme.colors.textDim }}>
								Give up after (days)
							</label>
							<input
								type="number"
								min={1}
								value={autoResumeGiveUpDays}
								onChange={(e) =>
									setAutoResumeGiveUpDays(Math.max(1, parseInt(e.target.value, 10) || 1))
								}
								className="w-20 p-1.5 rounded border bg-transparent outline-none text-xs"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							/>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
