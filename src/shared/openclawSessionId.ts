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

function normalizeOpenClawIdentifier(value: string | null | undefined): string | null {
	if (typeof value !== 'string') {
		return null;
	}

	const trimmedValue = value.trim();
	return trimmedValue || null;
}

export function buildOpenClawCompositeSessionId(agentName: string, sessionId: string): string {
	return `${agentName}${OPENCLAW_SESSION_ID_SEPARATOR}${sessionId}`;
}

export function parseOpenClawCompositeSessionId(sessionId: string): OpenClawSessionIdParts | null {
	const trimmedSessionId = sessionId.trim();
	if (!trimmedSessionId) {
		return null;
	}

	const idx = trimmedSessionId.indexOf(OPENCLAW_SESSION_ID_SEPARATOR);
	if (idx <= 0 || idx >= trimmedSessionId.length - 1) {
		return null;
	}

	const agentName = trimmedSessionId.slice(0, idx).trim();
	const rawSessionId = trimmedSessionId.slice(idx + 1).trim();
	if (rawSessionId.includes(OPENCLAW_SESSION_ID_SEPARATOR)) {
		return null;
	}
	if (!agentName || !rawSessionId) {
		return null;
	}

	return {
		agentName,
		sessionId: rawSessionId,
	};
}

export function isOpenClawCompositeSessionId(sessionId: string): boolean {
	return parseOpenClawCompositeSessionId(sessionId) !== null;
}

export function normalizeOpenClawSessionId(
	sessionId: string | null | undefined,
	agentNameOrOptions?: string | null | { agentName?: string | null }
): string | null {
	if (typeof sessionId !== 'string') {
		return null;
	}

	const trimmedSessionId = sessionId.trim();
	if (!trimmedSessionId) {
		return trimmedSessionId;
	}

	const parsedComposite = parseOpenClawCompositeSessionId(trimmedSessionId);
	if (parsedComposite) {
		return buildOpenClawCompositeSessionId(parsedComposite.agentName, parsedComposite.sessionId);
	}

	if (trimmedSessionId.includes(OPENCLAW_SESSION_ID_SEPARATOR)) {
		return null;
	}

	const agentName =
		typeof agentNameOrOptions === 'string' ? agentNameOrOptions : agentNameOrOptions?.agentName;

	if (agentName?.trim()) {
		return buildOpenClawCompositeSessionId(agentName.trim(), trimmedSessionId);
	}

	return trimmedSessionId;
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

	const queue: unknown[] = [parsed];
	const visited = new Set<unknown>();

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || typeof current !== 'object' || visited.has(current)) {
			continue;
		}

		visited.add(current);
		const record = current as Record<string, unknown>;
		const agentMeta =
			record.meta && typeof record.meta === 'object'
				? ((record.meta as Record<string, unknown>).agentMeta as
						| Record<string, unknown>
						| undefined)
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
			const normalizedCandidate = normalizeOpenClawIdentifier(
				candidate as string | null | undefined
			);
			if (normalizedCandidate) {
				return normalizedCandidate;
			}
		}

		for (const nestedKey of ['result', 'meta', 'error', 'data']) {
			const nested = record[nestedKey];
			if (nested && typeof nested === 'object') {
				queue.push(nested);
			}
		}
	}

	return null;
}

export function extractOpenClawSessionIdFromJson(
	parsed: unknown,
	agentNameOrOptions?: string | null | { agentName?: string | null }
): string | null {
	if (!parsed || typeof parsed !== 'object') {
		return null;
	}

	const fallbackAgentName =
		typeof agentNameOrOptions === 'string'
			? normalizeOpenClawIdentifier(agentNameOrOptions)
			: normalizeOpenClawIdentifier(agentNameOrOptions?.agentName);
	const resolvedAgentName = fallbackAgentName ?? extractOpenClawAgentNameFromJson(parsed);
	const queue: unknown[] = [parsed];
	const visited = new Set<unknown>();

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || typeof current !== 'object' || visited.has(current)) {
			continue;
		}

		visited.add(current);
		const record = current as Record<string, unknown>;
		const agentMeta =
			record.meta && typeof record.meta === 'object'
				? ((record.meta as Record<string, unknown>).agentMeta as
						| Record<string, unknown>
						| undefined)
				: undefined;

		const candidates = [
			record.session_id,
			record.sessionId,
			agentMeta?.sessionId,
			agentMeta?.session_id,
		];

		for (const candidate of candidates) {
			const normalizedCandidate = normalizeOpenClawIdentifier(
				candidate as string | null | undefined
			);
			if (!normalizedCandidate) {
				continue;
			}

			return (
				normalizeOpenClawSessionId(normalizedCandidate, {
					agentName: resolvedAgentName,
				}) || normalizedCandidate
			);
		}

		for (const nestedKey of ['result', 'meta', 'error', 'data']) {
			const nested = record[nestedKey];
			if (nested && typeof nested === 'object') {
				queue.push(nested);
			}
		}
	}

	return null;
}

export function resolveCanonicalOpenClawSessionId(
	sessionId: string,
	knownSessionIds: string[]
): string | null {
	const trimmedSessionId = sessionId.trim();
	if (!trimmedSessionId) {
		return null;
	}

	if (knownSessionIds.includes(trimmedSessionId)) {
		return trimmedSessionId;
	}

	const parsed = parseOpenClawCompositeSessionId(trimmedSessionId);
	const rawSessionId = parsed?.sessionId || trimmedSessionId;
	const matches = knownSessionIds.filter((candidate) => {
		const candidateParts = parseOpenClawCompositeSessionId(candidate);
		return candidateParts?.sessionId === rawSessionId;
	});

	return matches.length === 1 ? matches[0] : null;
}

export function buildOpenClawSessionId(agentName: string, rawSessionId: string): string | null {
	const normalizedAgentName = normalizeOpenClawIdentifier(agentName);
	const normalizedRawSessionId = normalizeOpenClawIdentifier(rawSessionId);

	if (!normalizedAgentName || !normalizedRawSessionId) {
		return null;
	}

	const parsedComposite = parseOpenClawSessionId(normalizedRawSessionId);
	if (parsedComposite) {
		return parsedComposite.agentName === normalizedAgentName ? parsedComposite.compositeId : null;
	}

	if (
		normalizedAgentName.includes(OPENCLAW_SESSION_ID_SEPARATOR) ||
		normalizedRawSessionId.includes(OPENCLAW_SESSION_ID_SEPARATOR)
	) {
		return null;
	}

	return buildOpenClawCompositeSessionId(normalizedAgentName, normalizedRawSessionId);
}

export function parseOpenClawSessionId(
	sessionId: string | null | undefined
): { agentName: string; rawSessionId: string; compositeId: string } | null {
	if (!sessionId) {
		return null;
	}

	const parsed = parseOpenClawCompositeSessionId(sessionId);
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
	const normalizedSessionId = normalizeOpenClawIdentifier(sessionId);
	if (!normalizedSessionId) {
		return null;
	}

	const parsed = parseOpenClawSessionId(normalizedSessionId);
	if (parsed) {
		return parsed.rawSessionId;
	}

	return normalizedSessionId.includes(OPENCLAW_SESSION_ID_SEPARATOR) ? null : normalizedSessionId;
}
