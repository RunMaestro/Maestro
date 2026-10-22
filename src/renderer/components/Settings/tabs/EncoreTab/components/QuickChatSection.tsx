import { Keyboard, MessageSquare, PanelTop } from 'lucide-react';
import type { QuickChatDefaultTab, QuickChatSettings } from '../../../../../../shared/quickChat';
import { useSessionStore } from '../../../../../stores/sessionStore';
import type { Theme } from '../../../../../types';
import { KeyCaptureButton } from '../../../../ui/KeyCaptureButton';
import { RadioGroup, type RadioOption } from '../../../../ui/RadioGroup';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from '../../DisplayTab/components/SectionCard';
import { ToggleSettingRow } from '../../DisplayTab/components/ToggleSettingRow';

const DEFAULT_TAB_OPTIONS: ReadonlyArray<RadioOption<QuickChatDefaultTab>> = [
	{
		value: 'auto',
		label: 'Choose tab',
		description:
			'Maestro finds the tab for the first message: an open tab already on its subject, a conversation you closed in the last two weeks, or a new tab when nothing fits.',
	},
	{
		value: 'new',
		label: 'New tab',
		description:
			'Every chat starts in a new tab. Maestro does not look at your other tabs, so the first message sends at once.',
	},
];

interface QuickChatSectionProps {
	theme: Theme;
	quickChatSettings: QuickChatSettings;
	setQuickChatSettings: (settings: QuickChatSettings) => void;
}

/**
 * Quick Chat's settings, shown in its Extensions tile: the system-wide hotkey,
 * the agent chats run on, where a chat's first message goes, and what happens
 * to a chat when the next one starts.
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
			{/* The capture button sits at the right of its heading, in line with the
			    toggles below, rather than floating centered under the text. */}
			<div data-setting-id="encore-quick-chat-hotkey" className="flex items-center gap-4">
				<div className="flex-1 min-w-0">
					<SettingsSectionHeading
						icon={Keyboard}
						description="Opens and closes the Quick Chat window from any app. Leave blank to turn the hotkey off."
					>
						Hotkey
					</SettingsSectionHeading>
				</div>
				<div className="shrink-0">
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

			<div data-setting-id="encore-quick-chat-default-tab">
				<SettingsSectionHeading
					icon={PanelTop}
					description="Where a new chat's first message goes, and the next message after you close the chat's tab. Later messages stay in that tab. You can pick another tab for any message from the window itself."
				>
					Default Tab
				</SettingsSectionHeading>
				<RadioGroup
					value={quickChatSettings.defaultTab}
					onChange={(defaultTab) => update({ defaultTab })}
					options={DEFAULT_TAB_OPTIONS}
					theme={theme}
					ariaLabel="Quick Chat default tab"
				/>
			</div>

			<SectionCard theme={theme}>
				<div data-setting-id="encore-quick-chat-persistent">
					<ToggleSettingRow
						theme={theme}
						title="Keep new chats as tabs"
						description={
							quickChatSettings.persistent
								? 'A tab a chat creates is visible on its agent and stays after you start the next chat.'
								: 'A tab a chat creates is ephemeral: hidden, and deleted when you start the next chat. The bookmark in the window keeps one. Tabs you already had are never touched.'
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
								? 'Ephemeral chats write History entries, so you can find them after the tab is gone, and a later message on the same subject can reopen them.'
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
