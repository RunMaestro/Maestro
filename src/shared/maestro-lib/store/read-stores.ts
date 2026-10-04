/**
 * Read-only access to the desktop's store files.
 *
 * Every reader here opens a file with `readFileSync` and nothing else: no
 * directory is created, no default is written back, and a corrupt file is
 * neither quarantined nor repaired. Only the desktop owns these files; a
 * second process that "fixed" one would race the desktop's own writes.
 *
 * No reader throws. A missing, unreadable, or corrupt file comes back as a
 * result the caller can show, because a client that dies on a torn sessions
 * file is useless at exactly the moment the user needs to see what happened.
 *
 * Parsed documents are returned as-is. `agentsOf`, `groupsOf`, and `aiTabsOf`
 * hand back the original objects (filtered, never copied), so every key the
 * file carried is still on them - see `records.ts`.
 */

import * as fs from 'fs';

import type { MaestroPaths } from '../paths/resolve';
import { parseStoreJson } from './corrupt-store';
import type {
	AgentConfigsDocument,
	AgentRecord,
	AITabRecord,
	GroupRecord,
	GroupsDocument,
	SessionsDocument,
	SettingsDocument,
} from './records';

/**
 * The outcome of reading one store file.
 *
 * - `ok`: parsed and the right shape.
 * - `missing`: no file. Normal before the desktop's first run.
 * - `corrupt`: the bytes are not JSON, or the JSON is not the shape this file
 *   always has. Reported with the file left untouched.
 * - `unreadable`: the read itself failed (permissions, a directory in the way).
 */
export type StoreReadResult<T> =
	| { status: 'ok'; file: string; data: T }
	| { status: 'missing'; file: string }
	| { status: 'corrupt'; file: string; reason: string }
	| { status: 'unreadable'; file: string; reason: string; code?: string };

/** Checks a parsed document's shape; returns why it is wrong, or null. */
type ShapeCheck = (value: Record<string, unknown>) => string | null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStoreFile<T>(file: string, checkShape: ShapeCheck): StoreReadResult<T> {
	let content: string;
	try {
		content = fs.readFileSync(file, 'utf-8');
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === 'ENOENT') return { status: 'missing', file };
		return { status: 'unreadable', file, reason: err.message, code: err.code };
	}

	const parsed = parseStoreJson<unknown>(content);
	if (!parsed.ok) return { status: 'corrupt', file, reason: parsed.error.message };
	if (!isPlainObject(parsed.value)) {
		return { status: 'corrupt', file, reason: 'the document is not a JSON object' };
	}
	const shapeError = checkShape(parsed.value);
	if (shapeError) return { status: 'corrupt', file, reason: shapeError };
	return { status: 'ok', file, data: parsed.value as T };
}

/** An optional key, when present, must hold an array. */
function optionalArray(key: string): ShapeCheck {
	return (value) =>
		value[key] === undefined || Array.isArray(value[key]) ? null : `"${key}" is not an array`;
}

/** `maestro-sessions.json`: every agent, its tabs, and their transcripts. */
export function readSessionsStore(file: string): StoreReadResult<SessionsDocument> {
	return readStoreFile(file, optionalArray('sessions'));
}

/** `maestro-groups.json`: the Left Bar groups. */
export function readGroupsStore(file: string): StoreReadResult<GroupsDocument> {
	return readStoreFile(file, optionalArray('groups'));
}

/** `maestro-settings.json`: the desktop's settings. */
export function readSettingsStore(file: string): StoreReadResult<SettingsDocument> {
	return readStoreFile(file, () => null);
}

/** `maestro-agent-configs.json`: per-provider configuration. */
export function readAgentConfigsStore(file: string): StoreReadResult<AgentConfigsDocument> {
	return readStoreFile(file, (value) =>
		value.configs === undefined || isPlainObject(value.configs)
			? null
			: '"configs" is not an object'
	);
}

/** The four store files a read-only client needs, each read independently. */
export interface MaestroStores {
	sessions: StoreReadResult<SessionsDocument>;
	groups: StoreReadResult<GroupsDocument>;
	settings: StoreReadResult<SettingsDocument>;
	agentConfigs: StoreReadResult<AgentConfigsDocument>;
}

/**
 * Read every store a client needs. One corrupt file does not hide the others:
 * a torn settings file must not cost the user their agent list.
 */
export function readMaestroStores(
	paths: Pick<MaestroPaths, 'sessionsFile' | 'groupsFile' | 'settingsFile' | 'agentConfigsFile'>
): MaestroStores {
	return {
		sessions: readSessionsStore(paths.sessionsFile),
		groups: readGroupsStore(paths.groupsFile),
		settings: readSettingsStore(paths.settingsFile),
		agentConfigs: readAgentConfigsStore(paths.agentConfigsFile),
	};
}

function hasStringFields(value: unknown, keys: readonly string[]): boolean {
	return isPlainObject(value) && keys.every((key) => typeof value[key] === 'string');
}

/**
 * The agents in a sessions document, in stored order. An entry without an id,
 * name, and provider is not something a client can show or address, so it is
 * skipped here, but it stays in the document untouched.
 */
export function agentsOf(document: SessionsDocument): AgentRecord[] {
	return (document.sessions ?? []).filter((entry): entry is AgentRecord =>
		hasStringFields(entry, ['id', 'name', 'toolType'])
	);
}

/** The groups in a groups document, in stored order. */
export function groupsOf(document: GroupsDocument): GroupRecord[] {
	return (document.groups ?? []).filter((entry): entry is GroupRecord =>
		hasStringFields(entry, ['id', 'name'])
	);
}

/** An agent's AI tabs, in stored order, hidden consult tabs included. */
export function aiTabsOf(agent: AgentRecord): AITabRecord[] {
	if (!Array.isArray(agent.aiTabs)) return [];
	return agent.aiTabs.filter((entry): entry is AITabRecord => hasStringFields(entry, ['id']));
}

/**
 * The AI tabs a person sees, in tab-strip order. Hidden consult tabs are left
 * out (they have no chip), and the order follows the `ai` entries of
 * `unifiedTabOrder` when the agent has one, with any visible tab the order does
 * not name after them in stored order. This is what `MaestroClient.tabs.list`
 * returns.
 */
export function visibleAiTabsOf(agent: AgentRecord): AITabRecord[] {
	const visible = aiTabsOf(agent).filter((tab) => tab.hidden !== true);
	if (!Array.isArray(agent.unifiedTabOrder)) return visible;
	const byId = new Map(visible.map((tab) => [tab.id, tab]));
	const ordered: AITabRecord[] = [];
	for (const ref of agent.unifiedTabOrder) {
		if (ref?.type !== 'ai') continue;
		const tab = byId.get(ref.id);
		if (tab) {
			ordered.push(tab);
			byId.delete(ref.id);
		}
	}
	return [...ordered, ...visible.filter((tab) => byId.has(tab.id))];
}
