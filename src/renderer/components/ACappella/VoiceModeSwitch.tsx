/**
 * The HUD's mode switch: who the next sentence is for.
 *
 *   - **Tab**: this tab, verbatim. The Conductor stays out of it.
 *   - **Agent**: this agent. The Conductor only picks which of its tabs (the
 *     current one, a new one, or one you name).
 *   - **Conductor**: Maestro picks the agent and the tab.
 *
 * Switching re-binds the live session without ending it; the new mode applies
 * from the next thing you say. The rules, and the Tab key that walks the same
 * three modes, live in `useVoiceModeSwitch`.
 *
 * Drawn as pills that fill the row, each with its own icon, because this is the
 * one control in the HUD that answers "who am I talking to": the mode that is on
 * has to be readable at a glance from across the screen, not found by comparing
 * three tints of the same grey.
 */

import { useVoiceSessionStore } from '../../stores/voiceSessionStore';
import { Bot, PanelTop, Wand2 } from 'lucide-react';

import type { SwitchableVoiceMode } from '../../../shared/acappella/voice-mode';
import type { Theme } from '../../types';
import { SegmentedControl, type SegmentedOption } from '../ui/SegmentedControl';
import { useVoiceModeSwitch } from './useVoiceModeSwitch';

const MODE_OPTIONS: ReadonlyArray<SegmentedOption<SwitchableVoiceMode>> = [
	{
		value: 'tab',
		label: 'Tab',
		icon: PanelTop,
		title: 'Talk to one tab. Everything you say goes there, word for word.',
	},
	{
		value: 'agent',
		label: 'Agent',
		icon: Bot,
		title: 'Talk to one agent. The Conductor picks the tab, or opens a new one when you ask.',
	},
	{
		value: 'conductor',
		label: 'Conductor',
		// The wand is Maestro's own mark, and the Conductor is Maestro routing.
		icon: Wand2,
		title: 'Talk to Maestro. The Conductor picks the agent and the tab.',
	},
];

export function VoiceModeSwitch({
	theme,
	onChange,
}: {
	theme: Theme;
	onChange?: (mode: SwitchableVoiceMode) => void;
}) {
	const { mode, switchTo } = useVoiceModeSwitch();
	const groupChat = useVoiceSessionStore((s) => s.scope?.kind === 'group-chat');
	if (groupChat)
		return (
			<div
				className="px-3 py-2 border-b text-xs"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
			>
				Group Chat · Talking to the moderator
			</div>
		);

	return (
		<div className="px-3 py-2 border-b" style={{ borderColor: theme.colors.border }}>
			<SegmentedControl
				value={mode}
				onChange={onChange ?? switchTo}
				options={MODE_OPTIONS}
				theme={theme}
				ariaLabel="Who you are talking to (Tab switches)"
				testId="voice-hud-mode"
				appearance="pills"
				stretch
			/>
		</div>
	);
}
