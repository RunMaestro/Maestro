/**
 * Dispatch Audit Log — #444
 *
 * Appends structured JSON lines to <userData>/dispatch-audit.jsonl.
 * One line per event. Never reads back — this is a write-only audit trail.
 *
 * Format per line:
 *   { timestamp, actor, workItemId, type, priorState?, newState?, reason? }
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[DispatchAuditLog]';

export type AuditEventType =
	| 'claim'
	| 'release'
	| 'status_change'
	| 'role_change'
	| 'blocked'
	| 'heartbeat_stale'
	| 'reconcile_stale'
	| 'auto_fix';

export interface AuditEvent {
	timestamp: string;
	actor: string;
	workItemId: string;
	type: AuditEventType;
	priorState?: Record<string, string>;
	newState?: Record<string, string>;
	reason?: string;
}

let auditFilePath: string | undefined;

function getAuditFilePath(): string {
	if (auditFilePath) return auditFilePath;
	try {
		const userData = app.getPath('userData');
		auditFilePath = path.join(userData, 'dispatch-audit.jsonl');
	} catch {
		// app may not be ready yet in tests; fall back to cwd
		auditFilePath = path.join(process.cwd(), 'dispatch-audit.jsonl');
	}
	return auditFilePath;
}

/**
 * Append one audit event to the JSONL file. Non-fatal — failures are logged
 * but do not surface to callers.
 */
export function appendAuditEvent(event: AuditEvent): void {
	const line = JSON.stringify(event) + '\n';
	const filePath = getAuditFilePath();
	try {
		fs.appendFileSync(filePath, line, 'utf8');
	} catch (err) {
		logger.warn(
			`Dispatch audit log write failed: ${err instanceof Error ? err.message : String(err)}`,
			LOG_CONTEXT
		);
	}
}

/**
 * Build and append an audit event in one call.
 */
export function auditLog(
	type: AuditEventType,
	opts: {
		actor: string;
		workItemId: string;
		priorState?: Record<string, string>;
		newState?: Record<string, string>;
		reason?: string;
	}
): void {
	appendAuditEvent({
		timestamp: new Date().toISOString(),
		actor: opts.actor,
		workItemId: opts.workItemId,
		type,
		priorState: opts.priorState,
		newState: opts.newState,
		reason: opts.reason,
	});
}
