import { Clock, Timer } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface AutoRunInactivitySectionProps {
	theme: Theme;
	autoRunInactivityTimeoutMin: number;
	setAutoRunInactivityTimeoutMin: (minutes: number) => void;
	autoRunMaxTaskDurationMin: number;
	setAutoRunMaxTaskDurationMin: (minutes: number) => void;
}

export function AutoRunInactivitySection({
	theme,
	autoRunInactivityTimeoutMin,
	setAutoRunInactivityTimeoutMin,
	autoRunMaxTaskDurationMin,
	setAutoRunMaxTaskDurationMin,
}: AutoRunInactivitySectionProps) {
	return (
		<>
			<div data-setting-id="general-autorun-inactivity-timeout">
				<SettingsSectionHeading icon={Clock}>Auto Run Inactivity Timeout</SettingsSectionHeading>
				<ToggleButtonGroup
					options={[
						{ value: 30, label: '30 min' },
						{ value: 60, label: '1 hr' },
						{ value: 240, label: '4 hr' },
						{ value: 480, label: '8 hr' },
						{ value: 0, label: 'Unlimited' },
					]}
					value={autoRunInactivityTimeoutMin}
					onChange={setAutoRunInactivityTimeoutMin}
					theme={theme}
				/>
				<p className="text-xs opacity-50 mt-2">
					Auto Run force-kills a task if the agent produces no output for this long. Increase for
					long refactors, heavy test runs, or web-research tasks driving a browser. Choose Unlimited
					to disable the inactivity watchdog; the Max Task Duration cap below still applies unless
					it is also set to Unlimited.
				</p>
			</div>
			<div data-setting-id="general-autorun-max-task-duration">
				<SettingsSectionHeading icon={Timer}>Auto Run Max Task Duration</SettingsSectionHeading>
				<ToggleButtonGroup
					options={[
						{ value: 60, label: '1 hr' },
						{ value: 240, label: '4 hr' },
						{ value: 480, label: '8 hr' },
						{ value: 720, label: '12 hr' },
						{ value: 0, label: 'Unlimited' },
					]}
					value={autoRunMaxTaskDurationMin}
					onChange={setAutoRunMaxTaskDurationMin}
					theme={theme}
				/>
				<p className="text-xs opacity-50 mt-2">
					Absolute cap on how long a single task may run, regardless of output. Unlike the
					inactivity timeout, this also catches an agent that keeps emitting output but never
					finishes - which would otherwise hang the whole multi-document run. Choose Unlimited to
					disable the cap.
				</p>
			</div>
		</>
	);
}
