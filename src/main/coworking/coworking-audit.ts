/**
 * Audit trail for coworking tool calls (browser AND terminal).
 *
 * Every coworking tool dispatched by the bridge is recorded (invoked or denied)
 * so users can see what agents did to their browser tabs and terminals. The sink
 * is wired once at main bootstrap (`createDefaultBrowserAuditSink`: a system-log
 * line plus a best-effort JSONL append under userData). `recordBrowserAudit` is
 * a no-op until a sink is set, so unit tests stay isolated and can inject a
 * capturing sink.
 *
 * Redaction: page/terminal content is never recorded; free-form `eval` code and
 * typed text are reduced to lengths; navigate/newTab URLs are stripped to
 * origin+path (query strings and fragments, where auth tokens live, are
 * reduced to character counts). The JSONL sink is written owner-only (0600).
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import type { BrowserOp } from '../../shared/coworkingBrowser';

export interface BrowserAuditEntry {
	ts: number;
	sessionId: string;
	/** Agent type (ToolType) of the owning session, when known. */
	agentType?: string;
	/** Public tool name: list_terminals | read_terminal | list_browsers | get_browser_url | read_browser | browser_interact. */
	tool: string;
	/** Interaction op kind (navigate/click/type/eval/...) when tool is browser_interact. */
	opKind?: string;
	/** Redacted, truncated summary of the args. Never page content or verbatim code. */
	detail?: string;
	/** Outcome: ok = completed, error = threw/failed, denied = permission gate blocked it. */
	status: 'ok' | 'error' | 'denied';
}

export type BrowserAuditSink = (entry: BrowserAuditEntry) => void;

let sink: BrowserAuditSink | null = null;

/** Wire the audit sink. Called once at main bootstrap; tests inject a capturing sink. */
export function setBrowserAuditSink(custom: BrowserAuditSink | null): void {
	sink = custom;
}

/** Record one coworking browser tool call. No-op until a sink is wired. */
export function recordBrowserAudit(entry: BrowserAuditEntry): void {
	if (!sink) return;
	sink(entry);
}

/** Redacted one-line summary of an interaction op for the audit detail field. */
export function redactBrowserOpDetail(op: BrowserOp): string {
	switch (op.kind) {
		case 'navigate':
			return `url=${redactUrl(op.url)}`;
		case 'click':
			return `selector=${op.selector.slice(0, 120)}`;
		case 'type':
			return `selector=${op.selector.slice(0, 120)} textLen=${op.text.length}`;
		case 'eval':
			return `codeLen=${op.code.length}`;
		case 'waitFor':
			return `selector=${op.selector.slice(0, 120)}${op.timeoutMs !== undefined ? ` timeoutMs=${op.timeoutMs}` : ''}`;
		case 'newTab':
			return `${op.url !== undefined ? `url=${redactUrl(op.url)}` : 'url=<default>'}${op.ephemeral ? ' ephemeral' : ''}`;
		default:
			return '';
	}
}

/** Strip query string and fragment from a URL before it hits the audit log,
 *  that's where session tokens and magic-link secrets live. Non-URL navigate
 *  targets (search text) are reduced to a character count: free-form search
 *  queries can carry secrets just like query strings, so they never log verbatim. */
function redactUrl(raw: string): string {
	try {
		const u = new URL(raw);
		const query = u.search.length > 1 ? ` queryChars=${u.search.length - 1}` : '';
		const hash = u.hash.length > 1 ? ` hashChars=${u.hash.length - 1}` : '';
		return `${u.origin}${u.pathname}${query}${hash}`;
	} catch {
		return `<non-url textChars=${raw.length}>`;
	}
}

/** Soft cap on the JSONL audit file. Past this size we stop appending rather
 *  than rotate: the trail is best-effort, and rotating on the main process
 *  would cost more than the lost lines are worth. */
const MAX_AUDIT_FILE_BYTES = 5 * 1024 * 1024;

/** Best-effort, non-blocking append of one audit line. Skips the write once the
 *  file passes the soft size cap. Never rejects: failures go to Sentry so a
 *  disk/permission error can't crash the main process. */
async function appendAuditLine(file: string, line: string): Promise<void> {
	try {
		const existing = await fs.promises.stat(file).catch(() => null);
		if (existing && existing.size >= MAX_AUDIT_FILE_BYTES) return;
		// mode 0600 applies when the file is first created so the audit trail
		// isn't world/group-readable.
		await fs.promises.appendFile(file, line, { mode: 0o600 });
	} catch (err) {
		captureException(err instanceof Error ? err : new Error(String(err)), {
			operation: 'coworking:browserAudit',
		});
	}
}

/** Default sink: a system-log line (visible in the Log Viewer) plus a best-effort
 *  JSONL append under userData. */
export function createDefaultBrowserAuditSink(): BrowserAuditSink {
	return (entry) => {
		const op = entry.opKind ? `:${entry.opKind}` : '';
		const detail = entry.detail ? ` ${entry.detail}` : '';
		logger.info(
			`[Coworking][Browser] ${entry.status} ${entry.tool}${op} session=${entry.sessionId}${entry.agentType ? ' agent=' + entry.agentType : ''}${detail}`,
			'Coworking'
		);
		const file = path.join(app.getPath('userData'), 'coworking-browser-audit.jsonl');
		// Fire-and-forget: appending must never block the Electron main event
		// loop on a coworking tool call. Errors are captured inside appendAuditLine.
		void appendAuditLine(file, JSON.stringify(entry) + '\n');
	};
}
