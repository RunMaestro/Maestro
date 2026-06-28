import { Database } from 'lucide-react';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import type { Theme } from '../../../../../types';
import { formatNumber } from '../../../../../../shared/formatters';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface MaxLogBufferSectionProps {
	theme: Theme;
	maxLogBuffer: number;
	setMaxLogBuffer: (value: number) => void;
}

export function MaxLogBufferSection({
	theme,
	maxLogBuffer,
	setMaxLogBuffer,
}: MaxLogBufferSectionProps) {
	return (
		<div data-setting-id="display-max-log-buffer">
			<SettingsSectionHeading icon={Database}>Maximum Log Buffer</SettingsSectionHeading>
			<ToggleButtonGroup
				options={[1000, 5000, 10000, 25000].map((value) => ({
					value,
					label: formatNumber(value),
				}))}
				value={maxLogBuffer}
				onChange={setMaxLogBuffer}
				theme={theme}
			/>
			<p className="text-xs opacity-50 mt-2">
				Maximum number of entries to retain for history and system log viewer. Older entries are
				automatically discarded as new ones arrive.
			</p>
		</div>
	);
}
