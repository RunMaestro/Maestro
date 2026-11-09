/**
 * ComposerVoiceSessionButton - the A Cappella microphone under a composer's
 * Send button.
 *
 * It opens a voice session bound to the surface (an agent, or a group chat).
 * It is not dictation: dictation types into the draft (DictationButton), while
 * a session listens, routes and speaks back. The surface decides what a click
 * does and whether the button is drawn at all (the A Cappella Encore Feature
 * owns it), so both composers render the same control.
 */

import { memo } from 'react';
import { Mic } from 'lucide-react';
import type { Theme } from '../../types';

export interface ComposerVoiceSessionButtonProps {
	theme: Theme;
	/** True while this surface holds the voice floor. */
	active: boolean;
	/** Start (or, with `activeLabel`, end) the session. Stable identity. */
	onToggle: () => void;
	/** Accessible name and tooltip while idle, e.g. "Talk to this agent". */
	label: string;
	/**
	 * Accessible name while active. Set it when a click ends the session, so an
	 * open microphone never reads the same as a shut one.
	 */
	activeLabel?: string;
	testId?: string;
}

export const ComposerVoiceSessionButton = memo(function ComposerVoiceSessionButton({
	theme,
	active,
	onToggle,
	label,
	activeLabel,
	testId,
}: ComposerVoiceSessionButtonProps) {
	const name = active && activeLabel ? activeLabel : label;
	return (
		<button
			type="button"
			data-testid={testId}
			onClick={onToggle}
			className={`p-2 rounded-lg border transition-all focus:outline-none focus-visible:ring-2 ${active ? 'animate-pulse' : ''}`}
			style={{
				backgroundColor: active ? `${theme.colors.accent}20` : theme.colors.bgMain,
				borderColor: active ? theme.colors.accent : theme.colors.border,
				color: active ? theme.colors.accent : theme.colors.textDim,
			}}
			title={name}
			aria-label={name}
			aria-pressed={active}
		>
			<Mic className="w-4 h-4" />
		</button>
	);
});
