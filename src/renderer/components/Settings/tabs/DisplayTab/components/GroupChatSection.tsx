import { MessagesSquare } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from './SectionCard';
import { ToggleSettingRow } from './ToggleSettingRow';

interface GroupChatSectionProps {
	theme: Theme;
	groupChatAutoScroll: boolean;
	setGroupChatAutoScroll: (enabled: boolean) => void;
}

export function GroupChatSection({
	theme,
	groupChatAutoScroll,
	setGroupChatAutoScroll,
}: GroupChatSectionProps) {
	return (
		<div data-setting-id="display-group-chat-auto-scroll">
			<SettingsSectionHeading icon={MessagesSquare}>Group Chats</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<ToggleSettingRow
					theme={theme}
					title="Auto-scroll to newest message"
					description="Automatically scroll a group chat to the bottom when new messages arrive. Turn off to keep your scroll position while reading earlier messages."
					checked={groupChatAutoScroll}
					onChange={setGroupChatAutoScroll}
					ariaLabel="Auto-scroll group chats to newest message"
				/>
			</SectionCard>
		</div>
	);
}
