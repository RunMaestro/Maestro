import { AlignHorizontalJustifyCenter } from 'lucide-react';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface MessageAlignmentSectionProps {
	theme: Theme;
	userMessageAlignment: 'left' | 'right' | null | undefined;
	setUserMessageAlignment: (value: 'left' | 'right') => void;
}

export function MessageAlignmentSection({
	theme,
	userMessageAlignment,
	setUserMessageAlignment,
}: MessageAlignmentSectionProps) {
	return (
		<div data-setting-id="display-message-alignment">
			<SettingsSectionHeading icon={AlignHorizontalJustifyCenter}>
				User Message Alignment
			</SettingsSectionHeading>
			<ToggleButtonGroup
				options={[
					{ value: 'left', label: 'Left' },
					{ value: 'right', label: 'Right' },
				]}
				value={userMessageAlignment ?? 'right'}
				onChange={setUserMessageAlignment}
				theme={theme}
			/>
			<p className="text-xs opacity-50 mt-2">
				Position your messages on the left or right side of the chat. AI responses appear on the
				opposite side.
			</p>
		</div>
	);
}
