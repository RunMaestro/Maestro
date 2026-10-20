/**
 * The DataviewJS guest runtime (D4, M7): the page side of the sandbox bridge. It runs inside the isolated
 * `<webview>` guest, where note scripts run, and nowhere else.
 *
 * - A `run` message renders one block. The runtime builds the run's index from the snapshot
 *   (`PageIndex.fromSnapshot`, the same source resolution `VaultIndex` runs), gives the script a fresh `dv`
 *   object and container, runs it (`./inlineScript`, DEV-6), waits for the views it started, and answers
 *   `render.done` with the block's height, or `render.error` with upstream's `Evaluation Error:` text.
 *   After a run it sends `render.done` again whenever the block's height changes.
 * - An `eval` message evaluates the inline `` `$= expr` `` spans of one note (DEV-5), one after another, each
 *   with a fresh `dv` as its only scope, and answers `eval.result` per expression: the value in the wire form
 *   the host renders with the DQL value renderer, nothing for `undefined`, or the error text.
 * - `dv.query`, `dv.io.load`, and the calls built on them are requests the host answers by request id.
 * - A link click sends `open.link`; a task checkbox sends `toggle.task`.
 * - Everything the host sends goes through `parseSandboxMessage(raw, 'host')`; anything it refuses is
 *   dropped.
 */

import {
	DataArray,
	PageIndex,
	SANDBOX_MAX_GUEST_MESSAGE_BYTES,
	SANDBOX_TO_GUEST_CHANNEL,
	SANDBOX_TO_HOST_CHANNEL,
	Values,
	openSandboxEnvelope,
	parseSandboxMessage,
	sandboxEnvelope,
	toWireValue,
	type DataviewResult,
	type Literal,
	type SandboxEvalMessage,
	type SandboxEvalOutcome,
	type SandboxGuestMessage,
	type SandboxHostMessage,
	type SandboxIndexSnapshot,
	type SandboxRunMessage,
} from '../../shared/dataview';
import { serializedJsonByteLength } from '../../shared/jsonUtils';
import { normalizeRootRelativePath } from '../../shared/pathContainment';
import { createDvApi, obsidianApiUnavailable } from './dvApi';
import { compileInlineScript } from './inlineScript';
import { LINK_PATH_ATTRIBUTE, LINK_URL_ATTRIBUTE, type GuestRenderContext } from './renderDom';

/** The element of `guest.html` that holds the blocks. */
export const GUEST_ROOT_ID = 'dataview-root';

/** Error text longer than this is cut; the bridge refuses a guest message over 1 MB. */
const MAX_ERROR_MESSAGE_LENGTH = 64 * 1024;

/** Upstream's preamble (`ui/views/js-view.ts`): a script's `this` is `dv`, under both of its names. */
const SCRIPT_PREAMBLE = 'const dataview = this;const dv = this;';

/**
 * A block's script as upstream runs it: the preamble, then the source, inside an async arrow when the source
 * mentions `await` (`asyncEvalInContext`), so top-level `await` works. The newline before the closing
 * brace keeps a trailing `//` comment from swallowing it.
 */
export function blockScriptBody(source: string): string {
	const script = SCRIPT_PREAMBLE + source;
	return script.includes('await') ? `return (async () => { ${script}\n})();` : script;
}

/**
 * An inline `$=` expression as upstream runs it (`asyncEvalInContext`): `return <expression>`, or, when the
 * expression mentions `await`, an async body whose `return` gives the value.
 */
export function inlineScriptBody(source: string): string {
	return source.includes('await') ? `return (async () => { ${source}\n})();` : `return ${source}`;
}

/** The error an inline expression that returns an element gets: it has no DOM to land in (DEV-5). */
export const INLINE_ELEMENT_MESSAGE =
	'An inline DataviewJS query in Maestro must return a value, not an HTML element. Use a dataviewjs block to draw elements.';

/** How deep an inline value may nest before it is refused (a cycle would nest forever). */
const MAX_INLINE_VALUE_DEPTH = 64;

/**
 * An inline value with its data arrays turned into arrays, so the wire codec sees plain lists. Throws for a
 * DOM node anywhere in it (`isNode`, the page's own `Node` check), and for a value nested deeper than
 * {@link MAX_INLINE_VALUE_DEPTH}.
 */
function plainInlineValue(value: unknown, isNode: (value: unknown) => boolean, depth = 0): Literal {
	if (depth > MAX_INLINE_VALUE_DEPTH) throw new Error('The value nests too deeply to show.');
	if (DataArray.isDataArray(value)) return plainInlineValue(value.array(), isNode, depth);
	if (isNode(value) || Values.isHtml(value)) throw new Error(INLINE_ELEMENT_MESSAGE);
	if (Array.isArray(value)) return value.map((item) => plainInlineValue(item, isNode, depth + 1));
	if (Values.isObject(value)) {
		const result: Record<string, Literal> = {};
		for (const [key, item] of Object.entries(value)) {
			result[key] = plainInlineValue(item, isNode, depth + 1);
		}
		return result;
	}
	return value as Literal;
}

/** An error as upstream's inline renderer prints it (`"" + e`), without trusting the value's `toString`. */
function inlineErrorText(error: unknown): string {
	try {
		return String(error);
	} catch {
		return 'Error';
	}
}

/**
 * Lock down the global object note scripts see. `app` (Obsidian's `window.app`) and `DataviewAPI` (the
 * plugin lookup) throw `Obsidian API not available in Maestro` (D5). The WebRTC constructors are removed,
 * because Chromium does not apply `connect-src` to them (as `src/main/concerto-html.ts` does). Safe to call
 * again on the same global.
 */
export function lockDownScriptGlobal(global: object): void {
	for (const name of ['app', 'DataviewAPI']) {
		Object.defineProperty(global, name, {
			get: obsidianApiUnavailable,
			enumerable: false,
			configurable: false,
		});
	}
	for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
		Object.defineProperty(global, name, {
			value: undefined,
			writable: false,
			enumerable: false,
			configurable: false,
		});
	}
}

export interface DataviewGuestOptions {
	document: Document;
	/** Where block output goes. */
	root: HTMLElement;
	/** The global object note scripts run against: `window` in the guest page. */
	scriptGlobal: object;
	/** Send one message to the host. */
	send(message: SandboxGuestMessage): void;
}

export interface DataviewGuest {
	/** Handle one message from the host. Resolves once it is handled; for `run`, once the run has settled. */
	receive(raw: unknown): Promise<void>;
}

interface Block {
	element: HTMLElement;
	/** The run the block shows, or is rendering. */
	runId: string | null;
	/** Whether that run finished, so height changes are reported. */
	done: boolean;
	/** The height last reported. */
	height: number | null;
}

function describeError(error: unknown): string {
	const stack = (error as { stack?: unknown } | null)?.stack;
	return typeof stack === 'string' ? stack : String(error);
}

export function createDataviewGuest(options: DataviewGuestOptions): DataviewGuest {
	const { document: doc, root, send } = options;
	lockDownScriptGlobal(options.scriptGlobal);

	const blocks = new Map<string, Block>();
	const replies = new Map<string, (message: SandboxHostMessage) => void>();
	let requestCount = 0;

	/** Send a request and wait for the host's reply to its id. */
	const ask = (build: (requestId: string) => SandboxGuestMessage): Promise<SandboxHostMessage> => {
		const requestId = `request-${++requestCount}`;
		const reply = new Promise<SandboxHostMessage>((resolve) => replies.set(requestId, resolve));
		send(build(requestId));
		return reply;
	};

	const queryDql = async (source: string, originPath: string): Promise<DataviewResult> => {
		// The host refuses a query that is not text; failing here keeps the run from waiting on it.
		if (typeof source !== 'string') throw new TypeError(`DQL must be text, not ${typeof source}.`);
		const reply = await ask((requestId) => ({ type: 'query.dql', requestId, source, originPath }));
		if (reply.type === 'query.dql.result') return reply.result;
		throw new Error(
			reply.type === 'request.failed' ? reply.message : 'The host sent no query result.'
		);
	};

	const loadText = async (path: string): Promise<string | null> => {
		// The host refuses a path outside the vault root; there is no such file for this page either.
		const normalized = normalizeRootRelativePath(path);
		if (!normalized) return null;
		const reply = await ask((requestId) => ({ type: 'io.load', requestId, path: normalized }));
		if (reply.type === 'io.load.result') return reply.text;
		throw new Error(reply.type === 'request.failed' ? reply.message : 'The host sent no file.');
	};

	const reportHeight = (blockId: string, block: Block, force: boolean): void => {
		if (!block.done || block.runId === null) return;
		const height = Math.max(0, Math.ceil(block.element.getBoundingClientRect().height));
		if (!force && height === block.height) return;
		block.height = height;
		send({ type: 'render.done', blockId, runId: block.runId, height });
	};

	const blockFor = (blockId: string): Block => {
		const existing = blocks.get(blockId);
		if (existing) return existing;
		const element = doc.createElement('div');
		element.className = 'dataview-block';
		element.setAttribute('data-block-id', blockId);
		root.append(element);
		const block: Block = { element, runId: null, done: false, height: null };
		blocks.set(blockId, block);
		const ResizeObserverCtor = doc.defaultView?.ResizeObserver;
		if (typeof ResizeObserverCtor === 'function') {
			new ResizeObserverCtor(() => reportHeight(blockId, block, false)).observe(element);
		}
		return block;
	};

	const renderContext = (index: PageIndex, thisPath: string): GuestRenderContext => ({
		document: doc,
		originPath: thisPath,
		resolveLink: (linkpath, sourcePath) => index.resolveLink(linkpath, sourcePath),
		toggleTask: ({ path, line, text }) => {
			const normalized = normalizeRootRelativePath(path);
			if (!normalized || !Number.isSafeInteger(line) || line < 1) return;
			send({ type: 'toggle.task', path: normalized, line, text });
		},
	});

	/** The run's index, built from its snapshot; a string is the error when the snapshot cannot be read. */
	const buildIndex = (snapshot: SandboxIndexSnapshot): PageIndex | string => {
		try {
			return PageIndex.fromSnapshot(snapshot, async (path) => {
				const text = await loadText(path);
				if (text === null) throw new Error(`No such file: '${path}'.`);
				return text;
			});
		} catch (error) {
			return `Dataview: the index snapshot could not be read. ${describeError(error)}`;
		}
	};

	/** Run one block's script into `container`. Null when it finished, else the error to show. */
	const execute = async (
		message: SandboxRunMessage,
		container: HTMLElement
	): Promise<string | null> => {
		const index = buildIndex(message.snapshot);
		if (typeof index === 'string') return index;

		// Views and queries the script started without awaiting them still belong to this run.
		const pending = new Set<Promise<unknown>>();
		const dv = createDvApi({
			index,
			thisPath: message.thisPath,
			container,
			render: renderContext(index, message.thisPath),
			queryDql,
			loadText,
			compile: (script) => compileInlineScript(doc, script),
			track: (work) => {
				pending.add(work);
				const forget = () => pending.delete(work);
				work.then(forget, forget);
				return work;
			},
		});

		try {
			const script = compileInlineScript(doc, {
				params: [],
				body: blockScriptBody(message.source),
				strict: true,
			});
			await script.call(dv);
			while (pending.size > 0) await Promise.allSettled([...pending]);
			return null;
		} catch (error) {
			return `Evaluation Error: ${describeError(error)}`;
		}
	};

	const run = async (message: SandboxRunMessage): Promise<void> => {
		const block = blockFor(message.blockId);
		block.runId = message.runId;
		block.done = false;
		block.height = null;
		// A fresh container per run: work a superseded run still has in flight writes into a detached node.
		const container = doc.createElement('div');
		block.element.replaceChildren(container);

		const error = await execute(message, container);
		if (block.runId !== message.runId) return;
		if (error === null) {
			block.done = true;
			reportHeight(message.blockId, block, true);
			return;
		}
		container.replaceChildren();
		send({
			type: 'render.error',
			blockId: message.blockId,
			runId: message.runId,
			message: error.slice(0, MAX_ERROR_MESSAGE_LENGTH),
		});
	};

	const NodeCtor = doc.defaultView?.Node;
	const isDomNode = (value: unknown): boolean =>
		typeof NodeCtor === 'function' && value instanceof NodeCtor;

	/** Evaluate one inline expression with a fresh `dv`, which writes into a container no one sees. */
	const evaluateInline = async (
		index: PageIndex,
		thisPath: string,
		source: string
	): Promise<SandboxEvalOutcome> => {
		try {
			const dv = createDvApi({
				index,
				thisPath,
				container: doc.createElement('span'),
				render: renderContext(index, thisPath),
				queryDql,
				loadText,
				compile: (script) => compileInlineScript(doc, script),
				track: (work) => work,
			});
			// Upstream runs an inline expression with `new Function` (sloppy), `dv` in scope under both names.
			const script = compileInlineScript(doc, {
				params: ['dv', 'dataview'],
				body: inlineScriptBody(source),
				strict: false,
			});
			const value: unknown = await script.call(undefined, dv, dv);
			if (value === undefined) return { kind: 'empty' };
			return { kind: 'value', value: toWireValue(plainInlineValue(value, isDomNode)) };
		} catch (error) {
			return { kind: 'error', message: inlineErrorText(error).slice(0, MAX_ERROR_MESSAGE_LENGTH) };
		}
	};

	const evaluate = async (message: SandboxEvalMessage): Promise<void> => {
		const index = buildIndex(message.snapshot);
		for (const expression of message.expressions) {
			let outcome: SandboxEvalOutcome =
				typeof index === 'string'
					? { kind: 'error', message: index.slice(0, MAX_ERROR_MESSAGE_LENGTH) }
					: await evaluateInline(index, message.thisPath, expression.source);
			const reply = (): SandboxGuestMessage => ({
				type: 'eval.result',
				runId: message.runId,
				id: expression.id,
				outcome,
			});
			// The host drops a message over the cap, which would leave the span waiting for the watchdog.
			const size = serializedJsonByteLength(reply());
			if (size === null || size > SANDBOX_MAX_GUEST_MESSAGE_BYTES) {
				outcome = { kind: 'error', message: 'The value is too large to show.' };
			}
			send(reply());
		}
	};

	// Links never navigate the guest: their targets go to the host, which opens them the way the preview does.
	doc.addEventListener('click', (event) => {
		const anchor = (event.target as Element | null)?.closest?.('a');
		if (!anchor) return;
		const newTab = event.metaKey || event.ctrlKey;
		const path = anchor.getAttribute(LINK_PATH_ATTRIBUTE);
		if (path !== null) {
			event.preventDefault();
			send({ type: 'open.link', kind: 'file', path, newTab });
			return;
		}
		const href = anchor.getAttribute('href') ?? '';
		if (href.startsWith('#')) return;
		event.preventDefault();
		const url = anchor.getAttribute(LINK_URL_ATTRIBUTE) ?? href;
		if (/^https?:\/\//i.test(url)) send({ type: 'open.link', kind: 'url', url, newTab });
	});

	return {
		receive(raw) {
			const parsed = parseSandboxMessage(raw, 'host');
			if (!parsed.ok) {
				console.warn(`Dataview guest dropped a host message: ${parsed.reason}`);
				return Promise.resolve();
			}
			const message = parsed.message;
			if (message.type === 'run') return run(message);
			if (message.type === 'eval') return evaluate(message);
			const settle = replies.get(message.requestId);
			if (settle) {
				replies.delete(message.requestId);
				settle(message);
			}
			return Promise.resolve();
		},
	};
}

/**
 * Start the guest in its page: messages travel as envelopes on the page's own window, which the guest
 * preload relays to and from the host (`ipcRenderer.sendToHost`, `webview.send`).
 */
export function startDataviewGuest(win: Window): DataviewGuest {
	const doc = win.document;
	const guest = createDataviewGuest({
		document: doc,
		root: doc.getElementById(GUEST_ROOT_ID) ?? doc.body,
		scriptGlobal: win,
		send: (message) => win.postMessage(sandboxEnvelope(SANDBOX_TO_HOST_CHANNEL, message), '*'),
	});
	// No `event.source` check: only this page and its preload can post here (the CSP forbids frames and main
	// denies new windows), and a host message forged by a note script misleads only that script's page.
	win.addEventListener('message', (event) => {
		const message = openSandboxEnvelope(event.data, SANDBOX_TO_GUEST_CHANNEL);
		if (message === undefined) return;
		guest.receive(message).catch((error) => {
			console.error(`Dataview guest failed on a host message: ${describeError(error)}`);
		});
	});
	return guest;
}
