import { WrapText } from 'lucide-react';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface MaxOutputLinesSectionProps {
	theme: Theme;
	maxOutputLines: number;
	setMaxOutputLines: (value: number) => void;
}

export function MaxOutputLinesSection({
	theme,
	maxOutputLines,
	setMaxOutputLines,
}: MaxOutputLinesSectionProps) {
	return (
		<div data-setting-id="display-max-output-lines">
			<SettingsSectionHeading icon={WrapText}>Max Output Lines per Response</SettingsSectionHeading>
			<ToggleButtonGroup
				options={[
					{ value: 15 },
					{ value: 25 },
					{ value: 50 },
					{ value: 100 },
					{ value: Infinity, label: 'All' },
				]}
				value={maxOutputLines}
				onChange={setMaxOutputLines}
				theme={theme}
			/>
			<p className="text-xs opacity-50 mt-2">
				Long outputs will be collapsed into a scrollable window. Set to &quot;All&quot; to always
				show full output.
			</p>
		</div>
	);
}
