/**
 * PeerAgentComposer - the composer of a Federation peer's mirrored agent (FED-SSH-06).
 *
 * It types and sends the way the AI composer does for a local agent: Enter or Cmd+Enter per the
 * tab's Enter-to-send setting, Shift+Enter for a newline, an IME guard, trimmed text pastes, an
 * auto-growing box, the shared Send column, and the same Thinking pill above it, which lists every
 * busy tab (local and mirrored) and stops this tab's turn on the host. A message to a busy tab
 * waits in the HOST's queue, as a local one waits in the local queue.
 *
 * What it does NOT do is reach anything local. Every send goes through `sendToMirroredTab()` to
 * the main-process mirror service; nothing here touches `sessionStore` or the local execution
 * queue. A send while the peer is disconnected fails at once with a toast and keeps the draft:
 * it is never queued. Slash commands, shell command mode, and image attach are drawn but greyed
 * out, with a tooltip that says why, because the host serves none of them.
 *
 * The model, effort, read-only, and save to History chips are THIS conductor's own choice for
 * the tab (`hostedAgentSettingsStore.tabChoices`). They ride along on each message sent from here
 * (`TurnOverrides`) and are never written to the host tab, so another conductor on the same tab
 * keeps theirs. The agent's own defaults, which every conductor shares, are in Edit Agent.
 */

import { useCallback, useRef, useState } from 'react';
import { Eye, History, Image as ImageIcon, Slash, Terminal } from 'lucide-react';
import type { Theme } from '../../types';
import type { AgentRecord, AITabRecord } from '../../../shared/maestro-lib/store/records';
import type { TurnOverrides } from '../../../shared/maestro-lib/client/types';
import { useHostedAgentSettingsStore } from '../../stores/hostedAgentSettingsStore';
import {
	resolveModelEffort,
	useAgentModelEffortOptions,
} from '../../hooks/agent/useAgentModelEffortOptions';
import { ModelEffortPills } from '../InputArea/components/ModelEffortPills';
import { useModelEffortMenus } from '../InputArea/hooks/useModelEffortMenus';
import { ComposerSendColumn, clipboardHasImage } from '../ChatComposer';
import { ThinkingStatusPill } from '../ThinkingStatusPill';
import { useAutosizeTextarea } from '../../hooks/ui/useAutosizeTextarea';
import { handleComposerSendKey } from '../../hooks/input/composerKeyDown';
import { KEYSTROKE_TEXTAREA_MAX_HEIGHT } from '../../utils/textareaSizing';
import { mirrorDraftKey, usePeerMirrorStore } from '../../stores/peerMirrorStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { notifyToast } from '../../stores/notificationStore';
import { interruptMirroredAgent, sendToMirroredTab } from '../../services/peerMirror';
import { jumpToAgent } from '../../services/agentNavigation';
import { useThinkingItems } from '../../hooks/session/useThinkingItems';
import { mirrorKey } from '../../../shared/maestro-lib/client/peer-mirror';
import { MIRROR_COMPOSER_UNAVAILABLE, mirrorSendBlockReason } from '../../utils/peerMirrorView';

export interface PeerAgentComposerProps {
	theme: Theme;
	peerId: string;
	peerName: string;
	agentId: string;
	agentName: string;
	/** The host's record of the agent: its provider and shared defaults. */
	agent: AgentRecord;
	/** The host's record of the tab the composer sends to. */
	tab: AITabRecord;
}

/** A composer chip this conductor toggles for their own messages. */
function ChoiceChip({
	theme,
	active,
	tone,
	onClick,
	title,
	children,
}: {
	theme: Theme;
	active: boolean;
	tone: string;
	onClick: () => void;
	title: string;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			aria-pressed={active}
			className={`flex items-center gap-1.5 text-2xs px-2 py-1 rounded-full cursor-pointer transition-all whitespace-nowrap ${
				active ? '' : 'opacity-40 hover:opacity-70'
			}`}
			style={{
				backgroundColor: active ? `${tone}25` : 'transparent',
				color: active ? tone : theme.colors.textDim,
				border: active ? `1px solid ${tone}50` : '1px solid transparent',
			}}
			title={title}
		>
			{children}
		</button>
	);
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
	agent,
	tab,
}: PeerAgentComposerProps) {
	const tabId = tab.id;
	const draftKey = mirrorDraftKey(peerId, agentId, tabId);
	const choice = useHostedAgentSettingsStore((s) => s.tabChoices[draftKey]);
	const modelOptions = useAgentModelEffortOptions(agent.toolType);
	const menus = useModelEffortMenus();
	const resolved = resolveModelEffort(
		{
			customModel: choice?.model ?? tab.customModel,
			customEffort: choice?.effort ?? tab.customEffort,
		},
		agent,
		modelOptions
	);
	const readOnly = choice?.readOnly ?? tab.readOnlyMode === true;
	const saveToHistory = choice?.saveToHistory ?? tab.saveToHistory === true;
	const setChoice = useCallback(
		(patch: Partial<TurnOverrides>) => {
			const store = useHostedAgentSettingsStore.getState();
			store.setTabChoice(draftKey, { ...(store.tabChoices[draftKey] ?? {}), ...patch });
		},
		[draftKey]
	);
	const value = usePeerMirrorStore((s) => s.drafts[draftKey] ?? '');
	const enterToSendAI = useSettingsStore((s) => s.enterToSendAI);
	const spellCheck = useSettingsStore((s) => s.spellCheck);
	const enterToSend = tab.enterToSend ?? enterToSendAI;
	const busy = tab.state === 'busy';
	const [sending, setSending] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const thinkingItems = useThinkingItems();

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
			if (await sendToMirroredTab(peerId, agentId, tabId, text, choice)) {
				usePeerMirrorStore.getState().setMirrorDraft(peerId, agentId, tabId, '');
			}
		} finally {
			setSending(false);
		}
	}, [value, sending, peerId, agentId, tabId, choice]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			handleComposerSendKey(e, {
				enterToSend,
				send: () => void handleSend(),
				inputRef,
				isolateFromWindowKeys: true,
			});
		},
		[enterToSend, handleSend]
	);

	const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
		if (clipboardHasImage(e.clipboardData)) {
			e.preventDefault();
			notifyToast({
				color: 'yellow',
				title: 'Image not attached',
				message: MIRROR_COMPOSER_UNAVAILABLE.images,
			});
			return;
		}
		// A text paste lands verbatim (native paste, no trimming).
	}, []);

	const sendTitle = busy
		? `Queue on ${peerName}: the agent is busy, so the host runs it next`
		: `Send to ${agentName} on ${peerName}`;

	return (
		<div
			className="border-t shrink-0 px-4 py-3"
			style={{ borderColor: theme.colors.border }}
			data-testid="peer-agent-composer"
		>
			{/* The same pill a local agent's composer shows. A mirrored entry opens its mirror; a local
			    one jumps to that agent. Stop on this tab's entry stops it on the host. */}
			<ThinkingStatusPill
				thinkingItems={thinkingItems}
				theme={theme}
				onSessionClick={(sessionId, targetTabId) => {
					jumpToAgent(sessionId, targetTabId ? { tabId: targetTabId } : {});
				}}
				activeSessionId={mirrorKey(peerId, agentId)}
				activeTabId={tabId}
				onInterrupt={busy ? () => void interruptMirroredAgent(peerId, agentId, tabId) : undefined}
			/>
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
						<span className="flex-1" />
						<ChoiceChip
							theme={theme}
							active={readOnly}
							tone={theme.colors.warning}
							onClick={() => setChoice({ readOnly: !readOnly })}
							title="Read-only for your messages on this tab. Yours only: other conductors keep their own."
						>
							<Eye className="w-3 h-3" />
							<span>Read-only</span>
						</ChoiceChip>
						<ChoiceChip
							theme={theme}
							active={saveToHistory}
							tone={theme.colors.accent}
							onClick={() => setChoice({ saveToHistory: !saveToHistory })}
							title="Save your messages' turns to History on the host. Yours only."
						>
							<History className="w-3 h-3" />
							<span>History</span>
						</ChoiceChip>
						<ModelEffortPills
							isVisible
							theme={theme}
							currentModel={resolved.model}
							currentEffort={resolved.effort}
							availableModels={modelOptions.models}
							availableEfforts={modelOptions.efforts}
							onModelChange={(model) => setChoice({ model })}
							onEffortChange={(effort) => setChoice({ effort })}
							onRefreshModels={() => void modelOptions.refreshModels()}
							refreshingModels={modelOptions.refreshingModels}
							{...menus}
						/>
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
