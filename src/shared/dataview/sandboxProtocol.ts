/**
 * The DataviewJS sandbox bridge (D4, DV-11): every message between a guest page, where note scripts run,
 * and the host that embeds it, as one closed discriminated union, plus the validator each side runs on what
 * it receives.
 *
 * The guest is untrusted: a note script can post any value it likes. So the host acts only on what
 * `parseSandboxMessage(raw, 'guest')` returns, and that parse:
 *
 * - accepts exactly the message types and fields below. It refuses an unknown type, a missing, extra, or
 *   mistyped field (an own `__proto__` or `constructor` key included), an accessor property, and anything
 *   that is not a plain object;
 * - refuses a message whose JSON is over {@link SANDBOX_MAX_GUEST_MESSAGE_BYTES} (1 MB);
 * - refuses a path that is absolute (`/x`, `\x`, `C:\x`, `C:x`, `\\server\share`) or climbs out of the vault
 *   root once `.` and `..` are collapsed (`normalizeRootRelativePath()`), and returns each path normalized;
 * - builds a fresh message from the fields it checked, so nothing else the guest attached comes along.
 *
 * The guest runs `parseSandboxMessage(raw, 'host')` on what the host sends. That parse checks shape only:
 * the host is trusted, and the `run` snapshot of a large vault is well over 1 MB. So host messages have no
 * size cap, snapshot paths are taken as the index spells them (the guest never touches the file system),
 * and opaque payloads (page data, query results) pass through by reference.
 *
 * The snapshot travels as JSON text ({@link SandboxSnapshotPayload}): main encodes it once per index state
 * ({@link encodeSandboxSnapshot}), every hop copies one string, and only the guest decodes it
 * ({@link decodeSandboxSnapshot}), with the same shape check.
 *
 * Paths are vault-relative POSIX paths, as the index spells them (`People/Pedram Amini.md`). The host joins
 * them onto the root, and main checks containment again with `realpath` before it reads a file. See
 * docs/agent-guides/DATAVIEW.md (D4).
 */

import { serializedJsonByteLength } from '../jsonUtils';
import { normalizeRootRelativePath } from '../pathContainment';
import { dataviewJsonReplacer, dataviewJsonReviver } from './json';
import type { DataviewResult, DataviewWireValue } from './types';

/** The largest message a guest may send, as UTF-8 JSON (1 MB). */
export const SANDBOX_MAX_GUEST_MESSAGE_BYTES = 1024 * 1024;

/** Pages {@link encodeSandboxSnapshot} stringifies between two pauses. */
export const SNAPSHOT_ENCODE_BATCH_PAGES = 256;

/** Who sent a message: the guest page, where note scripts run, or the host that embeds it. */
export type SandboxSender = 'guest' | 'host';

// ---------------------------------------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------------------------------------

/**
 * The `<webview>` IPC channel a guest's preload forwards guest messages to the host on
 * (`ipcRenderer.sendToHost`), and the channel those messages carry inside the guest page.
 */
export const SANDBOX_TO_HOST_CHANNEL = 'maestro:dataview-sandbox:to-host';

/**
 * The `<webview>` IPC channel the host sends host messages on (`webview.send`), and the channel the preload
 * gives them when it posts them into the guest page.
 */
export const SANDBOX_TO_GUEST_CHANNEL = 'maestro:dataview-sandbox:to-guest';

export type SandboxChannel = typeof SANDBOX_TO_HOST_CHANNEL | typeof SANDBOX_TO_GUEST_CHANNEL;

/**
 * A message as it travels inside the guest page, between the page and its preload: posted with
 * `window.postMessage(envelope, '*')` on the page's own window, which both sides listen on. The channel
 * names the direction, so neither side takes its own posts for the other's.
 */
export interface SandboxEnvelope {
	channel: SandboxChannel;
	message: unknown;
}

export function sandboxEnvelope(channel: SandboxChannel, message: unknown): SandboxEnvelope {
	return { channel, message };
}

/**
 * The message inside `data` when `data` is an envelope on `channel`, else undefined. The message itself is
 * not checked here: pass it to {@link parseSandboxMessage}.
 */
export function openSandboxEnvelope(data: unknown, channel: SandboxChannel): unknown {
	if (typeof data !== 'object' || data === null) return undefined;
	const envelope = data as Partial<SandboxEnvelope>;
	return envelope.channel === channel ? envelope.message : undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Guest to host
// ---------------------------------------------------------------------------------------------------------

/** Run DQL with the executor `dataview` blocks use (`dv.query`, `dv.tryQuery`, `dv.queryMarkdown`, `dv.execute`). */
export interface SandboxQueryDqlMessage {
	type: 'query.dql';
	requestId: string;
	source: string;
	/** The page `this` binds to. The note the block sits in when absent. */
	originPath?: string;
}

/** Read a text file inside the vault root (`dv.io.load`, and through it `dv.io.csv` and `dv.view`). */
export interface SandboxIoLoadMessage {
	type: 'io.load';
	requestId: string;
	path: string;
}

/** Open a link the user clicked in the output: a vault file, or an http or https page. */
export type SandboxOpenLinkMessage =
	| { type: 'open.link'; kind: 'file'; path: string; newTab: boolean }
	| { type: 'open.link'; kind: 'url'; url: string; newTab: boolean };

/** Toggle a task the user clicked, in the task's own file (DV-8). */
export interface SandboxToggleTaskMessage {
	type: 'toggle.task';
	path: string;
	/** 1-based line of the task's marker. */
	line: number;
	/** The task's text as the snapshot holds it. The host refuses when the line no longer shows it. */
	text: string;
}

/** A run finished rendering, or its output changed height since. */
export interface SandboxRenderDoneMessage {
	type: 'render.done';
	blockId: string;
	/** The run this answers. The host ignores an answer to an earlier run. */
	runId: string;
	/** Height of the block's output in CSS pixels. The host sizes the frame to it. */
	height: number;
}

/**
 * The run's index is built from its snapshot and the script starts now. The host gives a run
 * `DATAVIEW_JS_INDEX_TIMEOUT_MS` until this message and the script `DATAVIEW_JS_RUN_TIMEOUT_MS` after it, so a
 * large vault's index build never counts against the script. The host honors it once per run: a script that
 * posts it again cannot buy itself more time.
 */
export interface SandboxIndexReadyMessage {
	type: 'index.ready';
	/** The run (`run` or `eval`) whose index is ready. */
	runId: string;
}

/** A run failed: the script threw, or did not compile. */
export interface SandboxRenderErrorMessage {
	type: 'render.error';
	blockId: string;
	runId: string;
	message: string;
}

/**
 * What one inline `$=` expression came to: a value (the wire form, as `dataview:queryInline` answers), nothing
 * (the expression gave `undefined`, and upstream then draws nothing), or the error it threw.
 */
export type SandboxEvalOutcome =
	| { kind: 'value'; value: DataviewWireValue }
	| { kind: 'empty' }
	| { kind: 'error'; message: string };

/** One expression of an `eval` run finished. The guest sends one per expression, in the order the run lists them. */
export interface SandboxEvalResultMessage {
	type: 'eval.result';
	runId: string;
	/** The expression's id in the run. */
	id: string;
	outcome: SandboxEvalOutcome;
}

/** Everything a guest may send. */
export type SandboxGuestMessage =
	| SandboxQueryDqlMessage
	| SandboxIoLoadMessage
	| SandboxOpenLinkMessage
	| SandboxToggleTaskMessage
	| SandboxRenderDoneMessage
	| SandboxRenderErrorMessage
	| SandboxIndexReadyMessage
	| SandboxEvalResultMessage;

// ---------------------------------------------------------------------------------------------------------
// Host to guest
// ---------------------------------------------------------------------------------------------------------

/** One page of a snapshot: its raw parse, with links still as written (the guest resolves them against `files`). */
export interface SandboxSnapshotPage {
	path: string;
	/** `Transferable.transferable(parseRawPage(...))`, the disk cache's `CachedPage.data`. May hold `Map` and `Set`. */
	data: Record<string, unknown>;
}

/** The index as one run sees it: every page a script can read, plus what source and link resolution need. */
export interface SandboxIndexSnapshot {
	/** The index revision the snapshot was taken at. */
	revision: number;
	/** Every vault file, any extension (the folder index and link resolution read it). */
	files: string[];
	/** Every vault folder, empty ones included. */
	folders: string[];
	/** Starred pages (`file.starred`). */
	stars: string[];
	pages: SandboxSnapshotPage[];
	/** Pages whose tasks and lists were left out to bound the snapshot's size; absent when none were. */
	omittedListPages?: number;
}

/**
 * A snapshot as it travels from main to a guest: its JSON text (`dataviewJsonReplacer`), plus what the host
 * shows without decoding it. A large vault's snapshot is tens of megabytes of small objects. As an object
 * graph, structured clone rebuilt it on every hop (main, the renderer, main again, the guest), and the two
 * renderer hops froze the window for up to 1.5 s per block. As one string, each hop is a copy.
 */
export interface SandboxSnapshotPayload {
	/** The snapshot's `revision`. */
	revision: number;
	/** The snapshot's `omittedListPages`; absent when none were left out. */
	omittedListPages?: number;
	/** `SandboxIndexSnapshot` as JSON text. Decode with {@link decodeSandboxSnapshot}. */
	json: string;
}

/** Run one block's script against a snapshot. */
export interface SandboxRunMessage {
	type: 'run';
	runId: string;
	blockId: string;
	source: string;
	/** The note the block sits in: `dv.current()`, and the origin of relative links and paths. */
	thisPath: string;
	snapshot: SandboxSnapshotPayload;
}

/** One inline `$=` expression of an `eval` run. */
export interface SandboxEvalExpression {
	id: string;
	/** The expression, without its `$=` prefix. */
	source: string;
}

/**
 * Evaluate the inline `$=` expressions of one note against a snapshot (DEV-5), one after another, in order.
 * Each answers `eval.result`; a script that never answers is the host's watchdog's to stop.
 */
export interface SandboxEvalMessage {
	type: 'eval';
	runId: string;
	/** The note the spans sit in: `dv.current()`, and the origin of relative links and paths. */
	thisPath: string;
	snapshot: SandboxSnapshotPayload;
	expressions: SandboxEvalExpression[];
}

/** The answer to `query.dql`. A query that fails is a result too (`kind: 'error'`, DV-9). */
export interface SandboxQueryDqlResultMessage {
	type: 'query.dql.result';
	requestId: string;
	result: DataviewResult;
}

/** The answer to `io.load`: the file's text, or null when no such file exists (upstream returns `undefined`). */
export interface SandboxIoLoadResultMessage {
	type: 'io.load.result';
	requestId: string;
	text: string | null;
}

/** A request the host refused or could not answer (outside the root, an untrusted vault, a read error). */
export interface SandboxRequestFailedMessage {
	type: 'request.failed';
	requestId: string;
	message: string;
}

/** Everything the host may send. */
export type SandboxHostMessage =
	| SandboxRunMessage
	| SandboxEvalMessage
	| SandboxQueryDqlResultMessage
	| SandboxIoLoadResultMessage
	| SandboxRequestFailedMessage;

/** The whole bridge: D4's closed message set. */
export type SandboxMessage = SandboxGuestMessage | SandboxHostMessage;

/** What {@link parseSandboxMessage} returns: the checked message, or why it was refused. */
export type SandboxParseResult<M extends SandboxMessage> =
	| { ok: true; message: M }
	| { ok: false; reason: string };

// ---------------------------------------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------------------------------------

/** A run, block, or request id. Short and plain: the bridge only echoes and compares ids. */
const ID_PATTERN = /^[\w.:-]{1,128}$/;

/** Every `DataviewResult` kind. A record, so a new kind does not compile until it is listed here. */
const RESULT_KINDS: Record<DataviewResult['kind'], true> = {
	table: true,
	list: true,
	task: true,
	unsupported: true,
	error: true,
};

/** Thrown by the readers below; {@link parseSandboxMessage} returns it as `{ ok: false, reason }`. */
class SandboxMessageRejected extends Error {}

function reject(reason: string): never {
	throw new SandboxMessageRejected(reason);
}

/** Untrusted text, quoted and cut short, for a refusal reason. */
function quote(text: string): string {
	return JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}...` : text);
}

function readPlainObject(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null) reject(`${what} is not an object`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) reject(`${what} is not a plain object`);
	return value as Record<string, unknown>;
}

/**
 * The own fields of a plain object, each read once onto a null-prototype record. Refuses a symbol key, an
 * accessor property, a key outside `required` and `optional`, and a missing required key. An optional key
 * that holds `undefined` counts as absent.
 */
function readFields(
	value: unknown,
	what: string,
	required: readonly string[],
	optional: readonly string[] = []
): Record<string, unknown> {
	const object = readPlainObject(value, what);
	const fields: Record<string, unknown> = Object.create(null);
	for (const key of Reflect.ownKeys(object)) {
		if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key))) {
			reject(`${what} has an unexpected field ${quote(String(key))}`);
		}
		const descriptor = Object.getOwnPropertyDescriptor(object, key);
		if (!descriptor || !('value' in descriptor)) reject(`${what}.${key} is not a data property`);
		if (descriptor.value !== undefined) fields[key] = descriptor.value;
	}
	for (const key of required) {
		if (!(key in fields)) reject(`${what} is missing ${key}`);
	}
	return fields;
}

/** The `type` of a message, read without touching any other field. */
function readType(raw: unknown, from: SandboxSender): string {
	const descriptor = Object.getOwnPropertyDescriptor(
		readPlainObject(raw, `${from} message`),
		'type'
	);
	if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') {
		reject(`${from} message has no type`);
	}
	return descriptor.value;
}

function readString(value: unknown, what: string): string {
	if (typeof value !== 'string') reject(`${what} is not a string`);
	return value;
}

function readId(value: unknown, what: string): string {
	const id = readString(value, what);
	if (!ID_PATTERN.test(id)) reject(`${what} is not a valid id`);
	return id;
}

function readBoolean(value: unknown, what: string): boolean {
	if (typeof value !== 'boolean') reject(`${what} is not a boolean`);
	return value;
}

/** A vault-relative path, normalized. The root itself is refused: every path field names something in it. */
function readVaultPath(value: unknown, what: string): string {
	const text = readString(value, what);
	const path = normalizeRootRelativePath(text);
	if (path === null) reject(`${what} is not a path inside the vault root: ${quote(text)}`);
	if (path === '') reject(`${what} names the vault root itself`);
	return path;
}

/** An http or https URL, in the normalized form `URL` gives it. */
function readUrl(value: unknown, what: string): string {
	const text = readString(value, what);
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		reject(`${what} is not a URL`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		reject(`${what} is not an http or https URL`);
	}
	return url.href;
}

function readInteger(value: unknown, what: string, min: number): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
		reject(`${what} is not an integer of at least ${min}`);
	}
	return value;
}

function readArray<T>(
	value: unknown,
	what: string,
	readItem: (item: unknown, what: string) => T
): T[] {
	if (!Array.isArray(value)) reject(`${what} is not an array`);
	const items: T[] = [];
	for (let index = 0; index < value.length; index++)
		items.push(readItem(value[index], `${what}[]`));
	return items;
}

function readSnapshot(value: unknown, what: string): SandboxIndexSnapshot {
	const fields = readFields(
		value,
		what,
		['revision', 'files', 'folders', 'stars', 'pages'],
		['omittedListPages']
	);
	return {
		...(fields.omittedListPages === undefined
			? {}
			: {
					omittedListPages: readInteger(fields.omittedListPages, `${what}.omittedListPages`, 0),
				}),
		revision: readInteger(fields.revision, `${what}.revision`, 0),
		files: readArray(fields.files, `${what}.files`, readString),
		folders: readArray(fields.folders, `${what}.folders`, readString),
		stars: readArray(fields.stars, `${what}.stars`, readString),
		pages: readArray(fields.pages, `${what}.pages`, (item, itemWhat) => {
			const page = readFields(item, itemWhat, ['path', 'data']);
			return {
				path: readString(page.path, `${itemWhat}.path`),
				data: readPlainObject(page.data, `${itemWhat}.data`),
			};
		}),
	};
}

function readSnapshotPayload(value: unknown, what: string): SandboxSnapshotPayload {
	const fields = readFields(value, what, ['revision', 'json'], ['omittedListPages']);
	return {
		...(fields.omittedListPages === undefined
			? {}
			: {
					omittedListPages: readInteger(fields.omittedListPages, `${what}.omittedListPages`, 0),
				}),
		revision: readInteger(fields.revision, `${what}.revision`, 0),
		json: readString(fields.json, `${what}.json`),
	};
}

/**
 * Encode a snapshot as the payload that travels to a guest. `pause` runs between batches of
 * {@link SNAPSHOT_ENCODE_BATCH_PAGES} pages, so main can yield to its event loop while a large vault encodes.
 * The text parses to the same value as `JSON.stringify(snapshot, dataviewJsonReplacer)`.
 */
export async function encodeSandboxSnapshot(
	snapshot: SandboxIndexSnapshot,
	pause?: () => Promise<void>
): Promise<SandboxSnapshotPayload> {
	const { pages, ...rest } = snapshot;
	// `rest` always holds `revision`, so its text ends in a field and `}`: the pages go in before the brace.
	const parts = [`${JSON.stringify(rest, dataviewJsonReplacer).slice(0, -1)},"pages":[`];
	for (let start = 0; start < pages.length; start += SNAPSHOT_ENCODE_BATCH_PAGES) {
		const batch = pages.slice(start, start + SNAPSHOT_ENCODE_BATCH_PAGES);
		const text = batch.map((page) => JSON.stringify(page, dataviewJsonReplacer)).join(',');
		parts.push(start > 0 ? `,${text}` : text);
		if (pause && start + SNAPSHOT_ENCODE_BATCH_PAGES < pages.length) await pause();
	}
	parts.push(']}');
	return {
		revision: snapshot.revision,
		...(snapshot.omittedListPages === undefined
			? {}
			: { omittedListPages: snapshot.omittedListPages }),
		json: parts.join(''),
	};
}

/** Decode a payload in the guest, with the same shape check a snapshot always had. Throws when it fails. */
export function decodeSandboxSnapshot(payload: SandboxSnapshotPayload): SandboxIndexSnapshot {
	let decoded: unknown;
	try {
		decoded = JSON.parse(payload.json, dataviewJsonReviver);
	} catch (error) {
		reject(
			`snapshot.json does not parse: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	const snapshot = readSnapshot(decoded, 'snapshot');
	if (snapshot.revision !== payload.revision) {
		reject(`snapshot.json is revision ${snapshot.revision}, not ${payload.revision}`);
	}
	return snapshot;
}

/**
 * A value as plain JSON, copied: whatever else the guest attached (prototypes, `Map`s, `Date`s, accessors) is
 * gone, and so is every `__proto__` key, which `fromWireValue()` would otherwise assign as a prototype.
 */
function readJsonValue(value: unknown, what: string): DataviewWireValue {
	let text: string | undefined;
	try {
		text = JSON.stringify(value);
	} catch {
		reject(`${what} is not JSON`);
	}
	if (typeof text !== 'string') reject(`${what} is not JSON`);
	return JSON.parse(text, (key, item: unknown) =>
		key === '__proto__' ? undefined : item
	) as DataviewWireValue;
}

function readEvalOutcome(value: unknown, what: string): SandboxEvalOutcome {
	const fields = readFields(value, what, ['kind'], ['value', 'message']);
	switch (fields.kind) {
		case 'value':
			if (!('value' in fields)) reject(`${what} of kind "value" has no value`);
			if ('message' in fields) reject(`${what} of kind "value" has a message`);
			return { kind: 'value', value: readJsonValue(fields.value, `${what}.value`) };
		case 'empty':
			if ('value' in fields || 'message' in fields) reject(`${what} of kind "empty" has fields`);
			return { kind: 'empty' };
		case 'error':
			if ('value' in fields) reject(`${what} of kind "error" has a value`);
			return { kind: 'error', message: readString(fields.message, `${what}.message`) };
		default:
			return reject(`${what}.kind is not "value", "empty", or "error"`);
	}
}

function readResult(value: unknown, what: string): DataviewResult {
	const kind = readPlainObject(value, what).kind;
	if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(RESULT_KINDS, kind)) {
		reject(`${what}.kind is not a Dataview result kind`);
	}
	return value as DataviewResult;
}

function parseGuestMessage(raw: unknown): SandboxGuestMessage {
	const size = serializedJsonByteLength(raw);
	if (size === null) reject('guest message is not JSON');
	if (size > SANDBOX_MAX_GUEST_MESSAGE_BYTES) {
		reject(`guest message is ${size} bytes, over the ${SANDBOX_MAX_GUEST_MESSAGE_BYTES}-byte cap`);
	}
	const type = readType(raw, 'guest');
	switch (type) {
		case 'query.dql': {
			const fields = readFields(raw, type, ['type', 'requestId', 'source'], ['originPath']);
			const message: SandboxQueryDqlMessage = {
				type,
				requestId: readId(fields.requestId, `${type}.requestId`),
				source: readString(fields.source, `${type}.source`),
			};
			if ('originPath' in fields) {
				message.originPath = readVaultPath(fields.originPath, `${type}.originPath`);
			}
			return message;
		}
		case 'io.load': {
			const fields = readFields(raw, type, ['type', 'requestId', 'path']);
			return {
				type,
				requestId: readId(fields.requestId, `${type}.requestId`),
				path: readVaultPath(fields.path, `${type}.path`),
			};
		}
		case 'open.link': {
			const fields = readFields(raw, type, ['type', 'kind', 'newTab'], ['path', 'url']);
			const newTab = readBoolean(fields.newTab, `${type}.newTab`);
			if (fields.kind === 'file' && !('url' in fields)) {
				return { type, kind: 'file', path: readVaultPath(fields.path, `${type}.path`), newTab };
			}
			if (fields.kind === 'url' && !('path' in fields)) {
				return { type, kind: 'url', url: readUrl(fields.url, `${type}.url`), newTab };
			}
			return reject(`${type} needs kind "file" with a path, or kind "url" with a url`);
		}
		case 'toggle.task': {
			const fields = readFields(raw, type, ['type', 'path', 'line', 'text']);
			return {
				type,
				path: readVaultPath(fields.path, `${type}.path`),
				line: readInteger(fields.line, `${type}.line`, 1),
				text: readString(fields.text, `${type}.text`),
			};
		}
		case 'index.ready': {
			const fields = readFields(raw, type, ['type', 'runId']);
			return { type, runId: readId(fields.runId, `${type}.runId`) };
		}
		case 'render.done': {
			const fields = readFields(raw, type, ['type', 'blockId', 'runId', 'height']);
			const height = fields.height;
			if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) {
				reject(`${type}.height is not a finite number of at least 0`);
			}
			return {
				type,
				blockId: readId(fields.blockId, `${type}.blockId`),
				runId: readId(fields.runId, `${type}.runId`),
				height,
			};
		}
		case 'render.error': {
			const fields = readFields(raw, type, ['type', 'blockId', 'runId', 'message']);
			return {
				type,
				blockId: readId(fields.blockId, `${type}.blockId`),
				runId: readId(fields.runId, `${type}.runId`),
				message: readString(fields.message, `${type}.message`),
			};
		}
		case 'eval.result': {
			const fields = readFields(raw, type, ['type', 'runId', 'id', 'outcome']);
			return {
				type,
				runId: readId(fields.runId, `${type}.runId`),
				id: readId(fields.id, `${type}.id`),
				outcome: readEvalOutcome(fields.outcome, `${type}.outcome`),
			};
		}
		default:
			return reject(`not a guest message type: ${quote(type)}`);
	}
}

function parseHostMessage(raw: unknown): SandboxHostMessage {
	const type = readType(raw, 'host');
	switch (type) {
		case 'run': {
			const fields = readFields(raw, type, [
				'type',
				'runId',
				'blockId',
				'source',
				'thisPath',
				'snapshot',
			]);
			return {
				type,
				runId: readId(fields.runId, `${type}.runId`),
				blockId: readId(fields.blockId, `${type}.blockId`),
				source: readString(fields.source, `${type}.source`),
				thisPath: readVaultPath(fields.thisPath, `${type}.thisPath`),
				snapshot: readSnapshotPayload(fields.snapshot, `${type}.snapshot`),
			};
		}
		case 'eval': {
			const fields = readFields(raw, type, [
				'type',
				'runId',
				'thisPath',
				'snapshot',
				'expressions',
			]);
			return {
				type,
				runId: readId(fields.runId, `${type}.runId`),
				thisPath: readVaultPath(fields.thisPath, `${type}.thisPath`),
				snapshot: readSnapshotPayload(fields.snapshot, `${type}.snapshot`),
				expressions: readArray(fields.expressions, `${type}.expressions`, (item, itemWhat) => {
					const expression = readFields(item, itemWhat, ['id', 'source']);
					return {
						id: readId(expression.id, `${itemWhat}.id`),
						source: readString(expression.source, `${itemWhat}.source`),
					};
				}),
			};
		}
		case 'query.dql.result': {
			const fields = readFields(raw, type, ['type', 'requestId', 'result']);
			return {
				type,
				requestId: readId(fields.requestId, `${type}.requestId`),
				result: readResult(fields.result, `${type}.result`),
			};
		}
		case 'io.load.result': {
			const fields = readFields(raw, type, ['type', 'requestId', 'text']);
			return {
				type,
				requestId: readId(fields.requestId, `${type}.requestId`),
				text: fields.text === null ? null : readString(fields.text, `${type}.text`),
			};
		}
		case 'request.failed': {
			const fields = readFields(raw, type, ['type', 'requestId', 'message']);
			return {
				type,
				requestId: readId(fields.requestId, `${type}.requestId`),
				message: readString(fields.message, `${type}.message`),
			};
		}
		default:
			return reject(`not a host message type: ${quote(type)}`);
	}
}

/**
 * Check one message received over the sandbox bridge. `from` names the side that SENT it: the host passes
 * `'guest'` for everything a guest posts, so a guest can never send a host message (`run`, a reply), and
 * the guest passes `'host'`. Never throws for a bad message; a thrown error is a bug in this module.
 */
export function parseSandboxMessage(
	raw: unknown,
	from: 'guest'
): SandboxParseResult<SandboxGuestMessage>;
export function parseSandboxMessage(
	raw: unknown,
	from: 'host'
): SandboxParseResult<SandboxHostMessage>;
export function parseSandboxMessage(
	raw: unknown,
	from: SandboxSender
): SandboxParseResult<SandboxMessage> {
	try {
		return { ok: true, message: from === 'guest' ? parseGuestMessage(raw) : parseHostMessage(raw) };
	} catch (error) {
		if (error instanceof SandboxMessageRejected) return { ok: false, reason: error.message };
		throw error;
	}
}
