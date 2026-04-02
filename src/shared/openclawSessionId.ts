/**
 * OpenClaw session ID helpers.
 *
 * Maestro stores OpenClaw sessions externally as `{agentName}:{sessionId}` so
 * runtime/session-browser/origins all share the same identifier shape, while
 * filesystem access can still use the raw UUID portion internally.
 */

export interface OpenClawSessionIdParts {
	agentName: string;
	sessionId: string;
}

export const OPENCLAW_SESSION_ID_SEPARATOR = ':';

export function buildOpenClawCompositeSessionId(agentName: string, sessionId: string): string {
	return `${agentName}${OPENCLAW_SESSION_ID_SEPARATOR}${sessionId}`;
}

export function parseOpenClawCompositeSessionId(sessionId: string): OpenClawSessionIdParts | null {
	const idx = sessionId.indexOf(OPENCLAW_SESSION_ID_SEPARATOR);
	if (idx <= 0 || idx >= sessionId.length - 1) {
		return null;
	}

	const rawSessionId = sessionId.slice(idx + 1);
	if (rawSessionId.includes(OPENCLAW_SESSION_ID_SEPARATOR)) {
		return null;
	}

	return {
		agentName: sessionId.slice(0, idx),
		sessionId: rawSessionId,
	};
}

export function isOpenClawCompositeSessionId(sessionId: string): boolean {
	return parseOpenClawCompositeSessionId(sessionId) !== null;
}

export function normalizeOpenClawSessionId(
	sessionId: string,
	agentNameOrOptions?: string | null | { agentName?: string | null }
): string | null {
	if (!sessionId) {
		return sessionId;
	}

	if (isOpenClawCompositeSessionId(sessionId)) {
		return sessionId;
	}

	if (sessionId.includes(OPENCLAW_SESSION_ID_SEPARATOR)) {
		return null;
	}

	const agentName =
		typeof agentNameOrOptions === 'string' ? agentNameOrOptions : agentNameOrOptions?.agentName;

	if (agentName) {
		return buildOpenClawCompositeSessionId(agentName, sessionId);
	}

	return sessionId;
}

export function extractOpenClawAgentNameFromArgs(args?: string[]): string | null {
	if (!args || args.length === 0) {
		return null;
	}

	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--agent' && typeof args[i + 1] === 'string' && args[i + 1].trim()) {
			return args[i + 1].trim();
		}
	}

	return null;
}

export function extractOpenClawAgentNameFromJson(parsed: unknown): string | null {
	if (!parsed || typeof parsed !== 'object') {
		return null;
	}

	const record = parsed as Record<string, unknown>;
	const agentMeta =
		record.meta && typeof record.meta === 'object'
			? ((record.meta as Record<string, unknown>).agentMeta as Record<string, unknown> | undefined)
			: undefined;

	const candidates = [
		agentMeta?.agentId,
		agentMeta?.agentName,
		agentMeta?.agent,
		record.agentId,
		record.agentName,
		record.agent,
	];

	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.trim()) {
			return candidate.trim();
		}
	}

	return null;
}

export function resolveCanonicalOpenClawSessionId(
	sessionId: string,
	knownSessionIds: string[]
): string | null {
	if (!sessionId) {
		return null;
	}

	if (knownSessionIds.includes(sessionId)) {
		return sessionId;
	}

	const parsed = parseOpenClawCompositeSessionId(sessionId);
	const rawSessionId = parsed?.sessionId || sessionId;
	const matches = knownSessionIds.filter((candidate) => {
		const candidateParts = parseOpenClawCompositeSessionId(candidate);
		return candidateParts?.sessionId === rawSessionId;
	});

	return matches.length === 1 ? matches[0] : null;
}

export function buildOpenClawSessionId(agentName: string, rawSessionId: string): string | null {
	if (!agentName?.trim() || !rawSessionId?.trim()) {
		return null;
	}

	if (
		agentName.includes(OPENCLAW_SESSION_ID_SEPARATOR) ||
		rawSessionId.includes(OPENCLAW_SESSION_ID_SEPARATOR)
	) {
		return null;
	}

	return buildOpenClawCompositeSessionId(agentName.trim(), rawSessionId.trim());
}

export function parseOpenClawSessionId(
	sessionId: string | null | undefined
): { agentName: string; rawSessionId: string; compositeId: string } | null {
	if (!sessionId) {
		return null;
	}

	const parsed = parseOpenClawCompositeSessionId(sessionId.trim());
	if (!parsed) {
		return null;
	}

	return {
		agentName: parsed.agentName,
		rawSessionId: parsed.sessionId,
		compositeId: buildOpenClawCompositeSessionId(parsed.agentName, parsed.sessionId),
	};
}

export function isCanonicalOpenClawSessionId(sessionId: string | null | undefined): boolean {
	return parseOpenClawSessionId(sessionId) !== null;
}

export function extractOpenClawRawSessionId(sessionId: string | null | undefined): string | null {
	if (!sessionId) {
		return null;
	}

	const parsed = parseOpenClawSessionId(sessionId);
	if (parsed) {
		return parsed.rawSessionId;
	}

	return sessionId.includes(OPENCLAW_SESSION_ID_SEPARATOR) ? null : sessionId;
}
