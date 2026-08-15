/**
 * VoiceDevHarness - type an utterance, watch the whole pipeline run.
 *
 * Development-only, and only with the A Cappella Encore flag on. Until a real
 * microphone lands (Phase 05) this is the only way to drive a session, and it
 * is deliberately the SAME seam: `submitUtterance()` goes through the STT
 * provider's text-in hook, so nothing downstream can tell a typed utterance
 * from a spoken one.
 *
 * Four controls, because the prototype has to prove four distinct behaviours:
 *   - **Send** runs a turn: partials, a route decision, a real tab dispatch.
 *   - **Reply** feeds the session an agent answer. Nothing in Phase 01 produces
 *     one on its own, so without this the demo stops at `dispatch` and speech
 *     is never exercised.
 *   - **Interrupt** is barge-in: it cuts speech and KEEPS the floor.
 *   - **Stop** is the stop word: it ends the session.
 * The last two look alike and are not, which is exactly why both are here.
 */

import { useCallback, useState } from 'react';
import { MessageSquare, Send, Square, Zap } from 'lucide-react';
import type { Theme } from '../../types';
import { readableTextOn } from '../../../shared/colorContrast';
import { isVoiceSessionActive } from '../../../shared/acappella/session-state';
import { useVoiceSessionStore } from '../../stores/voiceSessionStore';
import type { VoiceSessionActions } from './useVoiceSession';

export interface VoiceDevHarnessProps {
	theme: Theme;
	actions: VoiceSessionActions;
}

/** What a reply would look like, so the demo does not need an agent to answer. */
const SAMPLE_REPLY =
	'I refactored the auth middleware to verify the refresh token before issuing a new access token. The two failing tests now pass.';

export function VoiceDevHarness({ theme, actions }: VoiceDevHarnessProps) {
	const state = useVoiceSessionStore((s) => s.state);
	const lastDispatch = useVoiceSessionStore((s) => s.lastDispatch);
	const [text, setText] = useState('');
	const [busy, setBusy] = useState(false);

	const active = isVoiceSessionActive(state);
	const onAccent = readableTextOn(theme.colors.accentForeground, [theme.colors.accent]);

	const run = useCallback(async (fn: () => Promise<unknown>) => {
		setBusy(true);
		try {
			await fn();
		} finally {
			setBusy(false);
		}
	}, []);

	const handleSend = useCallback(() => {
		const utterance = text.trim();
		if (!utterance) return;
		// Starting on demand keeps the "enabling the feature opens no device"
		// promise: nothing runs until the user asks for a turn.
		void run(async () => {
			if (!isVoiceSessionActive(useVoiceSessionStore.getState().state)) {
				await actions.start();
			}
			const accepted = await actions.submitUtterance(utterance);
			if (accepted) setText('');
		});
	}, [actions, run, text]);

	const handleReply = useCallback(() => {
		if (!lastDispatch) return;
		void run(() =>
			actions.submitAgentReply({
				agentSessionId: lastDispatch.agentSessionId,
				tabId: lastDispatch.tabId,
				text: SAMPLE_REPLY,
			})
		);
	}, [actions, lastDispatch, run]);

	return (
		<div
			data-testid="voice-dev-harness"
			className="px-3 py-2 border-t space-y-2"
			style={{ borderColor: theme.colors.border }}
		>
			<div className="flex items-center gap-1.5">
				<input
					data-testid="voice-dev-harness-input"
					aria-label="Utterance"
					value={text}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') handleSend();
					}}
					placeholder="Type an utterance..."
					className="flex-1 min-w-0 px-2 py-1 text-[11px] rounded outline-none border"
					style={{
						backgroundColor: theme.colors.bgMain,
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
				/>
				<HarnessButton
					theme={theme}
					testId="voice-dev-harness-send"
					label="Send"
					title="Run a turn with this utterance"
					disabled={busy || !text.trim()}
					onClick={handleSend}
					icon={<Send className="w-3 h-3" />}
					fill={theme.colors.accent}
					fg={onAccent}
				/>
			</div>

			<div className="flex items-center gap-1.5">
				<HarnessButton
					theme={theme}
					testId="voice-dev-harness-reply"
					label="Reply"
					title="Feed the session a sample agent reply so it speaks"
					disabled={busy || !lastDispatch || state !== 'dispatching'}
					onClick={handleReply}
					icon={<MessageSquare className="w-3 h-3" />}
				/>
				<HarnessButton
					theme={theme}
					testId="voice-dev-harness-interrupt"
					label="Interrupt"
					title="Barge-in: cut the speech, keep the floor"
					disabled={busy || state !== 'speaking'}
					onClick={() => void run(actions.interrupt)}
					icon={<Zap className="w-3 h-3" />}
				/>
				<HarnessButton
					theme={theme}
					testId="voice-dev-harness-stop"
					label="Stop"
					title="Stop word: end the session"
					disabled={busy || !active}
					onClick={() => void run(actions.stop)}
					icon={<Square className="w-3 h-3" />}
				/>
			</div>
		</div>
	);
}

function HarnessButton({
	theme,
	testId,
	label,
	title,
	icon,
	disabled,
	onClick,
	fill,
	fg,
}: {
	theme: Theme;
	testId: string;
	label: string;
	title: string;
	icon: React.ReactNode;
	disabled: boolean;
	onClick: () => void;
	fill?: string;
	fg?: string;
}) {
	return (
		<button
			type="button"
			data-testid={testId}
			title={title}
			disabled={disabled}
			onClick={onClick}
			className="flex items-center gap-1 px-2 py-1 text-[10px] rounded border shrink-0 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
			style={{
				backgroundColor: fill ?? theme.colors.bgMain,
				borderColor: fill ?? theme.colors.border,
				color: fg ?? theme.colors.textDim,
			}}
		>
			{icon}
			{label}
		</button>
	);
}

export default VoiceDevHarness;
