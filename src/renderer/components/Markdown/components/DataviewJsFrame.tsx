/**
 * DataviewJsFrame - the host of one `dataviewjs` block (D4, DV-11, DEV-5): an
 * isolated `<webview>` guest that runs the block's script against the vault
 * index, sized to its output and placed inline in the document.
 *
 * Isolation is enforced in MAIN (`src/main/dataview/guest-host.ts`), not here:
 * this component sets only `partition` (one in-memory session per vault root)
 * and `src` (the one guest document) on the tag. Main forces no Node,
 * contextIsolation, the OS sandbox, webSecurity, and the bridge-only preload,
 * serves the document with the D4 CSP, and denies navigation, popups, every
 * permission, and every request off the guest scheme.
 *
 * The bridge. The guest preload forwards guest messages as `ipc-message`
 * events on the tag. Every one goes through `parseSandboxMessage(raw, 'guest')`
 * and is dropped when it fails. The host answers:
 * - `query.dql` through `window.maestro.dataview.query`, the executor DQL
 *   blocks use;
 * - `io.load` through `window.maestro.dataview.readInRoot`, which checks the
 *   path again in main (realpath containment, trust);
 * - `open.link` and `toggle.task` with what `DataviewBlock` uses: the
 *   document scope's `openLink`, `openUrl`, and `toggleDataviewResultTask()`;
 * - `render.done` and `render.error` of the current run only.
 * `query.dql` and `io.load` are answered only while a run is in flight, at
 * most {@link DATAVIEW_JS_MAX_REQUESTS_IN_FLIGHT} at a time, so a script can
 * neither keep main busy after it finished nor flood it while it runs.
 *
 * A run. Once the guest is ready and the index snapshot (`dataview:jsSnapshot`,
 * refused in main unless DataviewJS is on and the root trusted) is in, the host
 * sends `run` and arms a {@link DATAVIEW_JS_RUN_TIMEOUT_MS} wall-clock
 * watchdog. No answer in time, or a guest process that dies, destroys the guest
 * (a new key remounts the tag) and shows the error on this block only; the
 * block then waits for a source change or Run again, rather than burning
 * another five seconds on the next save. A `dataview:changed` event for the
 * snapshot's root fetches a new snapshot (debounced) and runs the script again,
 * keeping the old output on screen until the new run answers.
 *
 * Mounting. A guest mounts only while the block holds one of the window's guest
 * slots, which it asks for only while near the viewport
 * (`src/renderer/services/dataviewJsGuestSlots.ts`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Theme } from '../../../types';
import {
	DATAVIEW_GUEST_URL,
	DATAVIEW_JS_MAX_FRAME_HEIGHT,
	DATAVIEW_JS_RUN_TIMEOUT_MS,
	SANDBOX_TO_GUEST_CHANNEL,
	SANDBOX_TO_HOST_CHANNEL,
	dataviewGuestPartition,
	parseSandboxMessage,
	type SandboxGuestMessage,
} from '../../../../shared/dataview';
import {
	buildPanelThemePayload,
	isPanelThemeColor,
	PANEL_THEME_CHANNEL,
} from '../../../../shared/plugins/panel-theme';
import {
	createIdleWatchdog,
	type IdleWatchdog,
} from '../../../../shared/maestro-lib/control/idle-watchdog';
import { joinPath } from '../../../../shared/formatters';
import { useEventListener } from '../../../hooks/utils/useEventListener';
import { toggleDataviewResultTask } from '../../../services/dataviewTaskToggle';
import { claimDataviewJsGuestSlot } from '../../../services/dataviewJsGuestSlots';
import { openUrl } from '../../../utils/openUrl';
import { logger } from '../../../utils/logger';
import { AlertCallout } from './AlertCallout';
import type { DataviewDocumentScope } from './DataviewDocumentContext';
import {
	ERR_ABORTED,
	answerGuestRequest,
	createGuestRequestQueue,
	dataviewJsGuestFailureText,
	pushToGuest,
	useDataviewJsSnapshot,
	type DataviewJsGuestFailure,
	type GuestIpcMessageEvent,
	type GuestLoadFailEvent,
	type GuestWebviewElement,
} from './dataviewJsGuestBridge';

export { DATAVIEW_JS_MAX_REQUESTS_IN_FLIGHT } from './dataviewJsGuestBridge';

const LOG_CONTEXT = 'DataviewJsFrame';

/** Height of the loading placeholder, as `DataviewBlock` uses. */
const PLACEHOLDER_HEIGHT = '2.5em';

/** How far past the viewport a block starts asking for a guest (clipping scroll containers still apply). */
const NEAR_VIEWPORT_MARGIN = '600px 0px';

export interface DataviewJsFrameProps {
	/** The block's script. */
	code: string;
	theme: Theme;
	/** The note the block sits in. */
	doc: DataviewDocumentScope;
}

/** Why the block shows an error instead of (or above) its output. */
type FrameProblem =
	| { kind: 'script'; message: string }
	| { kind: 'snapshot'; message: string }
	| { kind: DataviewJsGuestFailure };

interface Run {
	runId: string;
	/** The guest the run was sent to. Only it may answer for the run. */
	guest: GuestWebviewElement;
	/** Answered, failed, timed out, or replaced. Requests are refused after. */
	settled: boolean;
	watchdog: IdleWatchdog;
}

let blockCount = 0;
let runCount = 0;

/** The frame height for a reported output height. */
function frameHeight(height: number): number {
	return Math.ceil(Math.min(Math.max(height, 0), DATAVIEW_JS_MAX_FRAME_HEIGHT));
}

/**
 * One `dataviewjs` block's guest. A new note is a new frame: nothing of the old note's guest, snapshot, or run
 * carries over.
 */
export function DataviewJsFrame(props: DataviewJsFrameProps) {
	const { agentId, filePath } = props.doc;
	return <DataviewJsGuestFrame key={`${agentId}\0${filePath}`} {...props} />;
}

function DataviewJsGuestFrame({ code, theme, doc }: DataviewJsFrameProps) {
	const blockId = useMemo(() => `block-${++blockCount}`, []);
	const containerRef = useRef<HTMLDivElement>(null);
	const [hasSlot, setHasSlot] = useState(false);
	const { snapshot, error: snapshotError, snapshotRef } = useDataviewJsSnapshot(doc, hasSlot);
	/** What stopped the last run; a refused snapshot is shown from `snapshotError` instead. */
	const [runProblem, setProblem] = useState<FrameProblem | null>(null);
	/** After a timeout, crash, or failed load: no run until the source changes or the user asks. */
	const [halted, setHalted] = useState(false);
	const [guestKey, setGuestKey] = useState(0);
	const [webview, setWebview] = useState<GuestWebviewElement | null>(null);
	const [readyGuest, setReadyGuest] = useState<GuestWebviewElement | null>(null);
	/** The last output height the guest reported; null before the first output and after a failure. */
	const [height, setHeight] = useState<number | null>(null);
	/** Bumped to run again with the same snapshot (a task toggle that did not write). */
	const [rerunToken, setRerunToken] = useState(0);

	const runRef = useRef<Run | null>(null);
	const [requests] = useState(createGuestRequestQueue);

	const attachWebview = useCallback((element: HTMLElement | null) => {
		setWebview(element as GuestWebviewElement | null);
	}, []);

	/** End a run: stop its watchdog and refuse what it still has waiting in line. Safe to call twice. */
	const settleRun = useCallback(
		(run: Run) => {
			if (run.settled) return;
			run.settled = true;
			run.watchdog.disarm();
			requests.dropRun(run.runId);
		},
		[requests]
	);

	/** Throw the guest away (a new key remounts the tag) and wait for a source change or Run again. */
	const stopGuest = useCallback(
		(next: FrameProblem) => {
			const run = runRef.current;
			if (run) settleRun(run);
			// Nothing may answer for the abandoned run any more, not even a late message.
			runRef.current = null;
			setProblem(next);
			setHalted(true);
			setHeight(null);
			setGuestKey((key) => key + 1);
		},
		[settleRun]
	);

	// --- Guest slots: mount only near the viewport, and never more than the window's cap. ---
	useEffect(() => {
		const claim = claimDataviewJsGuestSlot({
			onGrant: () => setHasSlot(true),
			onEvict: () => setHasSlot(false),
		});
		const element = containerRef.current;
		if (!element || typeof IntersectionObserver === 'undefined') {
			claim.setNear(true);
			return () => claim.release();
		}
		const observer = new IntersectionObserver(
			(entries) => claim.setNear(entries.some((entry) => entry.isIntersecting)),
			{ rootMargin: NEAR_VIEWPORT_MARGIN }
		);
		observer.observe(element);
		return () => {
			observer.disconnect();
			claim.release();
		};
	}, []);

	// The index snapshot comes from `useDataviewJsSnapshot()` above: fetched while the block holds a slot, again
	// on every change to its root, and dropped on eviction or when main refuses it (DataviewJS turned off, the
	// vault no longer trusted), which unmounts the guest too.
	const problem: FrameProblem | null =
		snapshotError !== null ? { kind: 'snapshot', message: snapshotError } : runProblem;

	// No snapshot means no guest: end the run it was rendering, so its watchdog cannot fire on nothing.
	useEffect(() => {
		if (snapshot) return;
		const run = runRef.current;
		if (run) settleRun(run);
	}, [snapshot, settleRun]);

	// --- Guest lifecycle: ready, theme, crash, failed load. ---
	const ready = webview !== null && readyGuest === webview;
	const themePayload = useMemo(() => buildPanelThemePayload(theme), [theme]);

	useEventListener(
		'dom-ready',
		() => {
			if (webview) setReadyGuest(webview);
		},
		{ target: webview }
	);

	useEffect(() => {
		if (ready && webview) pushToGuest(webview, PANEL_THEME_CHANNEL, themePayload);
	}, [ready, webview, themePayload]);

	useEventListener('render-process-gone', () => stopGuest({ kind: 'crashed' }), {
		target: webview,
	});

	useEventListener(
		'did-fail-load',
		(event) => {
			const { errorCode, isMainFrame } = event as GuestLoadFailEvent;
			if (isMainFrame === false || errorCode === ERR_ABORTED) return;
			const run = runRef.current;
			if (run) settleRun(run);
			runRef.current = null;
			// The guest stays: a remount here would fail the same way, over and over. Run again remounts it.
			setProblem({ kind: 'loadFailed' });
			setHalted(true);
		},
		{ target: webview }
	);

	// --- Runs: every new snapshot, source, or guest runs the script again, unless halted. ---
	const codeRef = useRef(code);
	useEffect(() => {
		if (codeRef.current === code) return;
		codeRef.current = code;
		// A changed script deserves a fresh try, whatever stopped the last one.
		setHalted(false);
		setProblem(null);
	}, [code]);

	useEffect(() => {
		if (!ready || !webview || !snapshot || halted) return;
		const previous = runRef.current;
		if (previous) settleRun(previous);
		const runId = `run-${++runCount}`;
		const run: Run = {
			runId,
			guest: webview,
			settled: false,
			watchdog: createIdleWatchdog({
				idleMs: DATAVIEW_JS_RUN_TIMEOUT_MS,
				onIdle: () => {
					if (runRef.current !== run || run.settled) return;
					logger.warn(`A DataviewJS script in ${doc.filePath} timed out`, LOG_CONTEXT);
					stopGuest({ kind: 'timeout' });
				},
			}),
		};
		runRef.current = run;
		const sent = pushToGuest(webview, SANDBOX_TO_GUEST_CHANNEL, {
			type: 'run',
			runId,
			blockId,
			source: code,
			thisPath: snapshot.path,
			snapshot: snapshot.result,
		});
		// The guest went away before it took the run; its replacement's dom-ready runs again.
		if (!sent) settleRun(run);
	}, [
		ready,
		webview,
		snapshot,
		code,
		halted,
		rerunToken,
		blockId,
		doc.filePath,
		settleRun,
		stopGuest,
	]);

	// The watchdog's timer must not outlive the block.
	useEffect(
		() => () => {
			const run = runRef.current;
			if (run) settleRun(run);
		},
		[settleRun]
	);

	// --- Requests: answered only within a run, a few at a time (`createGuestRequestQueue()`). ---

	/** Whether a render answer is for `run`, from the guest the run was sent to, for this block. */
	const answersRun = (
		run: Run,
		guest: GuestWebviewElement,
		answer: { blockId: string; runId: string }
	) => run.guest === guest && answer.blockId === blockId && answer.runId === run.runId;

	const handleGuestMessage = (guest: GuestWebviewElement, message: SandboxGuestMessage) => {
		const run = runRef.current;
		switch (message.type) {
			case 'render.done':
				if (!run || !answersRun(run, guest, message)) return;
				settleRun(run);
				setProblem(null);
				setHeight(frameHeight(message.height));
				return;
			case 'render.error':
				if (!run || !answersRun(run, guest, message)) return;
				settleRun(run);
				setProblem({ kind: 'script', message: message.message });
				setHeight(null);
				return;
			case 'query.dql':
			case 'io.load':
				requests.enqueue(run && !run.settled ? run.runId : null, guest, message.requestId, () =>
					answerGuestRequest(doc, snapshotRef.current, message)
				);
				return;
			case 'eval.result':
				// Inline `$=` answers belong to the note's inline host, never to a block.
				return;
			case 'open.link': {
				if (message.kind === 'url') {
					openUrl(message.url, { ctrlKey: message.newTab });
					return;
				}
				const origin = snapshotRef.current;
				if (origin)
					doc.openLink(joinPath(origin.root, message.path), { openInNewTab: message.newTab });
				return;
			}
			case 'toggle.task': {
				const origin = snapshotRef.current;
				if (!origin) return;
				void toggleDataviewResultTask(doc.toggleOwnTask, origin, {
					path: message.path,
					line: message.line,
					text: message.text,
				}).then((written) => {
					// The guest flipped the box already; a run with the same snapshot puts the truth back.
					if (!written) setRerunToken((token) => token + 1);
				});
				return;
			}
		}
	};

	useEventListener(
		'ipc-message',
		(event) => {
			const { channel, args } = event as GuestIpcMessageEvent;
			if (channel !== SANDBOX_TO_HOST_CHANNEL || !webview) return;
			const parsed = parseSandboxMessage(args?.[0], 'guest');
			if (!parsed.ok) {
				logger.warn(`Dropped a DataviewJS guest message: ${parsed.reason}`, LOG_CONTEXT);
				return;
			}
			handleGuestMessage(webview, parsed.message);
		},
		{ target: webview }
	);

	const runAgain = useCallback(() => {
		setProblem(null);
		setHalted(false);
		setHeight(null);
		setGuestKey((key) => key + 1);
	}, []);

	const partition = snapshot ? dataviewGuestPartition(snapshot.root, snapshot.sshRemoteId) : null;
	const mountGuest = hasSlot && partition !== null;
	const background = isPanelThemeColor(theme.colors.bgMain) ? theme.colors.bgMain : 'transparent';
	const placeholder = (
		<div
			data-dataview-placeholder=""
			aria-busy="true"
			aria-label="Running DataviewJS"
			style={{
				height: PLACEHOLDER_HEIGHT,
				borderRadius: '6px',
				background: theme.colors.bgActivity,
				opacity: 0.5,
			}}
		/>
	);

	return (
		<div
			ref={containerRef}
			className="dataview dataview-js"
			data-dataview-js-block=""
			style={{ margin: '0.5em 0' }}
		>
			{problem && <DataviewJsProblem problem={problem} theme={theme} onRunAgain={runAgain} />}
			{!problem && height === null && placeholder}
			{mountGuest ? (
				<webview
					key={`${partition}:${guestKey}`}
					ref={attachWebview}
					partition={partition}
					src={DATAVIEW_GUEST_URL}
					title="DataviewJS output"
					style={{
						display: 'block',
						width: '100%',
						// At least 1px, so Chromium never treats the guest as hidden and throttles it.
						height: `${Math.max(1, height ?? 0)}px`,
						border: 0,
						backgroundColor: background,
					}}
				/>
			) : (
				height !== null && <div data-dataview-js-spacer="" style={{ height: `${height}px` }} />
			)}
		</div>
	);
}

function DataviewJsProblem({
	problem,
	theme,
	onRunAgain,
}: {
	problem: FrameProblem;
	theme: Theme;
	onRunAgain: () => void;
}) {
	const canRunAgain = problem.kind !== 'script' && problem.kind !== 'snapshot';
	const message =
		problem.kind === 'script' || problem.kind === 'snapshot'
			? problem.message
			: dataviewJsGuestFailureText(problem.kind);
	return (
		<AlertCallout type="caution" theme={theme}>
			<div
				data-dataview-error=""
				data-dataview-js-problem={problem.kind}
				style={{
					whiteSpace: 'pre-wrap',
					fontFamily: 'var(--maestro-font-mono, ui-monospace, SFMono-Regular, monospace)',
					fontSize: '0.85em',
				}}
			>
				{message}
			</div>
			{canRunAgain && (
				<button
					type="button"
					onClick={onRunAgain}
					className="mt-2 px-2 py-0.5 rounded text-xs"
					style={{ border: `1px solid ${theme.colors.border}`, color: theme.colors.textMain }}
				>
					Run again
				</button>
			)}
		</AlertCallout>
	);
}
