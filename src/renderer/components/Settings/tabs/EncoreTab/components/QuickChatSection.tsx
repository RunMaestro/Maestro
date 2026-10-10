import { Keyboard, MessageSquare } from 'lucide-react';
import type { QuickChatSettings } from '../../../../../../shared/quickChat';
import { useSessionStore } from '../../../../../stores/sessionStore';
import type { Theme } from '../../../../../types';
import { KeyCaptureButton } from '../../../../ui/KeyCaptureButton';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from '../../DisplayTab/components/SectionCard';
import { ToggleSettingRow } from '../../DisplayTab/components/ToggleSettingRow';

interface QuickChatSectionProps {
	theme: Theme;
	quickChatSettings: QuickChatSettings;
	setQuickChatSettings: (settings: QuickChatSettings) => void;
}

/**
 * Quick Chat's settings, shown in its Extensions tile: the system-wide hotkey,
 * the agent chats run on, and what happens to a chat when the next one starts.
 */
export function QuickChatSection({
	theme,
	quickChatSettings,
	setQuickChatSettings,
}: QuickChatSectionProps) {
	const agents = useSessionStore((s) => s.sessions).filter((s) => s.toolType !== 'terminal');
	const update = (patch: Partial<QuickChatSettings>) =>
		setQuickChatSettings({ ...quickChatSettings, ...patch });
	const agentMissing =
		quickChatSettings.agentId !== '' && !agents.some((a) => a.id === quickChatSettings.agentId);

	return (
		<div data-setting-id="encore-quick-chat" className="space-y-5 pt-4">
			<div data-setting-id="encore-quick-chat-hotkey">
				<SettingsSectionHeading
					icon={Keyboard}
					description="Opens and closes the Quick Chat window from any app. Leave blank to turn the hotkey off."
				>
					Hotkey
				</SettingsSectionHeading>
				<div className="flex justify-center">
					<KeyCaptureButton
						theme={theme}
						keys={quickChatSettings.hotkey}
						onKeysChange={(hotkey) => update({ hotkey })}
						emptyLabel="Click to set hotkey"
					/>
				</div>
			</div>

			<div data-setting-id="encore-quick-chat-agent">
				<SettingsSectionHeading
					icon={MessageSquare}
					description={
						agentMissing
							? 'The chosen agent no longer exists, so Quick Chat uses the agent active in the main window.'
							: 'The agent every new Quick Chat talks to. You can also switch from the window itself.'
					}
				>
					Agent
				</SettingsSectionHeading>
				<SectionCard theme={theme}>
					<select
						value={agentMissing ? '' : quickChatSettings.agentId}
						onChange={(e) => update({ agentId: e.target.value })}
						aria-label="Quick Chat agent"
						className="w-full p-2 rounded border bg-transparent outline-none text-sm"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
					>
						<option value="">The agent active in the main window</option>
						{agents.map((agent) => (
							<option key={agent.id} value={agent.id}>
								{agent.name}
							</option>
						))}
					</select>
				</SectionCard>
			</div>

			<SectionCard theme={theme}>
				<div data-setting-id="encore-quick-chat-persistent">
					<ToggleSettingRow
						theme={theme}
						title="Keep new chats as tabs"
						description={
							quickChatSettings.persistent
								? 'Each chat is a visible tab on its agent and stays after you start the next one.'
								: 'Each chat is ephemeral: a hidden tab, deleted when you start the next chat. The pin in the window keeps one.'
						}
						checked={quickChatSettings.persistent}
						onChange={(persistent) => update({ persistent })}
						clickableRow
					/>
				</div>
				<div data-setting-id="encore-quick-chat-ephemeral-history">
					<ToggleSettingRow
						theme={theme}
						title="Record ephemeral chats in History"
						description={
							quickChatSettings.ephemeralHistory
								? 'Ephemeral chats write History entries, so you can find them after the tab is gone.'
								: 'Ephemeral chats leave no History entries.'
						}
						checked={quickChatSettings.ephemeralHistory}
						onChange={(ephemeralHistory) => update({ ephemeralHistory })}
						clickableRow
						borderTop
					/>
				</div>
			</SectionCard>
		</div>
	);
}
