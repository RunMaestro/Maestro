/**
 * Computer History - wire and storage types (pure, bundle-safe).
 *
 * One schema for three hops: the `maestro-observer` helper writes these as
 * NDJSON on stdout, the main-process service stores them (after rules and
 * redaction, plus `seq`) in 10-minute segment files, and the CLI and agents
 * read them back. Keeping the stored line identical to the wire line means a
 * reader never has to know which hop it is looking at.
 *
 * The contract is documented for humans in Plans/computer-history-plan.md and
 * for agents in the SCHEMA.md the service writes into the store directory.
 * Bump `COMPUTER_HISTORY_PROTOCOL_VERSION` on any breaking change; the Rust
 * helper (native/maestro-observer) declares the same number.
 */

export const COMPUTER_HISTORY_PROTOCOL_VERSION = 1;

/** Every event kind the helper can emit, in the order docs list them. */
export const OBSERVED_EVENT_KINDS = [
	'app.activated',
	'window.changed',
	'text.committed',
	'selection.changed',
	'content.snapshot',
	'helper.status',
	'helper.error',
] as const;

export type ObservedEventKind = (typeof OBSERVED_EVENT_KINDS)[number];

/** Kinds that describe what the user did. `helper.*` kinds are never stored. */
export const STORED_EVENT_KINDS = [
	'app.activated',
	'window.changed',
	'text.committed',
	'selection.changed',
	'content.snapshot',
] as const satisfies readonly ObservedEventKind[];

export type StoredEventKind = (typeof STORED_EVENT_KINDS)[number];

export type ObservedPlatform = 'macos' | 'windows' | 'linux';

export type ObservedElementRole =
	| 'text_field'
	| 'text_area'
	| 'combo_box'
	| 'search_field'
	| 'document'
	| 'web_area'
	| 'other';

/** Why a `text.committed` event fired. */
export type TextCommitReason = 'idle' | 'blur' | 'cleared';

export interface ObservedApp {
	/** macOS bundle id, Windows lowercase exe name, Linux desktop id or exe name. */
	id: string;
	name: string;
	pid: number;
	/** Windows only: AppUserModelID when the app has one. */
	aumid?: string;
}

export interface ObservedWindow {
	title?: string;
	url?: string;
}

export interface ObservedElement {
	role: ObservedElementRole;
	label?: string;
}

export interface HelperStatus {
	version: string;
	platform: ObservedPlatform;
	/** `blocked` = cannot observe (permission denied, accessibility bus off). */
	state: 'running' | 'paused' | 'blocked';
	permission: 'granted' | 'denied' | 'not_required';
	/** Linux only. */
	accessibilityBus?: 'enabled' | 'disabled' | 'unavailable';
	/** Linux only. */
	session?: 'x11' | 'wayland' | 'unknown';
	detail?: string;
}

export interface ObservedEvent {
	v: number;
	/** UTC ISO-8601 with milliseconds. */
	ts: string;
	kind: ObservedEventKind;
	app?: ObservedApp;
	window?: ObservedWindow;
	element?: ObservedElement;
	text?: string;
	reason?: TextCommitReason;
	truncated?: boolean;
	/** Only on `helper.status`. */
	status?: HelperStatus;
}

/** A line in a segment file: an observed event after rules + redaction. */
export interface StoredEvent extends ObservedEvent {
	kind: StoredEventKind;
	/** Monotonic per segment, starting at 0. */
	seq: number;
}

/** One line of `index.jsonl`, written when a segment closes. */
export interface SegmentIndexEntry {
	/** Store-relative path, forward slashes: `segments/2026-10-03/1410Z.jsonl`. */
	file: string;
	start: string;
	end: string;
	events: number;
	bytes: number;
	/** Event count per `app.id`. */
	apps: Record<string, number>;
}

/** Commands the main process writes to the helper's stdin. */
export type HelperCommand =
	| {
			cmd: 'configure';
			blockApps: string[];
			blockPids: number[];
			blockDomains: string[];
			snapshots: boolean;
			maxTextBytes: number;
			maxSnapshotBytes: number;
	  }
	| { cmd: 'pause' }
	| { cmd: 'resume' }
	| { cmd: 'status' }
	| { cmd: 'enable-accessibility' }
	| { cmd: 'shutdown' };

export type CaptureRuleMatch = 'app' | 'domain';

export interface CaptureRule {
	/** Stable id so `rules remove <id>` is unambiguous. */
	id: string;
	match: CaptureRuleMatch;
	/** App id (exact, case-insensitive) or domain (matches subdomains). */
	value: string;
	action: 'ignore';
}

export interface ComputerHistoryConfig {
	version: 1;
	retentionDays: number;
	maxBytes: number;
	snapshots: boolean;
	rules: CaptureRule[];
	/** ISO timestamp, `'forever'`, or null when recording. */
	pausedUntil: string | null;
	digests: { enabled: boolean; agentId: string | null };
}
