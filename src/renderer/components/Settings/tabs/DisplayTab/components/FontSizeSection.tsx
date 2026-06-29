import { ALargeSmall } from 'lucide-react';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface FontSizeSectionProps {
	theme: Theme;
	fontSize: number;
	setFontSize: (size: number) => void;
}

export function FontSizeSection({ theme, fontSize, setFontSize }: FontSizeSectionProps) {
	return (
		<div data-setting-id="display-font-size">
			<SettingsSectionHeading icon={ALargeSmall}>Font Size</SettingsSectionHeading>
			<ToggleButtonGroup
				options={[
					{ value: 12, label: 'Small' },
					{ value: 14, label: 'Medium' },
					{ value: 16, label: 'Large' },
					{ value: 18, label: 'X-Large' },
				]}
				value={fontSize}
				onChange={setFontSize}
				theme={theme}
			/>
		</div>
	);
}
