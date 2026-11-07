import type { ProfileSpawnOverrides } from '../profiles/types';

/** A Board-owned worker and its preserved migration metadata. */
export interface StoredBoardWorker {
	agentId: string;
	enabled: boolean;
	paused: boolean;
	payload: Record<string, unknown>;
}

/** Worker-local edits only. null removes an override and restores inheritance. */
export type BoardWorkerOptionsPatch = {
	[K in keyof ProfileSpawnOverrides]?: string | null;
};

export interface BoardWorkerOptionsCommand {
	agentId: string;
	expectedPayload: string;
	patch: BoardWorkerOptionsPatch;
}

export function parseBoardWorkerOptionsCommand(raw: unknown): BoardWorkerOptionsCommand | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const value = raw as Record<string, unknown>;
	if (
		Object.keys(value).some((key) => !['agentId', 'expectedPayload', 'patch'].includes(key)) ||
		typeof value.agentId !== 'string' ||
		!value.agentId.trim() ||
		value.agentId.includes('\0') ||
		typeof value.expectedPayload !== 'string'
	)
		return null;
	const patch = parseBoardWorkerOptionsPatch(value.patch);
	return patch ? { agentId: value.agentId, expectedPayload: value.expectedPayload, patch } : null;
}

export const BOARD_WORKER_OPTION_FIELDS = [
	'customModel',
	'customEffort',
	'appendSystemPrompt',
	'customArgs',
] as const satisfies readonly (keyof ProfileSpawnOverrides)[];

/** Retain future compatible fields, but never pass them to the spawn API. */
export function readBoardWorkerOptions(raw: unknown): ProfileSpawnOverrides | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const value = raw as Record<string, unknown>;
	const result: ProfileSpawnOverrides = {};
	for (const field of BOARD_WORKER_OPTION_FIELDS) {
		if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
		const entry = value[field];
		if (
			typeof entry !== 'string' ||
			entry.includes('\0') ||
			((field === 'customModel' || field === 'customEffort') && !entry.trim())
		)
			return null;
		result[field] = entry;
	}
	return result;
}

/** Strict mutation parser shared by main and preload's declared contract. */
export function parseBoardWorkerOptionsPatch(raw: unknown): BoardWorkerOptionsPatch | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const value = raw as Record<string, unknown>;
	if (
		Object.keys(value).some(
			(key) => !BOARD_WORKER_OPTION_FIELDS.includes(key as keyof ProfileSpawnOverrides)
		)
	)
		return null;
	const nonNull = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null));
	return readBoardWorkerOptions(nonNull) ? (value as BoardWorkerOptionsPatch) : null;
}
