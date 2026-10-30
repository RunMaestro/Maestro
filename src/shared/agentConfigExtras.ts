/**
 * Agent settings the Edit Agent dialog writes and `maestro-cli update-agent`
 * did not reach: the Agent Resilience switches, the Codex auto reset, the
 * Additional Directories list, and parking an environment variable.
 *
 * Two halves, both pure:
 *
 *   - the SPELLING of the flags, read by the CLI (`parseAdditionalDirFlag`);
 *   - the CHECK and the write, run by the app on the agent's own record
 *     (`applyAgentConfigExtras`), with the same helpers the dialog saves with
 *     (`normalizeAdditionalDirectories`, `setKeysParked`).
 *
 * Kept out of the renderer's remote listener so it can be tested without one,
 * and shared so the CLI and the app agree on what a patch may hold.
 */

import { normalizeAdditionalDirectories } from './additionalDirectories';
import { parkedPairKeys, setKeysParked } from './parkedRecords';
import { parsePeerAccessWord } from './peerAgents';
import type { AdditionalDirectory } from './types';

/** `--env-park` and `--env-unpark`, as they travel: the variable names of each. */
export interface EnvParkEdits {
	park?: string[];
	unpark?: string[];
}

/** The boolean switches this module carries, by their key on the agent record. */
export const AGENT_SWITCH_KEYS = [
	'retryOnAvailabilityErrors',
	'retryOnTokenExhaustion',
	'codexAutoResetOnExhaustion',
] as const;
export type AgentSwitchKey = (typeof AGENT_SWITCH_KEYS)[number];

/** The patch keys this module reads. Any other key is somebody else's. */
export const AGENT_CONFIG_EXTRA_KEYS: readonly string[] = [
	...AGENT_SWITCH_KEYS,
	'additionalDirectories',
	'peerDescription',
	'envParkEdits',
];

/** The part of an agent record this module reads and writes. */
export interface AgentConfigExtrasFields {
	peerDescription?: string;
	retryOnAvailabilityErrors?: boolean;
	retryOnTokenExhaustion?: boolean;
	codexAutoResetOnExhaustion?: boolean;
	additionalDirectories?: AdditionalDirectory[];
	customEnvVars?: Record<string, string>;
	customEnvVarsDisabled?: Record<string, string>;
}

export type AgentConfigExtrasResult =
	| { ok: true; updated: Partial<AgentConfigExtrasFields> }
	| { ok: false; error: string };

/**
 * Read one `--additional-dir <path>[:<r|w|rw>]`.
 *
 * The access word never holds a colon and a Windows path does (`C:\work`), so
 * the entry is split at its LAST colon, and only when what follows is an
 * access word. Without one the directory is read-only, which is what a new row
 * in the dialog starts as.
 */
export function parseAdditionalDirFlag(entry: string): AdditionalDirectory {
	const cut = entry.lastIndexOf(':');
	const access = cut > 0 ? parsePeerAccessWord(entry.slice(cut + 1)) : undefined;
	const path = (access ? entry.slice(0, cut) : entry).trim();
	if (!path) {
		throw new Error(`--additional-dir expects <path>[:<r|w|rw>], got "${entry}"`);
	}
	if (access && !access.read && !access.write) {
		throw new Error(
			`--additional-dir "${entry}": a directory needs r, w or rw. Leave it out of the list to remove it.`
		);
	}
	return { path, read: access?.read ?? true, write: access?.write ?? false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNames(value: unknown): string[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) return null;
	return (value as string[]).map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Check the extras in a patch against one agent and work out what to store.
 *
 * `updated` holds only the keys the patch named; a value of `undefined` clears
 * the field. A key this module does not own is ignored, so the caller can hand
 * over the whole patch.
 */
export function applyAgentConfigExtras(
	agent: AgentConfigExtrasFields,
	patch: Record<string, unknown>,
	homeDir?: string
): AgentConfigExtrasResult {
	const updated: Partial<AgentConfigExtrasFields> = {};
	if ('peerDescription' in patch) {
		const value = patch.peerDescription;
		if (value !== null && typeof value !== 'string') {
			return { ok: false, error: 'peerDescription must be text or null.' };
		}
		updated.peerDescription = value?.trim() || undefined;
	}

	// A switch is on, off, or back to its default (`null`). The default is on
	// for the two retries (`resilienceEnabled`), which is why clearing is not
	// the same as `false`.
	for (const key of AGENT_SWITCH_KEYS) {
		if (!(key in patch)) continue;
		const value = patch[key];
		if (value !== null && typeof value !== 'boolean') {
			return { ok: false, error: `${key} must be true, false or null.` };
		}
		updated[key] = value === null ? undefined : value;
	}

	if ('additionalDirectories' in patch) {
		const value = patch.additionalDirectories;
		if (value === null) {
			updated.additionalDirectories = undefined;
		} else {
			const valid =
				Array.isArray(value) &&
				value.every(
					(entry) =>
						isRecord(entry) &&
						typeof entry.path === 'string' &&
						!!entry.path.trim() &&
						typeof entry.read === 'boolean' &&
						typeof entry.write === 'boolean' &&
						(entry.description === undefined || typeof entry.description === 'string')
				);
			if (!valid) {
				return {
					ok: false,
					error: 'additionalDirectories must be a list of { path, read, write } entries, or null.',
				};
			}
			updated.additionalDirectories = normalizeAdditionalDirectories(
				value as AdditionalDirectory[],
				homeDir
			);
		}
	}

	if ('envParkEdits' in patch) {
		const edits = patch.envParkEdits;
		const park = isRecord(edits) ? readNames(edits.park) : null;
		const unpark = isRecord(edits) ? readNames(edits.unpark) : null;
		if (!park || !unpark) {
			return { ok: false, error: 'envParkEdits must be { park?: string[], unpark?: string[] }.' };
		}
		const pair = { active: agent.customEnvVars, parked: agent.customEnvVarsDisabled };
		// `setKeysParked` ignores a name in neither record. A caller that typed a
		// name is told, with the names there are, instead of hearing "done".
		const known = new Set(parkedPairKeys(pair));
		const unknown = [...park, ...unpark].filter((name) => !known.has(name));
		if (unknown.length > 0) {
			return {
				ok: false,
				error: `This agent has no environment variable named ${unknown.join(', ')}. It has: ${
					[...known].join(', ') || 'none'
				}.`,
			};
		}
		const both = park.filter((name) => unpark.includes(name));
		if (both.length > 0) {
			return {
				ok: false,
				error: `${both.join(', ')} cannot be parked and unparked in one change.`,
			};
		}
		const next = setKeysParked(setKeysParked(pair, park, true), unpark, false);
		updated.customEnvVars = next.active;
		updated.customEnvVarsDisabled = next.parked;
	}

	return { ok: true, updated };
}
