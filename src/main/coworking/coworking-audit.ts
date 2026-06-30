/**
 * Audit trail for coworking browser tool calls.
 *
 * Every browser tool dispatched by the bridge is recorded (invoked or denied)
 * so users can see what agents did to their browser tabs. The sink is wired once
 * at main bootstrap (`createDefaultBrowserAuditSink`: a system-log line plus a
 * best-effort JSONL append under userData). `recordBrowserAudit` is a no-op until
 * a sink is set, so unit tests stay isolated and can inject a capturing sink.
 *
 * Redaction: page content is never recorded, and free-form `eval` code / typed
 * text are reduced to lengths (never logged verbatim).
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
	/** Public tool name: list_browsers | get_browser_url | read_browser | browser_interact. */
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
			return `url=${op.url.slice(0, 200)}`;
		case 'click':
			return `selector=${op.selector.slice(0, 120)}`;
		case 'type':
			return `selector=${op.selector.slice(0, 120)} textLen=${op.text.length}`;
		case 'eval':
			return `codeLen=${op.code.length}`;
		default:
			return '';
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
		try {
			const file = path.join(app.getPath('userData'), 'coworking-browser-audit.jsonl');
			fs.appendFileSync(file, JSON.stringify(entry) + '\n');
		} catch (err) {
			captureException(err instanceof Error ? err : new Error(String(err)), {
				operation: 'coworking:browserAudit',
			});
		}
	};
}
