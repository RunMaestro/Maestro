import { ChevronDown } from 'lucide-react';
import type { Theme } from '../../../../../types';
import type { CueSettingsState } from '../types';

interface CueSettingsSectionProps {
	theme: Theme;
	cueState: CueSettingsState;
}

/**
 * Maestro Cue config BODY (extension detail pane, Settings tab). Chromeless:
 * the detail-pane header carries the title/beta badge/state/enable toggle.
 */
export function CueSettingsSection({ theme, cueState }: CueSettingsSectionProps) {
	return (
		<div data-setting-id="encore-cue" className="space-y-4">
			<div className="flex items-center justify-between pt-3">
				<div
					className="text-xs font-bold uppercase opacity-70"
					style={{ color: theme.colors.textMain }}
				>
					Global Cue Settings
				</div>
				{cueState.cueSettingsLoaded && (
					<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
						{cueState.cueSettingsSaveState === 'saving' && <>Saving&hellip;</>}
						{cueState.cueSettingsSaveState === 'saved' && 'Saved'}
						{cueState.cueSettingsSaveState === 'error' && (
							<span style={{ color: theme.colors.error }}>Save failed</span>
						)}
						{cueState.cueSettingsSaveState === 'no-targets' && (
							<span style={{ color: theme.colors.warning }}>
								No cue.yaml yet &mdash; open a pipeline to persist
							</span>
						)}
					</div>
				)}
			</div>

			{!cueState.cueSettingsLoaded ? (
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					Loading settings&hellip;
				</div>
			) : (
				<>
					<div>
						<label
							htmlFor="cue-timeout-minutes"
							className="block text-[11px] font-medium mb-1"
							style={{ color: theme.colors.textDim }}
						>
							Timeout (minutes)
						</label>
						<input
							id="cue-timeout-minutes"
							type="number"
							min={1}
							max={1440}
							value={cueState.cueSettings.timeout_minutes}
							onChange={(event) => cueState.handleTimeoutMinutesChange(event.target.value)}
							className="w-full px-3 py-2 rounded-lg border outline-none text-sm"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
						/>
						<p className="text-[10px] mt-1 opacity-70" style={{ color: theme.colors.textDim }}>
							Maximum time a triggered run can execute before it&apos;s automatically stopped.
							Increase if your tasks regularly need more time.
						</p>
					</div>

					<div>
						<label
							htmlFor="cue-timeout-on-fail"
							className="block text-[11px] font-medium mb-1"
							style={{ color: theme.colors.textDim }}
						>
							On Source Failure
						</label>
						<div className="relative">
							<select
								id="cue-timeout-on-fail"
								value={cueState.cueSettings.timeout_on_fail}
								onChange={(event) =>
									cueState.handleTimeoutOnFailChange(event.target.value as 'break' | 'continue')
								}
								className="w-full px-3 py-2 pr-10 rounded-lg border outline-none appearance-none cursor-pointer text-sm"
								style={{
									backgroundColor: theme.colors.bgMain,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							>
								<option value="break">Break (stop chain)</option>
								<option value="continue">Continue (skip failed)</option>
							</select>
							<ChevronDown
								className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none"
								style={{ color: theme.colors.textDim }}
							/>
						</div>
						<p className="text-[10px] mt-1 opacity-70" style={{ color: theme.colors.textDim }}>
							What to do when a pipeline stage times out or errors. &quot;Break&quot; stops the
							entire chain; &quot;Continue&quot; skips the failed stage and proceeds to the next.
						</p>
					</div>

					<div>
						<label
							htmlFor="cue-max-concurrent"
							className="block text-[11px] font-medium mb-1"
							style={{ color: theme.colors.textDim }}
						>
							Max Concurrent Runs
						</label>
						<input
							id="cue-max-concurrent"
							type="number"
							min={1}
							max={10}
							value={cueState.cueSettings.max_concurrent}
							onChange={(event) => cueState.handleMaxConcurrentChange(event.target.value)}
							className="w-full px-3 py-2 rounded-lg border outline-none text-sm"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
						/>
						<p className="text-[10px] mt-1 opacity-70" style={{ color: theme.colors.textDim }}>
							How many Cue-triggered runs can execute in parallel. Higher values increase throughput
							but agents may conflict on shared files. Default: 1.
						</p>
					</div>

					<div>
						<label
							htmlFor="cue-queue-size"
							className="block text-[11px] font-medium mb-1"
							style={{ color: theme.colors.textDim }}
						>
							Event Queue Size
						</label>
						<input
							id="cue-queue-size"
							type="number"
							min={0}
							max={10000}
							value={cueState.cueQueueSizeStr}
							onChange={(event) => cueState.handleQueueSizeChange(event.target.value)}
							onBlur={cueState.handleQueueSizeBlur}
							className="w-full px-3 py-2 rounded-lg border outline-none text-sm"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
								color: theme.colors.textMain,
							}}
						/>
						<p className="text-[10px] mt-1 opacity-70" style={{ color: theme.colors.textDim }}>
							Events that arrive while the concurrent limit is reached are buffered here. When the
							queue is full, the oldest event is dropped. Set to 0 to disable buffering. Default:
							512.
						</p>
					</div>
				</>
			)}
		</div>
	);
}
