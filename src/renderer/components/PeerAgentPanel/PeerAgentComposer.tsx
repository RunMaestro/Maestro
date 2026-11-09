/**
 * PeerAgentComposer - the composer of a Federation peer's mirrored agent (FED-SSH-06).
 *
 * It types and sends the way the AI composer does for a local agent: Enter or Cmd+Enter per the
 * tab's Enter-to-send setting, Shift+Enter for a newline, an IME guard, trimmed text pastes, an
 * auto-growing box, the shared Send column, and the Stop pill while the tab works. A message to a
 * busy tab waits in the HOST's queue, as a local one waits in the local queue.
 *
 * What it does NOT do is reach anything local. Every send goes through `sendToMirroredTab()` to
 * the main-process mirror service; nothing here touches `sessionStore` or the local execution
 * queue. A send while the peer is disconnected fails at once with a toast and keeps the draft:
 * it is never queued. Slash commands, shell command mode, and image attach are drawn but greyed
 * out, with a tooltip that says why, because the host serves none of them.
 */

import { useCallback, useRef, useState } from 'react';
import { Image as ImageIcon, Slash, Terminal } from 'lucide-react';
import type { Theme } from '../../types';
import type { AITabRecord } from '../../../shared/maestro-lib/store/records';
import { ComposerSendColumn, applyTrimmedTextPaste, clipboardHasImage } from '../ChatComposer';
import { StopTurnButton } from '../ui/StopTurnButton';
import { useAutosizeTextarea } from '../../hooks/ui/useAutosizeTextarea';
import { KEYSTROKE_TEXTAREA_MAX_HEIGHT } from '../../utils/textareaSizing';
import { mirrorDraftKey, usePeerMirrorStore } from '../../stores/peerMirrorStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { notifyToast } from '../../stores/notificationStore';
import { interruptMirroredAgent, sendToMirroredTab } from '../../services/peerMirror';
import { MIRROR_COMPOSER_UNAVAILABLE, mirrorSendBlockReason } from '../../utils/peerMirrorView';

export interface PeerAgentComposerProps {
	theme: Theme;
	peerId: string;
	peerName: string;
	agentId: string;
	agentName: string;
	/** The host's record of the tab the composer sends to. */
	tab: AITabRecord;
}

/** A control the host does not serve: drawn, never clickable, with the reason as its tooltip. */
function UnavailableControl({
	theme,
	title,
	label,
	children,
}: {
	theme: Theme;
	title: string;
	label: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			// `aria-disabled` rather than `disabled`, so the tooltip still shows on hover.
			aria-disabled="true"
			aria-label={label}
			onClick={(e) => e.preventDefault()}
			className="p-1 rounded opacity-30 cursor-not-allowed"
			style={{ color: theme.colors.textDim }}
			title={title}
		>
			{children}
		</button>
	);
}

export function PeerAgentComposer({
	theme,
	peerId,
	peerName,
	agentId,
	agentName,
	tab,
}: PeerAgentComposerProps) {
	const tabId = tab.id;
	const draftKey = mirrorDraftKey(peerId, agentId, tabId);
	const value = usePeerMirrorStore((s) => s.drafts[draftKey] ?? '');
	const enterToSendAI = useSettingsStore((s) => s.enterToSendAI);
	const spellCheck = useSettingsStore((s) => s.spellCheck);
	const enterToSend = tab.enterToSend ?? enterToSendAI;
	const busy = tab.state === 'busy';
	const [sending, setSending] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	useAutosizeTextarea({
		textareaRef: inputRef,
		value,
		maxHeight: KEYSTROKE_TEXTAREA_MAX_HEIGHT,
		resetKey: draftKey,
	});

	const setValue = useCallback(
		(next: string) => usePeerMirrorStore.getState().setMirrorDraft(peerId, agentId, tabId, next),
		[peerId, agentId, tabId]
	);

	const handleSend = useCallback(async () => {
		const text = value.trim();
		if (!text || sending) return;
		const blocked = mirrorSendBlockReason(text);
		if (blocked) {
			notifyToast({ color: 'yellow', title: 'Not sent', message: blocked });
			return;
		}
		setSending(true);
		try {
			// The draft is cleared only once the host took the message, so a refusal (a peer that
			// is down) leaves the text in place for the person to send again.
			if (await sendToMirroredTab(peerId, agentId, tabId, text)) {
				usePeerMirrorStore.getState().setMirrorDraft(peerId, agentId, tabId, '');
			}
		} finally {
			setSending(false);
		}
	}, [value, sending, peerId, agentId, tabId]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
			const modified = e.metaKey || e.ctrlKey;
			if (modified) {
				// Cmd+Enter never reaches the window handler from here, whichever setting is on.
				e.preventDefault();
				e.stopPropagation();
				if (!enterToSend) void handleSend();
				return;
			}
			if (enterToSend && !e.shiftKey) {
				e.preventDefault();
				void handleSend();
			}
		},
		[enterToSend, handleSend]
	);

	const handlePaste = useCallback(
		(e: React.ClipboardEvent<HTMLTextAreaElement>) => {
			if (clipboardHasImage(e.clipboardData)) {
				e.preventDefault();
				notifyToast({
					color: 'yellow',
					title: 'Image not attached',
					message: MIRROR_COMPOSER_UNAVAILABLE.images,
				});
				return;
			}
			applyTrimmedTextPaste(e, value, setValue);
		},
		[value, setValue]
	);

	const sendTitle = busy
		? `Queue on ${peerName}: the agent is busy, so the host runs it next`
		: `Send to ${agentName} on ${peerName}`;

	return (
		<div
			className="border-t shrink-0 px-4 py-3"
			style={{ borderColor: theme.colors.border }}
			data-testid="peer-agent-composer"
		>
			{busy && (
				<div className="flex items-center gap-2 pb-2 text-xs select-none">
					<span
						className="w-2 h-2 rounded-full animate-pulse"
						style={{ backgroundColor: theme.colors.warning }}
					/>
					<span style={{ color: theme.colors.textDim }}>Working on {peerName}</span>
					<StopTurnButton
						theme={theme}
						onClick={() => void interruptMirroredAgent(peerId, agentId, tabId)}
						title={`Stop this turn on ${peerName}`}
					/>
				</div>
			)}
			<div className="flex gap-3 items-end">
				<div
					className="flex-1 flex flex-col rounded-lg border"
					style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
				>
					<textarea
						ref={inputRef}
						value={value}
						onChange={(e) => setValue(e.target.value)}
						onKeyDown={handleKeyDown}
						onPaste={handlePaste}
						onDrop={(e) => {
							if (e.dataTransfer.files.length > 0) e.preventDefault();
						}}
						onFocus={() => useUIStore.getState().setActiveFocus('main')}
						placeholder={
							busy
								? `Type to queue a message on ${peerName}...`
								: `Message ${agentName} on ${peerName}...`
						}
						spellCheck={spellCheck}
						rows={1}
						aria-label={`Message ${agentName} on ${peerName}`}
						className="bg-transparent text-sm outline-none px-3 pt-3 resize-none min-h-[2.5rem] scrollbar-thin"
						style={{ color: theme.colors.textMain, maxHeight: '11rem' }}
					/>
					<div className="flex items-center gap-1 px-2 pb-2 pt-1 select-none">
						<UnavailableControl
							theme={theme}
							title={MIRROR_COMPOSER_UNAVAILABLE.slashCommands}
							label="Slash commands (not available)"
						>
							<Slash className="w-4 h-4" />
						</UnavailableControl>
						<UnavailableControl
							theme={theme}
							title={MIRROR_COMPOSER_UNAVAILABLE.shellMode}
							label="Shell command mode (not available)"
						>
							<Terminal className="w-4 h-4" />
						</UnavailableControl>
						<UnavailableControl
							theme={theme}
							title={MIRROR_COMPOSER_UNAVAILABLE.images}
							label="Attach image (not available)"
						>
							<ImageIcon className="w-4 h-4" />
						</UnavailableControl>
					</div>
				</div>
				<ComposerSendColumn
					theme={theme}
					onSend={() => void handleSend()}
					sendTitle={sendTitle}
					sendDisabled={sending || !value.trim()}
					sendTone={busy ? 'warning' : 'accent'}
				/>
			</div>
		</div>
	);
}
