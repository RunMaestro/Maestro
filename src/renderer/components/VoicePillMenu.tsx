/**
 * VoicePillMenu - dropdown for the header's voice pill.
 *
 * The third surface of `useVoiceAgentActions`, alongside the Left Bar
 * right-click menu and the command palette. Same hook, same entries, so "Talk to
 * this agent" cannot mean one thing in the header and another in the palette.
 *
 * Rendered through a PORTAL, not inline next to the pill. `absolute top-full`
 * inside the Main Panel header is silently clipped: the header wraps its left
 * cluster in `overflow-hidden` boxes only as tall as the pill. Bare
 * `position: fixed` does not help either, because `.header-container` sets
 * `container-type: inline-size`, which makes the header a containing block for
 * fixed descendants. `useAnchoredMenuPosition` is the one answer to both.
 */

import { memo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Mic, ScrollText, Square, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAnchoredMenuPosition } from '../hooks/ui/useAnchoredMenuPosition';
import { useClickOutside } from '../hooks/ui/useClickOutside';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import type { Theme } from '../types';

export interface VoicePillMenuProps {
	theme: Theme;
	/**
	 * The pill element. Used both to place the menu beneath it and to exclude it
	 * from click-outside, so clicking the pill again toggles instead of
	 * closing-then-reopening.
	 */
	anchorRef: React.RefObject<HTMLElement | null>;
	/** Name of the agent the header is showing. */
	agentName: string;
	/** True when the live voice session is bound to this agent. */
	hasVoiceFloor: boolean;
	/** This agent's wake phrase, shown so the mapping is discoverable. */
	wakePhrase: string | null;
	transcriptVisible: boolean;
	onTalkToAgent: () => void;
	onTalkToConductor: () => void;
	onToggleTranscript: () => void;
	onEndSession: () => void;
	onClose: () => void;
}

function MenuRow({
	theme,
	icon,
	label,
	hint,
	onClick,
	testId,
}: {
	theme: Theme;
	icon: ReactNode;
	label: string;
	hint?: string | null;
	onClick: () => void;
	testId: string;
}) {
	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors outline-none focus-visible:ring-2"
			style={{ color: theme.colors.textMain }}
			data-testid={testId}
			role="menuitem"
		>
			{icon}
			<span className="truncate">{label}</span>
			{hint && (
				<span
					className="ml-auto text-[10px] opacity-60 truncate max-w-[120px]"
					style={{ color: theme.colors.textDim }}
				>
					{hint}
				</span>
			)}
		</button>
	);
}

export const VoicePillMenu = memo(function VoicePillMenu({
	theme,
	anchorRef,
	agentName,
	hasVoiceFloor,
	wakePhrase,
	transcriptVisible,
	onTalkToAgent,
	onTalkToConductor,
	onToggleTranscript,
	onEndSession,
	onClose,
}: VoicePillMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const { left, top, ready } = useAnchoredMenuPosition(menuRef, anchorRef);

	useModalLayer(MODAL_PRIORITIES.VOICE_PILL_MENU, 'Voice Pill Menu', onClose);
	useClickOutside([menuRef, anchorRef], onClose, true, { delay: true, eventType: 'click' });

	const iconStyle = { color: theme.colors.textDim };

	return createPortal(
		<div
			ref={menuRef}
			className="fixed z-[100] rounded shadow-xl overflow-hidden whitespace-nowrap select-none p-1"
			style={{
				left,
				top,
				opacity: ready ? 1 : 0,
				backgroundColor: theme.colors.bgSidebar,
				border: `1px solid ${theme.colors.border}`,
				minWidth: '13rem',
			}}
			role="menu"
			aria-label="Voice"
			data-testid="voice-pill-menu"
		>
			<MenuRow
				theme={theme}
				icon={<Mic className="w-3.5 h-3.5" style={iconStyle} />}
				label={`Talk to ${agentName}`}
				hint={wakePhrase ? `"${wakePhrase}"` : null}
				onClick={onTalkToAgent}
				testId="voice-pill-talk-agent"
			/>
			<MenuRow
				theme={theme}
				icon={<Users className="w-3.5 h-3.5" style={iconStyle} />}
				label="Talk to the Conductor"
				onClick={onTalkToConductor}
				testId="voice-pill-talk-conductor"
			/>
			<MenuRow
				theme={theme}
				icon={<ScrollText className="w-3.5 h-3.5" style={iconStyle} />}
				label={transcriptVisible ? 'Hide the transcript' : 'Show the transcript'}
				onClick={onToggleTranscript}
				testId="voice-pill-transcript"
			/>
			{/* Only offered when there is something to end. A row that ends nothing
			    is a row that teaches people the menu does nothing. */}
			{hasVoiceFloor && (
				<MenuRow
					theme={theme}
					icon={<Square className="w-3.5 h-3.5" style={iconStyle} />}
					label="End voice session"
					onClick={onEndSession}
					testId="voice-pill-end"
				/>
			)}
		</div>,
		document.body
	);
});

export default VoicePillMenu;
