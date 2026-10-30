/**
 * The Sketch Book tab view (spec sections 2 and 7): an Excalidraw canvas over
 * the sketch's live session in `sketchSessionStore`.
 *
 * The view owns nothing that must outlive it. The scene, the author map and
 * the dirty flag live in the session, so unmounting (switching, tiling,
 * snoozing, closing the tab) loses no stroke; a pending autosave is flushed on
 * the way out.
 *
 * Excalidraw itself loads lazily (`React.lazy` over `loadExcalidraw()`), so
 * no Excalidraw code ships until a sketch opens, and always with the bundled
 * fonts in place. Its main menu is `SketchMainMenu` (no Excalidraw links).
 * Excalidraw's dialogs (Help, export, Mermaid) get Maestro's ESC pill from
 * `ExcalidrawDialogEscHost`, since Excalidraw draws no close button on desktop.
 * On the canvas Excalidraw wins a key clash, except Maestro's tab switching,
 * Quick Actions and Switch Agent (`useSketchKeyboard.ts`).
 *
 * Changes the view did not make (an agent's writes, T5-T8) arrive through the
 * session's `externalRevision` and are merged into Excalidraw by version, as
 * a remote update (not undoable here). An agent's `sketch_focus` (T11) waits
 * in the session until a mounted view scrolls to it; its chat posts (T12)
 * show in the chat pane. A shared sketch's room notice (a close code, a
 * reconnect; `sketchRoomClient.ts`) shows above the canvas, and so does the
 * reason a room was put back on `conductor` when its screen became unusable
 * while collaborators could ask the agent (spec section 8.3, rule 2). The
 * canvas badges the room's screening value ("Local screening", "Cloud
 * screening: Jev"), and a banner counts the guest requests the screen could
 * not check (Y4).
 *
 * The chat pane also holds the conductor's decisions on `@bot` (spec section
 * 5): a guest's request waits on its approval chip (Run / Deny, at most three
 * per link), a held reply on "Publish anyway", and a conductor message that
 * ran restricted offers "Run with full access" (Q2). Every button calls the
 * same relay functions `maestro-cli sketch approve|deny|escalate|publish|
 * discard` reach. It is the Collaborate panel's Chat tab, offered whenever
 * the sketch has a room or holds anything, and ends in the composer: plain
 * messages go to the room, `@bot` asks the agent (`sendSketchConductorChat()`,
 * which `maestro-cli sketch chat` reaches). The panel opens on Chat when the
 * chat first has something to show, and again whenever a guest request or a
 * held reply arrives, since both wait on the conductor; messages that arrive
 * while Chat is not showing are counted on its tab.
 *
 * The Collaborate button at the canvas's top right, the main menu's
 * Collaborate item and its chord (`sketchBookCollaborate`) open the
 * Collaborate panel (`SketchSharePanel.tsx`): sharing, and once shared the
 * room too (links with Copy, Reset, Revoke and Unsuspend, members with Kick
 * and Unlock, flagged elements, Reset all access). The button sits inside the
 * canvas (`SketchCanvasChrome.tsx`); the screening badge sits at the center
 * of the canvas footer, and Library moves to the footer beside Help. While an
 * agent works on the sketch (a running `@bot` turn, from a guest on the web or
 * from the conductor, or a sketch tool call in a turn still running), a
 * working pill sits beside Collaborate (`useSketchAgentWork()`).
 * Opening a shared sketch joins its room when this
 * window has no client for it yet (`ensureSketchRoomConnected()`), which is
 * how a room comes back after a restart.
 */

import React from 'react';
import { X } from 'lucide-react';
import type {
	AppState,
	BinaryFiles,
	ExcalidrawImperativeAPI,
	ExcalidrawProps,
} from '@excalidraw/excalidraw/types';
import type { Theme } from '../../types';
import { mergeNewerSketchElements } from '../../../shared/sketch/agent-writes';
import type { SketchWireElement } from '../../../shared/sketch/payloads';
import { Spinner } from '../ui/Spinner';
import { useDebouncedCallback } from '../../hooks/utils/useThrottle';
import { visibleSketchApprovals } from '../../../shared/sketch/bot-requests';
import {
	SKETCH_AUTOSAVE_DEBOUNCE_MS,
	canEscalateSketchMessage,
	sketchGuestEdited,
	useSketchSessionStore,
} from '../../stores/sketchSessionStore';
import { loadExcalidraw } from './excalidrawAssets';
import { SketchMainMenu } from './SketchMainMenu';
import { ExcalidrawDialogEscHost } from './ExcalidrawDialogClose';
import { useSketchKeyboard } from './useSketchKeyboard';
import { SketchFooter, SketchTopRightUI, type SketchCanvasChrome } from './SketchCanvasChrome';
import { SketchChatPane } from './SketchChatPane';
import { sketchAgentWorkLabel, useSketchAgentWork } from './useSketchAgentWork';
import { SketchSharePanel, type CollaborateTab } from './SketchSharePanel';
import { useElementWidth } from '../../hooks/ui/useElementWidth';
import { SketchScreenOutageBanner, SketchScreeningBadge } from './SketchRoomScreening';
import { shortcutText } from '../ui/ShortcutHint';
import { FIXED_SHORTCUTS } from '../../constants/shortcuts';
import { eventMatchesShortcutKeys } from '../../utils/shortcutMatch';
import { trackShortcutUsage } from '../../utils/shortcutTracking';
import { ensureSketchRoomConnected } from '../../services/sketchSharing';
import { dismissSketchBotPolicyNotice } from '../../services/sketchBotPolicy';
import { discardHeldSketchReply, publishHeldSketchReply } from '../../services/sketchBotTurns';
import {
	approveSketchBotRequest,
	denySketchBotRequest,
	escalateSketchBotRequest,
	sendSketchConductorChat,
} from '../../services/sketchBotRelay';

interface SketchCanvasProps extends ExcalidrawProps {
	chrome: SketchCanvasChrome;
	/** The room's screening badge for the footer, or null. */
	badge: React.ReactNode;
}

const Excalidraw = React.lazy(() =>
	loadExcalidraw().then(({ Excalidraw: Canvas, Footer, MainMenu, Sidebar }) => {
		function SketchCanvas({ chrome, badge, ...props }: SketchCanvasProps) {
			const renderTopRightUI = React.useCallback(
				() => <SketchTopRightUI chrome={chrome} />,
				[chrome]
			);
			const { onToggle: onCollaborate, shortcut: collaborateShortcut } = chrome.collaborate;
			// Excalidraw re-renders whenever its children change identity.
			const children = React.useMemo(
				() => (
					<>
						<SketchMainMenu
							MainMenu={MainMenu}
							onCollaborate={onCollaborate}
							collaborateShortcut={collaborateShortcut}
						/>
						<SketchFooter Footer={Footer} Sidebar={Sidebar} badge={badge} />
					</>
				),
				[onCollaborate, collaborateShortcut, badge]
			);
			return (
				<Canvas {...props} renderTopRightUI={renderTopRightUI}>
					{children}
				</Canvas>
			);
		}
		return { default: SketchCanvas };
	})
);

/** The Collaborate chord, as the menu and the button title show it. */
const COLLABORATE_SHORTCUT_KEYS = FIXED_SHORTCUTS.sketchBookCollaborate.keys;

/** Excalidraw's theme for a Maestro theme: light stays light, everything else is dark. */
export function excalidrawThemeFor(theme: Theme): 'light' | 'dark' {
	return theme.mode === 'light' ? 'light' : 'dark';
}

type OnChange = NonNullable<ExcalidrawProps['onChange']>;

export interface SketchTabViewProps {
	sketchId: string;
	theme: Theme;
}

function CenteredState({ theme, children }: { theme: Theme; children: React.ReactNode }) {
	return (
		<div
			className="flex-1 flex items-center justify-center"
			style={{ backgroundColor: theme.colors.bgMain }}
		>
			{children}
		</div>
	);
}

export function SketchTabView({ sketchId, theme }: SketchTabViewProps) {
	const status = useSketchSessionStore((s) => s.sessions[sketchId]?.status);
	const loadError = useSketchSessionStore((s) => s.sessions[sketchId]?.loadError ?? null);
	const saveError = useSketchSessionStore((s) => s.sessions[sketchId]?.saveError ?? null);
	const externalRevision = useSketchSessionStore(
		(s) => s.sessions[sketchId]?.externalRevision ?? 0
	);
	const focusRequest = useSketchSessionStore((s) => s.sessions[sketchId]?.focusRequest ?? null);
	const chat = useSketchSessionStore((s) => s.sessions[sketchId]?.chat);
	const botRequests = useSketchSessionStore((s) => s.sessions[sketchId]?.botRequests);
	const heldReplies = React.useMemo(
		() => (botRequests ?? []).filter((request) => request.status === 'held'),
		[botRequests]
	);
	const { approvals, waitingApprovals } = React.useMemo(() => {
		const requests = botRequests ?? [];
		const { visible, waiting } = visibleSketchApprovals(requests);
		const running = requests.filter(
			(request) => request.status === 'running' && request.actor.kind === 'guest'
		);
		return {
			approvals: [...running, ...visible].sort((a, b) => a.ts - b.ts),
			waitingApprovals: waiting.length,
		};
	}, [botRequests]);
	const guestEdited = useSketchSessionStore((s) => sketchGuestEdited(s.sessions[sketchId]));
	const escalatable = React.useMemo(() => {
		const session = useSketchSessionStore.getState().sessions[sketchId];
		return new Set(
			(chat ?? [])
				.filter((message) => canEscalateSketchMessage(session, message))
				.map((message) => message.id)
		);
		// `guestEdited` and `botRequests` decide the answer; the session is read fresh.
	}, [sketchId, chat, botRequests, guestEdited]);
	const roomNotice = useSketchSessionStore((s) => s.sessions[sketchId]?.room?.notice ?? null);
	const roomConnection = useSketchSessionStore(
		(s) => s.sessions[sketchId]?.room?.connection ?? null
	);
	const botPolicyNotice = useSketchSessionStore(
		(s) => s.sessions[sketchId]?.room?.botPolicyNotice ?? null
	);
	const roomScreening = useSketchSessionStore((s) => {
		const room = s.sessions[sketchId]?.room;
		return room && room.connection !== 'stopped' ? room.screening.server : null;
	});
	const roomStats = useSketchSessionStore((s) => s.sessions[sketchId]?.room?.stats ?? null);
	const agentWork = useSketchAgentWork(sketchId);
	const working = agentWork ? sketchAgentWorkLabel(agentWork) : null;
	const [api, setApi] = React.useState<ExcalidrawImperativeAPI | null>(null);
	const [canvas, setCanvas] = React.useState<HTMLDivElement | null>(null);
	useSketchKeyboard(canvas);
	const [collaborateOpen, setCollaborateOpen] = React.useState(false);
	const [collaborateTab, setCollaborateTab] = React.useState<CollaborateTab>('chat');
	const rowRef = React.useRef<HTMLDivElement>(null);
	// The row mounts once the sketch is ready; measure from then on.
	const rowWidth = useElementWidth(rowRef, status === 'ready');
	const chatCount = chat?.length ?? 0;
	const chatOffered =
		roomConnection !== null || chatCount > 0 || heldReplies.length > 0 || approvals.length > 0;
	const chatShowing = collaborateOpen && collaborateTab === 'chat';
	const [chatSeen, setChatSeen] = React.useState(chatCount);
	React.useEffect(() => {
		if (chatShowing) setChatSeen(chatCount);
	}, [chatShowing, chatCount]);
	const chatUnread = chatShowing ? 0 : Math.max(0, chatCount - chatSeen);

	// Bring Chat forward when it first has something, and on each new request
	// or held reply: both wait on the conductor, who may have closed the panel.
	const waitingOnConductor = approvals.length + heldReplies.length;
	const shownChat = React.useRef({ offered: false, waiting: 0 });
	React.useEffect(() => {
		const previous = shownChat.current;
		shownChat.current = { offered: chatOffered, waiting: waitingOnConductor };
		if ((chatOffered && !previous.offered) || waitingOnConductor > previous.waiting) {
			setCollaborateOpen(true);
			setCollaborateTab('chat');
		}
	}, [chatOffered, waitingOnConductor]);

	const toggleCollaborate = React.useCallback(() => setCollaborateOpen((open) => !open), []);
	const chrome = React.useMemo<SketchCanvasChrome>(
		() => ({
			collaborate: {
				open: collaborateOpen,
				live: roomConnection === 'live',
				shortcut: shortcutText(COLLABORATE_SHORTCUT_KEYS),
				onToggle: toggleCollaborate,
			},
			working,
		}),
		[collaborateOpen, roomConnection, toggleCollaborate, working]
	);
	const badge = React.useMemo(
		() => (roomScreening ? <SketchScreeningBadge screening={roomScreening} theme={theme} /> : null),
		[roomScreening, theme]
	);

	// Sketch Book: Collaborate. Capture phase, so Excalidraw's own key handling
	// never sees the chord; scoped to this tab, so a second Sketch tab in a tile
	// keeps its own panel.
	const handleKeyDownCapture = React.useCallback(
		(event: React.KeyboardEvent) => {
			if (!eventMatchesShortcutKeys(event, COLLABORATE_SHORTCUT_KEYS)) return;
			event.preventDefault();
			event.stopPropagation();
			toggleCollaborate();
			trackShortcutUsage('sketchBookCollaborate');
		},
		[toggleCollaborate]
	);

	React.useEffect(() => {
		void useSketchSessionStore.getState().openSketchSession(sketchId);
	}, [sketchId]);

	React.useEffect(() => {
		if (status === 'ready') void ensureSketchRoomConnected(sketchId);
	}, [sketchId, status]);

	const { debouncedCallback: scheduleSave } = useDebouncedCallback(
		() => {
			void useSketchSessionStore.getState().saveSketchSession(sketchId);
		},
		SKETCH_AUTOSAVE_DEBOUNCE_MS,
		{ flushOnUnmount: true }
	);

	const handleChange = React.useCallback<OnChange>(
		(elements, appState: AppState, files: BinaryFiles) => {
			const result = useSketchSessionStore.getState().applyLocalChange(sketchId, {
				elements: elements as unknown as readonly SketchWireElement[],
				appState: appState as unknown as Record<string, unknown>,
				files: files as unknown as Record<string, unknown>,
			});
			if (!result.changed) return;
			// Put the stamp on Excalidraw's own element objects too, in place: the
			// stamp belongs to the version just made, so it must not bump it (an
			// `updateScene` would re-render and fire this handler again). Every
			// later Excalidraw edit carries `customData` forward.
			if (result.stamped.length > 0) {
				const stampById = new Map(result.stamped.map((element) => [element.id, element]));
				for (const element of elements) {
					const stamped = stampById.get(element.id);
					if (stamped) (element as { customData?: unknown }).customData = stamped.customData;
				}
			}
			scheduleSave();
		},
		[sketchId, scheduleSave]
	);

	// Pull in what the session changed without this view (agent writes). Also
	// runs once the API is ready, for a write that landed while Excalidraw
	// loaded. Same versions merge to nothing, so the view's own edits never
	// come back as an update.
	React.useEffect(() => {
		if (!api) return;
		let cancelled = false;
		void loadExcalidraw().then(({ CaptureUpdateAction }) => {
			if (cancelled) return;
			const scene = useSketchSessionStore.getState().sessions[sketchId]?.scene;
			if (!scene) return;
			const viewElements = api.getSceneElementsIncludingDeleted() as unknown as SketchWireElement[];
			const merged = mergeNewerSketchElements(viewElements, scene.elements);
			const changed =
				merged.length !== viewElements.length ||
				merged.some((element, index) => element !== viewElements[index]);
			if (!changed) return;
			api.updateScene({
				elements: merged as unknown as Parameters<
					ExcalidrawImperativeAPI['updateScene']
				>[0]['elements'],
				captureUpdate: CaptureUpdateAction.NEVER,
			});
		});
		return () => {
			cancelled = true;
		};
	}, [api, sketchId, externalRevision]);

	// An agent's `sketch_focus`: scroll and zoom to the elements, then clear it.
	React.useEffect(() => {
		if (!api || !focusRequest) return;
		const wanted = new Set(focusRequest.elementIds);
		const targets = api.getSceneElements().filter((element) => wanted.has(element.id));
		if (targets.length > 0) api.scrollToContent(targets, { fitToContent: true, animate: true });
		useSketchSessionStore.getState().clearSketchFocus(sketchId, focusRequest.nonce);
	}, [api, sketchId, focusRequest]);

	// Read once per mount: Excalidraw owns the canvas after that, and the
	// session catches every change through `onChange`.
	const initialData = React.useMemo<ExcalidrawProps['initialData']>(() => {
		if (status !== 'ready') return null;
		const scene = useSketchSessionStore.getState().sessions[sketchId]?.scene;
		if (!scene) return null;
		return {
			// Copies: Excalidraw mutates its elements in place, and the session's
			// synced scene must keep the versions it last saw.
			elements: scene.elements.map((element) => ({ ...element })),
			appState: scene.appState,
			files: scene.files,
			scrollToContent: true,
		} as unknown as ExcalidrawProps['initialData'];
	}, [sketchId, status]);

	if (status === 'error') {
		return (
			<CenteredState theme={theme}>
				<div className="flex flex-col items-center gap-3 max-w-md text-center select-text">
					<div className="text-sm font-medium" style={{ color: theme.colors.error }}>
						This sketch could not be opened.
					</div>
					<div className="text-xs" style={{ color: theme.colors.textDim }}>
						{loadError}
					</div>
					<button
						type="button"
						className="px-3 py-1 rounded text-xs"
						style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
						onClick={() => void useSketchSessionStore.getState().openSketchSession(sketchId)}
					>
						Try again
					</button>
				</div>
			</CenteredState>
		);
	}

	const spinner = (
		<CenteredState theme={theme}>
			<Spinner size={24} color={theme.colors.accent} />
		</CenteredState>
	);
	if (status !== 'ready') return spinner;

	return (
		<div
			className="flex-1 min-w-0 min-h-0 relative flex flex-col"
			data-sketch-id={sketchId}
			style={{ backgroundColor: theme.colors.bgMain }}
			onKeyDownCapture={handleKeyDownCapture}
		>
			{saveError && (
				<div
					className="px-3 py-1 text-xs select-text"
					role="alert"
					style={{ color: theme.colors.error, borderBottom: `1px solid ${theme.colors.border}` }}
				>
					Not saved: {saveError}
				</div>
			)}
			{roomNotice && (
				<div
					className="px-3 py-1 text-xs select-text"
					role={roomNotice.tone === 'info' ? 'status' : 'alert'}
					data-sketch-room-notice={roomNotice.closeCode ?? ''}
					style={{
						color:
							roomNotice.tone === 'error'
								? theme.colors.error
								: roomNotice.tone === 'warning'
									? theme.colors.warning
									: theme.colors.textDim,
						borderBottom: `1px solid ${theme.colors.border}`,
					}}
				>
					{roomNotice.text}
				</div>
			)}
			{botPolicyNotice && (
				<div
					className="px-3 py-1 text-xs flex items-center justify-between gap-2"
					role="alert"
					data-sketch-bot-policy-notice=""
					style={{ color: theme.colors.warning, borderBottom: `1px solid ${theme.colors.border}` }}
				>
					<span className="select-text">{botPolicyNotice}</span>
					<button
						type="button"
						aria-label="Dismiss"
						className="p-0.5 rounded hover:bg-white/10"
						onClick={() => dismissSketchBotPolicyNotice(sketchId)}
					>
						<X className="w-3.5 h-3.5" />
					</button>
				</div>
			)}
			<SketchScreenOutageBanner stats={roomStats} theme={theme} />
			<ExcalidrawDialogEscHost theme={theme} />
			<div className="flex-1 min-h-0 flex" ref={rowRef}>
				<div className="flex-1 min-w-0 relative">
					<div className="absolute inset-0" ref={setCanvas}>
						<React.Suspense fallback={spinner}>
							<Excalidraw
								key={sketchId}
								initialData={initialData}
								onChange={handleChange}
								excalidrawAPI={setApi}
								theme={excalidrawThemeFor(theme)}
								UIOptions={{ canvasActions: { saveToActiveFile: false } }}
								chrome={chrome}
								badge={badge}
							/>
						</React.Suspense>
					</div>
				</div>
				{collaborateOpen && (
					<SketchSharePanel
						sketchId={sketchId}
						theme={theme}
						onClose={() => setCollaborateOpen(false)}
						tab={collaborateTab}
						onTabChange={setCollaborateTab}
						chatUnread={chatUnread}
						availableWidth={rowWidth}
						chat={
							chatOffered ? (
								<SketchChatPane
									messages={chat ?? []}
									theme={theme}
									heldReplies={heldReplies}
									onPublishHeld={(replyTo) => publishHeldSketchReply(sketchId, replyTo)}
									onDiscardHeld={(replyTo) => discardHeldSketchReply(sketchId, replyTo)}
									approvals={approvals}
									waitingApprovals={waitingApprovals}
									onRunRequest={(replyTo) => approveSketchBotRequest(sketchId, replyTo)}
									onDenyRequest={(replyTo) => denySketchBotRequest(sketchId, replyTo)}
									escalatable={escalatable}
									onEscalate={(replyTo) => escalateSketchBotRequest(sketchId, replyTo)}
									onSend={(text) => sendSketchConductorChat(sketchId, text)}
									shared={roomConnection !== null}
								/>
							) : undefined
						}
					/>
				)}
			</div>
		</div>
	);
}
