import { Clock, History } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingCheckbox } from '../../../../SettingCheckbox';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface HistorySectionProps {
	theme: Theme;
	defaultSaveToHistory: boolean;
	setDefaultSaveToHistory: (enabled: boolean) => void;
	synopsisDebounceSeconds: number;
	setSynopsisDebounceSeconds: (seconds: number) => void;
}

export function HistorySection({
	theme,
	defaultSaveToHistory,
	setDefaultSaveToHistory,
	synopsisDebounceSeconds,
	setSynopsisDebounceSeconds,
}: HistorySectionProps) {
	return (
		<div data-setting-id="general-history">
			<SettingCheckbox
				icon={History}
				sectionLabel="Default History Toggle"
				title='Enable "History" by default for new tabs'
				description='When enabled, new AI tabs will have the "History" toggle on by default, saving a synopsis after each completion'
				checked={defaultSaveToHistory}
				onChange={setDefaultSaveToHistory}
				theme={theme}
			/>

			{defaultSaveToHistory && (
				<div className="mt-3" data-setting-id="general-synopsis-debounce">
					<SettingsSectionHeading icon={Clock}>Synopsis Debounce</SettingsSectionHeading>
					<ToggleButtonGroup
						options={[
							{ value: 0, label: 'Off' },
							{ value: 15, label: '15s' },
							{ value: 30, label: '30s' },
							{ value: 60, label: '1 min' },
							{ value: 120, label: '2 min' },
						]}
						value={synopsisDebounceSeconds}
						onChange={setSynopsisDebounceSeconds}
						theme={theme}
					/>
					<p className="text-xs opacity-50 mt-2">
						Wait for the agent to be idle this long before generating a History synopsis. Rapid
						back-to-back completions are coalesced into a single synopsis once the conversation
						settles, and turns that did no real work (a plain question and answer with no tool use)
						are skipped entirely. Off generates a synopsis immediately after every completion.
					</p>
				</div>
			)}
		</div>
	);
}
