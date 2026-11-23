/**
 * PeerAgentComposer - the composer of a hosted agent (a Federation peer's agent, FED-SSH-06).
 *
 * It is the shared `ChatComposer`, the same shell the local AI composer and the Group Chat
 * composer draw through, so a hosted agent's composer looks and types like a local one: Enter or
 * Cmd+Enter per the Enter-to-send setting, the IME guard, verbatim text pastes, image paste, drop,
 * and Attach Image with the staged-images strip, voice, the read-only, save to History, model, and
 * effort pills, and the Send column. The Thinking pill sits above it, as it does for a local agent,
 * and its Stop stops this tab's turn on the host. A message to a busy tab waits in the HOST's
 * queue, as a local one waits in the local queue.
 *
 * What it does NOT do is reach anything local. Every send goes through `sendToMirroredTab()` to
 * the main-process mirror service, with the staged images as data URLs; nothing here touches
 * `sessionStore` or the local execution queue. A send while the peer is disconnected fails at once
 * with a toast and keeps the draft and the images: it is never queued. A slash command is refused
 * with a notice, because it would reach the host's provider as plain text.
 *
 * The model, effort, read-only, and save to History pills are THIS conductor's own choice for the
 * tab (`hostedAgentSettingsStore.tabChoices`). They ride along on each message sent from here
 * (`TurnOverrides`) and are never written to the host tab, so another conductor on the same tab
 * keeps theirs. The agent's own defaults, which every conductor shares, are in Edit Agent.
 */

import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import type { Theme } from '../../types';
import type { AgentRecord, AITabRecord } from '../../../shared/maestro-lib/store/records';
import type { TurnOverrides } from '../../../shared/maestro-lib/client/types';
import { getAgentCapabilities } from '../../../shared/maestro-lib/providers/capabilities';
import { useHostedAgentSettingsStore } from '../../stores/hostedAgentSettingsStore';
import {
	resolveModelEffort,
	useAgentModelEffortOptions,
} from '../../hooks/agent/useAgentModelEffortOptions';
import { useModelEffortMenus } from '../InputArea/hooks/useModelEffortMenus';
import {
	ChatComposer,
	deriveAiComposerCapabilities,
	stageImageFiles,
	type ChatComposerToolbarProps,
} from '../ChatComposer';
import type { PermissionMode } from '../InputArea/components/ComposerOptionsSheet';
import { ThinkingStatusPill } from '../ThinkingStatusPill';
import { mirrorDraftKey, usePeerMirrorStore } from '../../stores/peerMirrorStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { notifyToast } from '../../stores/notificationStore';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { interruptMirroredAgent, sendToMirroredTab } from '../../services/peerMirror';
import { jumpToAgent } from '../../services/agentNavigation';
import { useThinkingItems } from '../../hooks/session/useThinkingItems';
import { mirrorKey } from '../../../shared/maestro-lib/client/peer-mirror';
import { mirrorSendBlockReason } from '../../utils/peerMirrorView';
import { imageFilesIn } from '../../utils/imageData';
import { getAgentDisplayName } from '../../../shared/agentMetadata';

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
	/** The app's image lightbox, for the staged-images strip. */
	onOpenLightbox?: (image: string, contextImages?: string[], source?: 'staged' | 'history') => void;
}

const EMPTY_IMAGES: string[] = [];

function flash(message: string): void {
	notifyCenterFlash({ message, color: 'yellow' });
}

export function PeerAgentComposer({
	theme,
	peerId,
	peerName,
	agentId,
	agentName,
	agent,
	tab,
	onOpenLightbox,
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
	const setEnterToSendAI = useSettingsStore((s) => s.setEnterToSendAI);
	const enterToSend = tab.enterToSend ?? enterToSendAI;
	const busy = tab.state === 'busy';
	const [sending, setSending] = useState(false);
	const thinkingItems = useThinkingItems();

	// Staged images, per host tab, so switching tabs keeps what each one has staged.
	const [imagesByDraft, setImagesByDraft] = useState<Record<string, string[]>>({});
	const stagedImages = imagesByDraft[draftKey] ?? EMPTY_IMAGES;
	const setStagedImages: Dispatch<SetStateAction<string[]>> = useCallback(
		(next) =>
			setImagesByDraft((all) => {
				const prev = all[draftKey] ?? EMPTY_IMAGES;
				const resolvedNext = typeof next === 'function' ? next(prev) : next;
				return { ...all, [draftKey]: resolvedNext };
			}),
		[draftKey]
	);

	// The agent's own provider decides what the composer offers, as it does for a local agent.
	// Nothing runs in command mode here, and the host has no tab to stream reasoning settings to.
	const capabilities = useMemo(() => {
		const provider = getAgentCapabilities(agent.toolType);
		return {
			...deriveAiComposerCapabilities({
				inputMode: 'ai',
				commandMode: 'off',
				isResumingSession: !!tab.agentSessionId,
				hasCapability: (capability) => provider[capability] === true,
				supportsThinking: false,
			}),
			// Uploading puts files on the web-desktop's own host, not the agent's.
			upload: false,
		};
	}, [agent.toolType, tab.agentSessionId]);

	const setValue = useCallback(
		(next: string) => usePeerMirrorStore.getState().setMirrorDraft(peerId, agentId, tabId, next),
		[peerId, agentId, tabId]
	);

	const handleSend = useCallback(async () => {
		const text = value.trim();
		const images = stagedImages;
		if ((!text && images.length === 0) || sending) return;
		const blocked = mirrorSendBlockReason(text);
		if (blocked) {
			notifyToast({ color: 'yellow', title: 'Not sent', message: blocked });
			return;
		}
		setSending(true);
		try {
			// The draft and the images are cleared only once the host took the message, so a refusal
			// (a peer that is down) leaves them in place for the person to send again.
			if (await sendToMirroredTab(peerId, agentId, tabId, text, choice, images)) {
				usePeerMirrorStore.getState().setMirrorDraft(peerId, agentId, tabId, '');
				setStagedImages(EMPTY_IMAGES);
			}
		} finally {
			setSending(false);
		}
	}, [value, stagedImages, sending, peerId, agentId, tabId, choice, setStagedImages]);

	const stageFiles = useCallback(
		(files: File[]) =>
			stageImageFiles(files, {
				setStagedImages,
				showFlashNotification: flash,
				reportComponent: 'PeerAgentComposer',
			}),
		[setStagedImages]
	);

	// ChatComposer hands over only a paste that carries an image; a text paste lands natively.
	const handlePaste = useCallback(
		(e: React.ClipboardEvent<HTMLTextAreaElement>) => {
			e.preventDefault();
			if (!capabilities.imageAttach) {
				flash(`${agentName} cannot read images`);
				return;
			}
			stageFiles(imageFilesIn(e.clipboardData));
		},
		[capabilities.imageAttach, agentName, stageFiles]
	);

	const handleDrop = useCallback(
		(e: React.DragEvent<HTMLTextAreaElement>) => {
			e.stopPropagation();
			const files = imageFilesIn(e.dataTransfer);
			if (e.dataTransfer.files.length === 0) return;
			e.preventDefault();
			if (files.length === 0) return;
			if (!capabilities.imageAttach) {
				flash(`${agentName} cannot read images`);
				return;
			}
			stageFiles(files);
		},
		[capabilities.imageAttach, agentName, stageFiles]
	);

	const permissionMode: PermissionMode = readOnly ? 'readonly' : 'full';
	const toolbarProps: ChatComposerToolbarProps = {
		agentId: agent.toolType,
		permissionMode,
		onPermissionModeChange: (mode) => setChoice({ readOnly: mode === 'readonly' }),
		tabSaveToHistory: saveToHistory,
		onToggleTabSaveToHistory: () => setChoice({ saveToHistory: !saveToHistory }),
		currentModel: resolved.model,
		currentEffort: resolved.effort,
		availableModels: modelOptions.models,
		availableEfforts: modelOptions.efforts,
		onModelChange: (model) => setChoice({ model }),
		onEffortChange: (effort) => setChoice({ effort }),
		onRefreshModels: () => void modelOptions.refreshModels(),
		refreshingModels: modelOptions.refreshingModels,
		...menus,
	};

	const hasDraft = value.trim().length > 0 || stagedImages.length > 0;

	return (
		<div className="shrink-0" data-testid="peer-agent-composer">
			<ChatComposer
				theme={theme}
				value={value}
				onChange={setValue}
				draftKey={draftKey}
				capabilities={capabilities}
				isBusy={busy}
				warningBorder={readOnly}
				placeholder={`Talking to ${agentName} powered by ${getAgentDisplayName(agent.toolType)}`}
				stagedImages={stagedImages}
				setStagedImages={setStagedImages}
				imageInputId={`peer-image-input-${draftKey}`}
				imageReportComponent="PeerAgentComposer"
				onOpenLightbox={onOpenLightbox}
				enterToSend={enterToSend}
				setEnterToSend={setEnterToSendAI}
				isolateFromWindowKeys
				onPaste={handlePaste}
				onDrop={handleDrop}
				showFlashNotification={flash}
				toolbarProps={toolbarProps}
				onSubmit={() => void handleSend()}
				sendTitle={
					busy
						? `Queue on ${peerName}: the agent is busy, so the host runs it next`
						: `Send to ${agentName}`
				}
				sendDisabled={sending || !hasDraft}
				aboveComposer={
					/* The same pill a local agent's composer shows. A hosted entry opens its view; a
					   local one jumps to that agent. Stop on this tab's entry stops it on the host. */
					<ThinkingStatusPill
						thinkingItems={thinkingItems}
						theme={theme}
						onSessionClick={(sessionId, targetTabId) => {
							jumpToAgent(sessionId, targetTabId ? { tabId: targetTabId } : {});
						}}
						activeSessionId={mirrorKey(peerId, agentId)}
						activeTabId={tabId}
						onInterrupt={
							busy ? () => void interruptMirroredAgent(peerId, agentId, tabId) : undefined
						}
					/>
				}
			/>
		</div>
	);
}
