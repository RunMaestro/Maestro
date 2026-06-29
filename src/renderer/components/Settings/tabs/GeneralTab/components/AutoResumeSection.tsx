import { RotateCcw } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { ToggleSwitch } from '../../../../ui/ToggleSwitch';

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
			<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
				<RotateCcw className="w-3 h-3" />
				Auto-Resume on Limit
			</div>
			<div
				className="p-3 rounded border space-y-3"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div
					data-setting-id="general-auto-resume"
					className="flex items-center justify-between cursor-pointer"
					onClick={() => setAutoResumeOnLimit(!autoResumeOnLimit)}
					role="button"
					tabIndex={0}
					onKeyDown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							setAutoResumeOnLimit(!autoResumeOnLimit);
						}
					}}
				>
					<div className="flex-1 pr-3">
						<div className="font-medium" style={{ color: theme.colors.textMain }}>
							Resume paused sessions when token/API credits are available
						</div>
						<div className="text-xs opacity-50 mt-0.5" style={{ color: theme.colors.textDim }}>
							Maestro probes every provider on a fixed interval and automatically resumes any queued
							work once the limit window reopens. Probing is cheap, so the give-up window is
							intentionally long.
						</div>
					</div>
					<ToggleSwitch
						checked={autoResumeOnLimit}
						onChange={setAutoResumeOnLimit}
						theme={theme}
						ariaLabel="Resume paused sessions when token/API credits are available"
					/>
				</div>

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
