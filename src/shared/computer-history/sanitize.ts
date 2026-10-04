/**
 * Computer History - event validation and redaction (pure).
 *
 * The helper is host-owned, but its output is parsed as untrusted input all
 * the same: `validateObservedEvent` rebuilds every event from known fields
 * only (unknown keys never reach disk), and `redactObservedEvent` scrubs
 * secrets from every free-text field and re-applies the byte caps.
 */

import { redactSecrets } from '../redactSecrets';
import { MAX_SNAPSHOT_BYTES, MAX_TEXT_BYTES } from './config';
import { OBSERVED_EVENT_KINDS } from './types';
import type {
	HelperStatus,
	ObservedElement,
	ObservedElementRole,
	ObservedEvent,
	ObservedEventKind,
	TextCommitReason,
} from './types';

const KINDS = new Set<string>(OBSERVED_EVENT_KINDS);
const ROLES = new Set<ObservedElementRole>([
	'text_field',
	'text_area',
	'combo_box',
	'search_field',
	'document',
	'web_area',
	'other',
]);
const REASONS = new Set<TextCommitReason>(['idle', 'blur', 'cleared']);

/** Labels and titles are short by nature; cap them so a hostile app cannot bloat lines. */
const MAX_LABEL_CHARS = 1024;
const MAX_URL_CHARS = 4096;

function str(v: unknown, max: number): string | undefined {
	if (typeof v !== 'string') return undefined;
	return v.length > max ? v.slice(0, max) : v;
}

function validateStatus(raw: unknown): HelperStatus | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const s = raw as Record<string, unknown>;
	const platform = s.platform;
	const state = s.state;
	const permission = s.permission;
	if (platform !== 'macos' && platform !== 'windows' && platform !== 'linux') return undefined;
	if (state !== 'running' && state !== 'paused' && state !== 'blocked') return undefined;
	if (permission !== 'granted' && permission !== 'denied' && permission !== 'not_required') {
		return undefined;
	}
	const out: HelperStatus = {
		version: str(s.version, 64) ?? 'unknown',
		platform,
		state,
		permission,
	};
	if (
		s.accessibilityBus === 'enabled' ||
		s.accessibilityBus === 'disabled' ||
		s.accessibilityBus === 'unavailable'
	) {
		out.accessibilityBus = s.accessibilityBus;
	}
	if (s.session === 'x11' || s.session === 'wayland' || s.session === 'unknown') {
		out.session = s.session;
	}
	const detail = str(s.detail, MAX_LABEL_CHARS);
	if (detail) out.detail = detail;
	return out;
}

/**
 * Rebuild a helper message as an `ObservedEvent`, or null when it is not one.
 * Only known fields survive; a stored-kind event without a valid app is
 * rejected (rules key on the app id).
 */
export function validateObservedEvent(raw: unknown): ObservedEvent | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.kind !== 'string' || !KINDS.has(r.kind)) return null;
	const kind = r.kind as ObservedEventKind;
	const ts = typeof r.ts === 'string' && !Number.isNaN(Date.parse(r.ts)) ? r.ts : null;
	if (!ts) return null;
	const event: ObservedEvent = { v: typeof r.v === 'number' ? r.v : 1, ts, kind };

	if (kind === 'helper.status') {
		const status = validateStatus(r.status);
		if (!status) return null;
		event.status = status;
		return event;
	}
	if (kind === 'helper.error') {
		event.text = str(r.text, MAX_LABEL_CHARS) ?? '';
		return event;
	}

	const app = r.app as Record<string, unknown> | undefined;
	if (!app || typeof app.id !== 'string' || !app.id.trim()) return null;
	event.app = {
		id: app.id.slice(0, 256),
		name: str(app.name, 256) ?? app.id.slice(0, 256),
		pid: typeof app.pid === 'number' && Number.isFinite(app.pid) ? app.pid : -1,
	};
	const aumid = str(app.aumid, 256);
	if (aumid) event.app.aumid = aumid;

	if (r.window && typeof r.window === 'object') {
		const w = r.window as Record<string, unknown>;
		const title = str(w.title, MAX_LABEL_CHARS);
		const url = str(w.url, MAX_URL_CHARS);
		if (title !== undefined || url !== undefined) {
			event.window = {};
			if (title !== undefined) event.window.title = title;
			if (url !== undefined) event.window.url = url;
		}
	}
	if (r.element && typeof r.element === 'object') {
		const e = r.element as Record<string, unknown>;
		const role = ROLES.has(e.role as ObservedElementRole)
			? (e.role as ObservedElementRole)
			: 'other';
		const element: ObservedElement = { role };
		const label = str(e.label, MAX_LABEL_CHARS);
		if (label !== undefined) element.label = label;
		event.element = element;
	}
	if (typeof r.text === 'string') event.text = r.text;
	if (REASONS.has(r.reason as TextCommitReason)) event.reason = r.reason as TextCommitReason;
	if (r.truncated === true) event.truncated = true;
	return event;
}

/** Query parameter names whose values are credentials regardless of shape. */
const SENSITIVE_PARAM_RE =
	/^(?:access_?token|id_?token|refresh_?token|token|auth|authorization|code|key|api_?key|apikey|secret|client_?secret|password|passwd|pwd|sig|signature|session|sessionid|sid|jwt|otp|x-amz-[a-z-]+)$/i;

function redactParams(params: URLSearchParams): boolean {
	let changed = false;
	for (const [key, value] of [...params.entries()]) {
		if (!value) continue;
		let next = value;
		if (SENSITIVE_PARAM_RE.test(key)) next = '[REDACTED_SECRET]';
		else next = redactSecrets(value).text;
		if (next !== value) {
			params.set(key, next);
			changed = true;
		}
	}
	return changed;
}

/**
 * Scrub a URL: drop userinfo, redact credential-named query parameters (and
 * fragment parameters, where OAuth implicit flows put tokens), and run the
 * secret patterns over every other value. Unparseable input falls back to
 * plain-text redaction.
 */
export function redactUrl(url: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return redactSecrets(url).text;
	}
	let changed = false;
	if (parsed.username || parsed.password) {
		parsed.username = '';
		parsed.password = '';
		changed = true;
	}
	if (parsed.search) {
		const params = new URLSearchParams(parsed.search);
		if (redactParams(params)) {
			parsed.search = params.toString();
			changed = true;
		}
	}
	if (parsed.hash.includes('=')) {
		const params = new URLSearchParams(parsed.hash.slice(1));
		if (redactParams(params)) {
			parsed.hash = params.toString();
			changed = true;
		}
	}
	// Path segments can carry tokens too (magic links); the patterns catch the
	// shapes. Only the path: the query and fragment were handled param by param.
	const path = redactSecrets(parsed.pathname);
	if (path.redacted) {
		parsed.pathname = path.text;
		changed = true;
	}
	return changed ? parsed.toString() : url;
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, 'utf-8') <= maxBytes) return { text, truncated: false };
	let bytes = 0;
	let end = 0;
	for (const ch of text) {
		const size = Buffer.byteLength(ch, 'utf-8');
		if (bytes + size > maxBytes) break;
		bytes += size;
		end += ch.length;
	}
	return { text: text.slice(0, end), truncated: true };
}

/** Redact secrets in every free-text field and re-apply the byte caps. */
export function redactObservedEvent(
	event: ObservedEvent,
	caps: { maxTextBytes?: number; maxSnapshotBytes?: number } = {}
): ObservedEvent {
	const out: ObservedEvent = { ...event };
	if (event.window) {
		out.window = { ...event.window };
		if (out.window.title) out.window.title = redactSecrets(out.window.title).text;
		if (out.window.url) out.window.url = redactUrl(out.window.url);
	}
	if (event.element?.label) {
		out.element = { ...event.element, label: redactSecrets(event.element.label).text };
	}
	if (typeof event.text === 'string') {
		const cap =
			event.kind === 'content.snapshot'
				? (caps.maxSnapshotBytes ?? MAX_SNAPSHOT_BYTES)
				: (caps.maxTextBytes ?? MAX_TEXT_BYTES);
		const cut = truncateUtf8(redactSecrets(event.text).text, cap);
		out.text = cut.text;
		if (cut.truncated) out.truncated = true;
	}
	return out;
}
