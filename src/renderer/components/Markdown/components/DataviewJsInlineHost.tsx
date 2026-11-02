/**
 * DataviewJsInlineHost - the one hidden guest that evaluates every inline `` `$= expr` `` span of a note (D4,
 * DV-11, DEV-5).
 *
 * A `<webview>` is one rectangle, so it cannot place output between host markdown lines. Inline spans therefore
 * share one hidden guest per note: each span registers its expression with the note's
 * {@link DataviewJsInlineStore}; the host sends the pending expressions to the guest as one `eval` run, and the
 * guest answers `eval.result` per expression, in order, with a value in the wire form. The span renders that
 * value with the DQL value renderer (`DataviewValue`), so a link or a date looks the way an inline `= expr` shows
 * it.
 *
 * The guest is the same isolated document a `dataviewjs` block runs in, hardened the same way in main (see
 * `DataviewJsFrame`), and it holds one of the window's guest slots. The bridge is the shared one
 * (`dataviewJsGuestBridge.ts`): every guest message is validated with `parseSandboxMessage(raw, 'guest')`, and
 * `query.dql` and `io.load` are answered only while a run is in flight. Links and tasks have no visible output
 * here, so `open.link` and `toggle.task` are dropped.
 *
 * The watchdog. Each expression gets {@link DATAVIEW_JS_RUN_TIMEOUT_MS} of wall clock: the watchdog is armed with
 * {@link DATAVIEW_JS_INDEX_TIMEOUT_MS} when the run starts (the guest builds the index first), again with the
 * script budget on the run's first `index.ready` (a later one is ignored), and afresh after each answer, never
 * touched. The expression that runs out of time (the
 * first one without an answer), or that is running when the guest process dies, shows the error and stops until
 * its span remounts or its source changes; the guest is destroyed (a new key remounts the tag) and the rest of
 * the run goes to the new guest.
 *
 * Refresh. A `dataview:changed` event for the snapshot's root fetches a new snapshot (debounced like DQL blocks)
 * and evaluates every span again, keeping the old values on screen until the new ones arrive.
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react';
import {
	DATAVIEW_GUEST_URL,
	DATAVIEW_JS_INDEX_TIMEOUT_MS,
	DATAVIEW_JS_RUN_TIMEOUT_MS,
	SANDBOX_TO_GUEST_CHANNEL,
	SANDBOX_TO_HOST_CHANNEL,
	dataviewGuestPartition,
	fromWireValue,
	parseSandboxMessage,
	type Literal,
	type SandboxEvalOutcome,
	type SandboxGuestMessage,
} from '../../../../shared/dataview';
import {
	createIdleWatchdog,
	type IdleWatchdog,
} from '../../../../shared/maestro-lib/control/idle-watchdog';
import { useEventListener } from '../../../hooks/utils/useEventListener';
import { claimDataviewJsGuestSlot } from '../../../services/dataviewJsGuestSlots';
import { logger } from '../../../utils/logger';
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

const LOG_CONTEXT = 'DataviewJsInlineHost';

/** What one inline `$=` span shows. */
export type DataviewJsInlineOutcome =
	/** The expression's value, and the vault root its links resolve against. */
	| { kind: 'value'; value: Literal; root: string }
	/** The expression gave `undefined`: upstream draws nothing. */
	| { kind: 'empty' }
	/** The expression threw: the span shows upstream's `Dataview (for inline JS query ...)` text. */
	| { kind: 'error'; message: string }
	/** The host could not evaluate it (refused snapshot, timeout, crash): the span shows this text as is. */
	| { kind: 'problem'; message: string };

interface InlineEntry {
	/** Mounted spans showing this expression. */
	refs: number;
	outcome: DataviewJsInlineOutcome | null;
	/** The ticket of the newest evaluation the entry wants, and of the newest one it got. Pending while wanted > done. */
	wanted: number;
	done: number;
	/** Stopped by a timeout, a crash, or a failed load: not evaluated again until it is registered afresh. */
	halted: boolean;
}

/** A pending expression, with the ticket its answer settles. */
export interface PendingInlineExpression {
	expression: string;
	ticket: number;
}

/**
 * The inline `$=` spans of one note and what each shows. Spans with the same expression share one entry (they
 * bind the same `this`, so they get the same value). An entry is dropped when its last span unmounts.
 */
export class DataviewJsInlineStore {
	private readonly entries = new Map<string, InlineEntry>();
	private readonly listeners = new Set<() => void>();
	private tick = 0;
	private version = 0;

	readonly subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	/** Changes on every change to any entry (for `useSyncExternalStore`). */
	readonly getVersion = (): number => this.version;

	/** Show `expression` in one more span. Returns the release for that span. */
	register(expression: string): () => void {
		let entry = this.entries.get(expression);
		if (!entry) {
			entry = { refs: 0, outcome: null, wanted: ++this.tick, done: 0, halted: false };
			this.entries.set(expression, entry);
		}
		entry.refs += 1;
		this.notify();
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const current = this.entries.get(expression);
			if (!current) return;
			current.refs -= 1;
			if (current.refs <= 0) this.entries.delete(expression);
			this.notify();
		};
	}

	/** What `expression` shows now: null before its first answer. Stable until it changes. */
	outcome(expression: string): DataviewJsInlineOutcome | null {
		return this.entries.get(expression)?.outcome ?? null;
	}

	get size(): number {
		return this.entries.size;
	}

	/** Every expression waiting for an evaluation, in the order the spans first registered. */
	pending(): PendingInlineExpression[] {
		const pending: PendingInlineExpression[] = [];
		for (const [expression, entry] of this.entries) {
			if (!entry.halted && entry.wanted > entry.done) {
				pending.push({ expression, ticket: entry.wanted });
			}
		}
		return pending;
	}

	/** The index changed: every expression that is not halted wants a new evaluation. Values stay meanwhile. */
	invalidate(): void {
		let changed = false;
		for (const entry of this.entries.values()) {
			if (entry.halted) continue;
			entry.wanted = ++this.tick;
			changed = true;
		}
		if (changed) this.notify();
	}

	/** The answer to the evaluation `ticket` asked for. `halt` stops the expression until it is registered afresh. */
	resolve(
		expression: string,
		outcome: DataviewJsInlineOutcome,
		ticket: number,
		halt = false
	): void {
		const entry = this.entries.get(expression);
		if (!entry) return;
		entry.outcome = outcome;
		entry.done = Math.max(entry.done, ticket);
		if (halt) entry.halted = true;
		this.notify();
	}

	/** Answer every pending expression with `outcome` (a refused snapshot, a guest that cannot load). */
	failPending(outcome: DataviewJsInlineOutcome, halt = false): void {
		let changed = false;
		for (const entry of this.entries.values()) {
			if (entry.halted || entry.wanted <= entry.done) continue;
			entry.outcome = outcome;
			entry.done = entry.wanted;
			if (halt) entry.halted = true;
			changed = true;
		}
		if (changed) this.notify();
	}

	private notify(): void {
		this.version += 1;
		for (const listener of [...this.listeners]) listener();
	}
}

const DataviewJsInlineStoreContext = createContext<DataviewJsInlineStore | null>(null);

/** The inline store of the surrounding note, or null outside a Dataview surface. */
export function useDataviewJsInlineStore(): DataviewJsInlineStore | null {
	return useContext(DataviewJsInlineStoreContext);
}

/** Revive what the guest answered for one expression. */
export function inlineOutcomeFromGuest(
	outcome: SandboxEvalOutcome,
	root: string
): DataviewJsInlineOutcome {
	switch (outcome.kind) {
		case 'empty':
			return outcome;
		case 'error':
			return { kind: 'error', message: outcome.message };
		case 'value':
			try {
				return { kind: 'value', value: fromWireValue(outcome.value), root };
			} catch (error) {
				return { kind: 'error', message: `The value could not be read: ${String(error)}` };
			}
	}
}

/**
 * The inline host of one note: provides its store to the spans inside, and mounts the hidden guest while at
 * least one span has registered. With no note (`doc` null: the feature off, an untitled buffer) it provides
 * nothing and mounts nothing.
 */
export function DataviewJsInlineHost({
	doc,
	children,
}: {
	doc: DataviewDocumentScope | null;
	children: React.ReactNode;
}) {
	const noteKey = doc ? `${doc.agentId}\0${doc.filePath}` : null;
	// A new note is a new store: no value of one note's spans shows in another's.
	const store = useMemo(() => (noteKey === null ? null : new DataviewJsInlineStore()), [noteKey]);
	return (
		<DataviewJsInlineStoreContext.Provider value={store}>
			{children}
			{doc && store && <DataviewJsInlineGuest key={noteKey} doc={doc} store={store} />}
		</DataviewJsInlineStoreContext.Provider>
	);
}

interface InlineRun {
	runId: string;
	/** The guest the run was sent to. Only it may answer for the run. */
	guest: GuestWebviewElement;
	/** The run's expressions by id, in the order the guest answers them. */
	order: string[];
	expressions: Map<string, PendingInlineExpression>;
	/** Index into `order` of the first expression without an answer. */
	next: number;
	/** Answered, failed, timed out, or replaced. Requests are refused after. */
	settled: boolean;
	/** The index phase is over (`index.ready` or a first answer): only answers re-arm the watchdog now. */
	indexed: boolean;
	watchdog: IdleWatchdog | null;
}

let runCount = 0;

/** Off screen and out of the way; at least 1px so Chromium never treats the guest as hidden and throttles it. */
const HIDDEN_HOST_STYLE: React.CSSProperties = {
	position: 'absolute',
	left: 0,
	top: 0,
	width: '1px',
	height: '1px',
	overflow: 'hidden',
	opacity: 0,
	pointerEvents: 'none',
};

function DataviewJsInlineGuest({
	doc,
	store,
}: {
	doc: DataviewDocumentScope;
	store: DataviewJsInlineStore;
}) {
	const version = useSyncExternalStore(store.subscribe, store.getVersion);
	const active = store.size > 0;
	const [hasSlot, setHasSlot] = useState(false);
	const { snapshot, error: snapshotError, snapshotRef } = useDataviewJsSnapshot(doc, hasSlot);
	const [guestKey, setGuestKey] = useState(0);
	const [webview, setWebview] = useState<GuestWebviewElement | null>(null);
	const [readyGuest, setReadyGuest] = useState<GuestWebviewElement | null>(null);
	const runRef = useRef<InlineRun | null>(null);
	const [requests] = useState(createGuestRequestQueue);

	const attachWebview = useCallback((element: HTMLElement | null) => {
		setWebview(element as GuestWebviewElement | null);
	}, []);

	// --- A guest slot while any span is registered. The host is never "far": its spans are on screen. ---
	useEffect(() => {
		if (!active) return;
		const claim = claimDataviewJsGuestSlot({
			onGrant: () => setHasSlot(true),
			onEvict: () => setHasSlot(false),
		});
		claim.setNear(true);
		return () => {
			claim.release();
			setHasSlot(false);
		};
	}, [active]);

	/** End a run: stop its watchdog and refuse what it still has waiting in line. Safe to call twice. */
	const settleRun = useCallback(
		(run: InlineRun) => {
			if (run.settled) return;
			run.settled = true;
			run.watchdog?.disarm();
			requests.dropRun(run.runId);
		},
		[requests]
	);

	// No snapshot means no guest (evicted, refused): end the run it was on, so its watchdog cannot blame an
	// expression for a guest that is gone. Its unanswered expressions stay pending for the next guest.
	useEffect(() => {
		if (snapshot) return;
		const run = runRef.current;
		if (run) settleRun(run);
		runRef.current = null;
	}, [snapshot, settleRun]);

	// --- Snapshots: a new one evaluates every span again; a refusal answers every pending span with it. ---
	useEffect(() => {
		if (snapshot) store.invalidate();
	}, [snapshot, store]);

	useEffect(() => {
		if (snapshotError !== null) store.failPending({ kind: 'problem', message: snapshotError });
	}, [snapshotError, store, version]);

	/**
	 * Throw the guest away (a new key remounts the tag). The expression the run was on shows the failure and is
	 * halted; the rest of the run is evaluated again in the new guest.
	 */
	const stopGuest = useCallback(
		(failure: { kind: DataviewJsGuestFailure }) => {
			const run = runRef.current;
			// Nothing may answer for the abandoned run any more, not even a late message.
			runRef.current = null;
			setReadyGuest(null);
			setGuestKey((key) => key + 1);
			const problem: DataviewJsInlineOutcome = {
				kind: 'problem',
				message: dataviewJsGuestFailureText(failure.kind),
			};
			if (run) {
				settleRun(run);
				const blamed = run.expressions.get(run.order[run.next]);
				if (blamed) store.resolve(blamed.expression, problem, blamed.ticket, true);
			} else {
				// No run to blame (the guest died on its own): stop what waits, so a guest that dies on load does not
				// remount forever.
				store.failPending(problem, true);
			}
		},
		[settleRun, store]
	);

	/** A fresh wall-clock budget for the expression the run is on, or for the index build before the first. */
	const armWatchdog = useCallback(
		(run: InlineRun, idleMs: number = DATAVIEW_JS_RUN_TIMEOUT_MS) => {
			run.watchdog?.disarm();
			run.watchdog = createIdleWatchdog({
				idleMs,
				onIdle: () => {
					if (runRef.current !== run || run.settled) return;
					logger.warn(`An inline DataviewJS query in ${doc.filePath} timed out`, LOG_CONTEXT);
					stopGuest({ kind: 'timeout' });
				},
			});
		},
		[doc.filePath, stopGuest]
	);

	// --- Guest lifecycle: ready, crash, failed load. ---
	const ready = webview !== null && readyGuest === webview;

	useEventListener(
		'dom-ready',
		() => {
			if (webview) setReadyGuest(webview);
		},
		{ target: webview }
	);

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
			// The guest stays: a remount here would fail the same way, over and over.
			store.failPending(
				{ kind: 'problem', message: dataviewJsGuestFailureText('loadFailed') },
				true
			);
		},
		{ target: webview }
	);

	// --- Runs: one at a time, over whatever is pending once the guest and a snapshot are in. ---
	useEffect(() => {
		if (!ready || !webview || !snapshot || runRef.current) return;
		const pending = store.pending();
		if (pending.length === 0) return;
		const runId = `inline-run-${++runCount}`;
		const order = pending.map((_, index) => `expr-${index + 1}`);
		const run: InlineRun = {
			runId,
			guest: webview,
			order,
			expressions: new Map(order.map((id, index) => [id, pending[index]])),
			next: 0,
			settled: false,
			indexed: false,
			watchdog: null,
		};
		runRef.current = run;
		armWatchdog(run, DATAVIEW_JS_INDEX_TIMEOUT_MS);
		const sent = pushToGuest(webview, SANDBOX_TO_GUEST_CHANNEL, {
			type: 'eval',
			runId,
			thisPath: snapshot.path,
			snapshot: snapshot.result,
			expressions: order.map((id, index) => ({ id, source: pending[index].expression })),
		});
		// The guest went away before it took the run; its replacement's dom-ready runs again.
		if (!sent) {
			settleRun(run);
			runRef.current = null;
		}
	}, [ready, webview, snapshot, version, store, armWatchdog, settleRun]);

	// The watchdog's timer must not outlive the host.
	useEffect(
		() => () => {
			const run = runRef.current;
			if (run) settleRun(run);
		},
		[settleRun]
	);

	const handleGuestMessage = (guest: GuestWebviewElement, message: SandboxGuestMessage) => {
		const run = runRef.current;
		switch (message.type) {
			case 'eval.result': {
				if (!run || run.settled || run.guest !== guest || message.runId !== run.runId) return;
				// The guest answers in order; anything else is not the answer the run waits for.
				if (message.id !== run.order[run.next]) return;
				const answered = run.expressions.get(message.id)!;
				run.indexed = true;
				run.next += 1;
				if (run.next >= run.order.length) {
					settleRun(run);
					runRef.current = null;
				} else {
					armWatchdog(run);
				}
				const root = snapshotRef.current?.root ?? '';
				store.resolve(
					answered.expression,
					inlineOutcomeFromGuest(message.outcome, root),
					answered.ticket
				);
				return;
			}
			case 'index.ready':
				if (!run || run.settled || run.indexed || run.guest !== guest) return;
				if (message.runId !== run.runId) return;
				run.indexed = true;
				armWatchdog(run);
				return;
			case 'query.dql':
			case 'io.load':
				requests.enqueue(run && !run.settled ? run.runId : null, guest, message.requestId, () =>
					answerGuestRequest(doc, snapshotRef.current, message)
				);
				return;
			case 'open.link':
			case 'toggle.task':
			case 'render.done':
			case 'render.error':
				// Inline spans draw nothing in the guest, so nothing there can be clicked or rendered.
				return;
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

	const partition = snapshot ? dataviewGuestPartition(snapshot.root, snapshot.sshRemoteId) : null;
	const mountGuest = hasSlot && partition !== null;
	if (!mountGuest) return null;
	return (
		<div aria-hidden="true" data-dataview-js-inline-host="" style={HIDDEN_HOST_STYLE}>
			<webview
				key={`${partition}:${guestKey}`}
				ref={attachWebview}
				partition={partition}
				src={DATAVIEW_GUEST_URL}
				title="DataviewJS inline queries"
				style={{ display: 'block', width: '1px', height: '1px', border: 0 }}
			/>
		</div>
	);
}
