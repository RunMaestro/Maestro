// Storage service for CLI
// Reads Electron Store JSON files directly from disk

import * as fs from 'fs';
import * as path from 'path';
import { resolveMaestroUserDataDir } from '../../shared/maestroUserDataDir';
import type { Group, SessionInfo, HistoryEntry, SshRemoteConfig } from '../../shared/types';
import {
	HISTORY_JSONL_EXT,
	HISTORY_LEGACY_JSON_EXT,
	parseHistoryJsonl,
	serializeHistoryEntryLine,
	HistoryFileData,
	PaginationOptions,
	PaginatedResult,
	sanitizeSessionId,
	paginateEntries,
	sortEntriesByTimestamp,
	normalizeHistoryEntries,
} from '../../shared/history';

// Get the Maestro config directory path. Delegates to the shared resolver
// (`src/shared/maestroUserDataDir.ts`) so this CLI and the standalone Cue
// engine runner can never disagree on where Maestro's data lives - see that
// module's doc comment for why `MAESTRO_USER_DATA` and the platform fallback
// are safe to share.
export function getConfigDir(): string {
	return resolveMaestroUserDataDir();
}

/**
 * Read and parse an Electron Store JSON file
 * Returns undefined if file doesn't exist
 */
function readStoreFile<T>(filename: string): T | undefined {
	const filePath = path.join(getConfigDir(), filename);

	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		return JSON.parse(content) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

/**
 * Write a JSON value back to an Electron Store JSON file.
 * Creates the file (and parent directory) if it doesn't exist.
 */
function writeStoreFile<T>(filename: string, data: T): void {
	const dirPath = getConfigDir();
	if (!fs.existsSync(dirPath)) {
		fs.mkdirSync(dirPath, { recursive: true });
	}
	const filePath = path.join(dirPath, filename);
	fs.writeFileSync(filePath, JSON.stringify(data, null, '\t'), 'utf-8');
}

// Store file structures (as used by Electron Store)
interface SessionsStore {
	sessions: SessionInfo[];
	/** Agent the desktop UI currently has selected (400ms-debounced write). */
	activeSessionId?: string;
}

interface GroupsStore {
	groups: Group[];
}

interface HistoryStore {
	entries: HistoryEntry[];
}

interface SettingsStore {
	activeThemeId?: string;
	[key: string]: unknown;
}

interface AgentConfigsStore {
	configs: Record<string, Record<string, unknown>>;
}

/**
 * Read all sessions from storage
 */
export function readSessions(): SessionInfo[] {
	const data = readStoreFile<SessionsStore>('maestro-sessions.json');
	return data?.sessions || [];
}

/**
 * The agent the desktop UI currently has selected, or null when the app has
 * never recorded one. Lives in the sessions store file next to the agents
 * themselves, so this is the same read `readSessions` already does.
 */
export function readActiveAgentId(): string | null {
	const data = readStoreFile<SessionsStore>('maestro-sessions.json');
	const id = data?.activeSessionId;
	return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Read all groups from storage
 */
export function readGroups(): Group[] {
	const data = readStoreFile<GroupsStore>('maestro-groups.json');
	return data?.groups || [];
}

// ============================================================================
// Per-Session History Helpers
// ============================================================================

/**
 * Check if migration to per-session history format has been completed
 */
function hasMigrated(): boolean {
	const markerPath = path.join(getConfigDir(), 'history-migrated.json');
	return fs.existsSync(markerPath);
}

/**
 * Get the history directory path
 */
function getHistoryDir(): string {
	return path.join(getConfigDir(), 'history');
}

/**
 * Get file path for a session's history file
 */
function getSessionHistoryPath(sessionId: string): string {
	const safeId = sanitizeSessionId(sessionId);
	return path.join(getHistoryDir(), `${safeId}${HISTORY_JSONL_EXT}`);
}

/**
 * Get file path for a session's legacy single-object history file. Present
 * only until the desktop app migrates that session to JSONL.
 */
function getLegacySessionHistoryPath(sessionId: string): string {
	const safeId = sanitizeSessionId(sessionId);
	return path.join(getHistoryDir(), `${safeId}${HISTORY_LEGACY_JSON_EXT}`);
}

/**
 * Read history entries for a specific session, newest first.
 *
 * Reads JSONL when present and falls back to the legacy object otherwise. The
 * CLI deliberately does NOT migrate: the desktop app owns that conversion, and
 * having two processes race to rewrite the same file is what this format change
 * exists to eliminate. Reading both means the CLI stays correct either way.
 */
function readSessionHistory(sessionId: string): HistoryEntry[] {
	const jsonlPath = getSessionHistoryPath(sessionId);
	if (fs.existsSync(jsonlPath)) {
		try {
			// File order is oldest-first; callers expect newest-first.
			return normalizeHistoryEntries(
				parseHistoryJsonl(fs.readFileSync(jsonlPath, 'utf-8')).entries.reverse()
			);
		} catch {
			return [];
		}
	}

	const legacyPath = getLegacySessionHistoryPath(sessionId);
	if (!fs.existsSync(legacyPath)) {
		return [];
	}
	try {
		const data: HistoryFileData = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
		// Re-map legacy cross-agent consults (written as AUTO before the AGENT type
		// existed), matching HistoryManager.getEntries in the app.
		return normalizeHistoryEntries(data.entries || []);
	} catch {
		return [];
	}
}

/**
 * List all sessions that have history files, in either format.
 */
function listSessionsWithHistory(): string[] {
	const historyDir = getHistoryDir();
	if (!fs.existsSync(historyDir)) {
		return [];
	}
	const sessionIds = new Set<string>();
	for (const file of fs.readdirSync(historyDir)) {
		if (file.endsWith(HISTORY_JSONL_EXT)) {
			sessionIds.add(file.slice(0, -HISTORY_JSONL_EXT.length));
		} else if (file.endsWith(HISTORY_LEGACY_JSON_EXT)) {
			sessionIds.add(file.slice(0, -HISTORY_LEGACY_JSON_EXT.length));
		}
	}
	return Array.from(sessionIds);
}

/**
 * Read history entries from storage
 * Supports both legacy single-file and new per-session format.
 * Optionally filter by project path or session ID.
 */
export function readHistory(projectPath?: string, sessionId?: string): HistoryEntry[] {
	// If migrated and sessionId provided, use new per-session format
	if (hasMigrated()) {
		if (sessionId) {
			// Direct lookup for specific session
			return readSessionHistory(sessionId);
		}

		if (projectPath) {
			// Get all entries for sessions in this project
			const sessions = listSessionsWithHistory();
			const entries: HistoryEntry[] = [];
			for (const sid of sessions) {
				const sessionEntries = readSessionHistory(sid);
				// Check if this session belongs to the project (first entry has projectPath)
				if (sessionEntries.length > 0 && sessionEntries[0].projectPath === projectPath) {
					entries.push(...sessionEntries);
				}
			}
			return sortEntriesByTimestamp(entries);
		}

		// Return all entries (global view)
		const sessions = listSessionsWithHistory();
		const allEntries: HistoryEntry[] = [];
		for (const sid of sessions) {
			allEntries.push(...readSessionHistory(sid));
		}
		return sortEntriesByTimestamp(allEntries);
	}

	// Fall back to legacy format
	const data = readStoreFile<HistoryStore>('maestro-history.json');
	let entries = data?.entries || [];

	if (projectPath) {
		entries = entries.filter((e) => e.projectPath === projectPath);
	}

	if (sessionId) {
		entries = entries.filter((e) => e.sessionId === sessionId);
	}

	return entries;
}

/**
 * Read history entries from storage with pagination support
 * Supports both legacy single-file and new per-session format.
 * Optionally filter by project path or session ID.
 */
export function readHistoryPaginated(options?: {
	projectPath?: string;
	sessionId?: string;
	pagination?: PaginationOptions;
}): PaginatedResult<HistoryEntry> {
	const { projectPath, sessionId, pagination } = options || {};
	const entries = readHistory(projectPath, sessionId);
	return paginateEntries(entries, pagination);
}

/**
 * Read settings from storage
 */
export function readSettings(): SettingsStore {
	const data = readStoreFile<SettingsStore>('maestro-settings.json');
	return data || {};
}

/**
 * Read a single setting value, supporting dot-notation for nested keys.
 * E.g., readSettingValue('encoreFeatures.directorNotes') traverses into the object.
 * Returns undefined if the key doesn't exist.
 */
export function readSettingValue(key: string): unknown {
	const settings = readSettings();
	return getNestedValue(settings, key);
}

/**
 * Write a single setting value, supporting dot-notation for nested keys.
 * Returns true on success.
 */
export function writeSettingValue(key: string, value: unknown): boolean {
	const settings = readSettings();
	setNestedValue(settings, key, value);
	writeStoreFile('maestro-settings.json', settings);
	return true;
}

/**
 * Delete a setting key (reset to default by removing from store).
 * Supports dot-notation for nested keys.
 * Returns true if the key existed and was removed.
 */
export function deleteSettingValue(key: string): boolean {
	const settings = readSettings();
	const removed = deleteNestedValue(settings, key);
	if (removed) {
		writeStoreFile('maestro-settings.json', settings);
	}
	return removed;
}

// --- Nested key helpers ---

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
	const parts = path.split('.');
	let current: unknown = obj;
	for (const part of parts) {
		if (current === null || current === undefined || typeof current !== 'object') {
			return undefined;
		}
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split('.');
	let current: Record<string, unknown> = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i];
		if (
			current[part] === undefined ||
			current[part] === null ||
			typeof current[part] !== 'object'
		) {
			current[part] = {};
		}
		current = current[part] as Record<string, unknown>;
	}
	current[parts[parts.length - 1]] = value;
}

function deleteNestedValue(obj: Record<string, unknown>, path: string): boolean {
	const parts = path.split('.');
	let current: Record<string, unknown> = obj;
	for (let i = 0; i < parts.length - 1; i++) {
		const part = parts[i];
		if (current[part] === undefined || typeof current[part] !== 'object') {
			return false;
		}
		current = current[part] as Record<string, unknown>;
	}
	const lastKey = parts[parts.length - 1];
	if (lastKey in current) {
		delete current[lastKey];
		return true;
	}
	return false;
}

/**
 * Read agent configurations from storage
 * This includes custom paths set by the user in the desktop app
 */
export function readAgentConfigs(): Record<string, Record<string, unknown>> {
	const data = readStoreFile<AgentConfigsStore>('maestro-agent-configs.json');
	return data?.configs || {};
}

/**
 * Get the custom path for a specific agent (e.g., 'claude-code')
 * Returns undefined if no custom path is configured
 */
export function getAgentCustomPath(agentId: string): string | undefined {
	const configs = readAgentConfigs();
	const agentConfig = configs[agentId];
	if (agentConfig && typeof agentConfig.customPath === 'string' && agentConfig.customPath) {
		return agentConfig.customPath;
	}
	return undefined;
}

/**
 * Read the full config for a specific agent.
 * Returns an empty object if no config exists for this agent.
 */
export function readAgentConfig(agentId: string): Record<string, unknown> {
	const configs = readAgentConfigs();
	return configs[agentId] || {};
}

/**
 * Read a single agent config value.
 */
export function readAgentConfigValue(agentId: string, key: string): unknown {
	const config = readAgentConfig(agentId);
	return config[key];
}

/**
 * Write a single agent config value.
 */
export function writeAgentConfigValue(agentId: string, key: string, value: unknown): boolean {
	const data = readStoreFile<AgentConfigsStore>('maestro-agent-configs.json') || { configs: {} };
	if (!data.configs[agentId]) {
		data.configs[agentId] = {};
	}
	data.configs[agentId][key] = value;
	writeStoreFile('maestro-agent-configs.json', data);
	return true;
}

/**
 * Delete a single agent config key.
 * Returns true if the key existed and was removed.
 */
export function deleteAgentConfigValue(agentId: string, key: string): boolean {
	const data = readStoreFile<AgentConfigsStore>('maestro-agent-configs.json');
	if (!data?.configs?.[agentId] || !(key in data.configs[agentId])) {
		return false;
	}
	delete data.configs[agentId][key];
	// Clean up empty agent config objects
	if (Object.keys(data.configs[agentId]).length === 0) {
		delete data.configs[agentId];
	}
	writeStoreFile('maestro-agent-configs.json', data);
	return true;
}

/**
 * Resolve a partial ID to a full ID
 * Returns: { id, ambiguous, matches }
 * - If exact match found, returns that ID
 * - If single prefix match found, returns that ID
 * - If multiple matches, returns ambiguous: true with all matches
 * - If no match, returns undefined id
 */
export interface IdResolution {
	id?: string;
	ambiguous: boolean;
	matches: string[];
}

function resolveId(partialId: string, allIds: string[]): IdResolution {
	// First try exact match
	if (allIds.includes(partialId)) {
		return { id: partialId, ambiguous: false, matches: [partialId] };
	}

	// Try prefix match
	const matches = allIds.filter((id) => id.startsWith(partialId));

	if (matches.length === 1) {
		return { id: matches[0], ambiguous: false, matches };
	} else if (matches.length > 1) {
		return { id: undefined, ambiguous: true, matches };
	}

	return { id: undefined, ambiguous: false, matches: [] };
}

/**
 * Resolve an agent ID (partial or full)
 * Throws if ambiguous or not found
 */
export function resolveAgentId(partialId: string): string {
	const sessions = readSessions();
	const allIds = sessions.map((s) => s.id);
	const resolution = resolveId(partialId, allIds);

	if (resolution.ambiguous) {
		const matchList = resolution.matches
			.map((id) => {
				const session = sessions.find((s) => s.id === id);
				return `  ${id.slice(0, 8)}  ${session?.name || 'Unknown'}`;
			})
			.join('\n');
		throw new Error(`Ambiguous agent ID '${partialId}'. Matches:\n${matchList}`);
	}

	if (resolution.id) {
		return resolution.id;
	}

	// Fall back to an exact, case-insensitive display-name match so callers can
	// pass an agent's name and not just its ID. Group-chat participants know
	// their own name (via {{PARTICIPANT_NAME}}) but not their session ID, so
	// `--agent "<name>"` must work for them.
	const lower = partialId.toLowerCase();
	const byName = sessions.filter((s) => s.name.toLowerCase() === lower);
	if (byName.length === 1) {
		return byName[0].id;
	}
	if (byName.length > 1) {
		const matchList = byName.map((s) => `  ${s.id.slice(0, 8)}  ${s.name}`).join('\n');
		throw new Error(`Ambiguous agent name '${partialId}'. Matches:\n${matchList}`);
	}

	// Last resort: match on the READABLE name, ignoring leading/trailing
	// decoration. Users prefix agent names with an emoji far more often than not
	// ("📜 Substrate PedTome"), and both a human and an agent will type the name
	// they READ, which is the part after the glyph. Without this the exact match
	// above fails on a name that is on screen, and the caller concludes the agent
	// does not exist.
	const readable = readableAgentName(partialId);
	if (readable) {
		const byReadable = sessions.filter((s) => readableAgentName(s.name) === readable);
		if (byReadable.length === 1) {
			return byReadable[0].id;
		}
		if (byReadable.length > 1) {
			const matchList = byReadable.map((s) => `  ${s.id.slice(0, 8)}  ${s.name}`).join('\n');
			throw new Error(`Ambiguous agent name '${partialId}'. Matches:\n${matchList}`);
		}
	}

	throw new Error(`Agent not found: ${partialId}`);
}

/**
 * An agent name reduced to what a person would read aloud: lowercased, with
 * leading and trailing non-alphanumerics (emoji, symbols, whitespace) removed.
 * Returns '' for a name that is nothing but decoration, which never matches -
 * two emoji-only names are not the same agent.
 */
function readableAgentName(name: string): string {
	return name
		.toLowerCase()
		.replace(/^[^\p{L}\p{N}]+/u, '')
		.replace(/[^\p{L}\p{N}]+$/u, '')
		.trim();
}

/**
 * Resolve a group ID (partial or full)
 * Throws if ambiguous or not found
 */
export function resolveGroupId(partialId: string): string {
	const groups = readGroups();
	const allIds = groups.map((g) => g.id);
	const resolution = resolveId(partialId, allIds);

	if (resolution.ambiguous) {
		const matchList = resolution.matches
			.map((id) => {
				const group = groups.find((g) => g.id === id);
				return `  ${id}  ${group?.name || 'Unknown'}`;
			})
			.join('\n');
		throw new Error(`Ambiguous group ID '${partialId}'. Matches:\n${matchList}`);
	}

	if (!resolution.id) {
		throw new Error(`Group not found: ${partialId}`);
	}

	return resolution.id;
}

/**
 * Returns the mtime (ms since epoch) of a session's history file as a cheap
 * recency proxy. Returns 0 when the file doesn't exist or can't be stat'd, so
 * sessions that have never been used sort below ones that have.
 */
export function getSessionHistoryMtimeMs(sessionId: string): number {
	try {
		return fs.statSync(getSessionHistoryPath(sessionId)).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * Get a session by ID (supports partial IDs)
 */
export function getSessionById(sessionId: string): SessionInfo | undefined {
	const sessions = readSessions();

	// First try exact match
	const exact = sessions.find((s) => s.id === sessionId);
	if (exact) return exact;

	// Try prefix match
	const matches = sessions.filter((s) => s.id.startsWith(sessionId));
	if (matches.length === 1) {
		return matches[0];
	}

	return undefined;
}

/**
 * Get sessions by group ID (supports partial IDs)
 */
export function getSessionsByGroup(groupId: string): SessionInfo[] {
	const sessions = readSessions();
	const groups = readGroups();

	// Resolve group ID
	const allGroupIds = groups.map((g) => g.id);

	// Exact match first
	if (allGroupIds.includes(groupId)) {
		return sessions.filter((s) => s.groupId === groupId);
	}

	// Prefix match
	const matches = allGroupIds.filter((id) => id.startsWith(groupId));
	if (matches.length === 1) {
		return sessions.filter((s) => s.groupId === matches[0]);
	}

	return [];
}

/**
 * Get the config directory path (exported for playbooks service)
 */
export function getConfigDirectory(): string {
	return getConfigDir();
}

/**
 * Add a history entry
 * Supports both legacy single-file and new per-session format.
 */
export function addHistoryEntry(entry: HistoryEntry): void {
	try {
		if (hasMigrated()) {
			// Use new per-session format - skip entries without sessionId
			if (!entry.sessionId) {
				// Cannot store entries without a sessionId in per-session format
				return;
			}
			const sessionId = entry.sessionId;
			const historyDir = getHistoryDir();

			// Ensure history directory exists
			if (!fs.existsSync(historyDir)) {
				fs.mkdirSync(historyDir, { recursive: true });
			}

			// Append one line. `appendFileSync` opens with O_APPEND, so the
			// kernel seeks to EOF as part of the write and this cannot overwrite
			// bytes the desktop app is writing concurrently. Critically there is
			// no read-modify-write here any more: the old version read the whole
			// file, unshifted, and rewrote it, which could silently drop an entry
			// the app added in between (a cross-process lost update the in-process
			// write queue could not prevent).
			//
			// Trimming is deliberately NOT done here. Rotation is the one
			// remaining whole-file rewrite and the desktop app owns it; a second
			// process trimming the same file is exactly the destructive race this
			// format change removes.
			fs.appendFileSync(
				getSessionHistoryPath(sessionId),
				serializeHistoryEntryLine(entry),
				'utf-8'
			);
		} else {
			// Use legacy format
			const filePath = path.posix.join(getConfigDir(), 'maestro-history.json');
			const data = readStoreFile<HistoryStore>('maestro-history.json') || { entries: [] };

			data.entries.unshift(entry); // Add to beginning (most recent first)

			fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
		}
	} catch (error) {
		// Log error but don't throw - history writing shouldn't break playbook execution
		console.error(
			`[WARNING] Failed to write history entry: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

// ============================================================================
// SSH Remote Helpers
// ============================================================================

/**
 * Read all SSH remote configurations from settings
 */
export function readSshRemotes(): SshRemoteConfig[] {
	const settings = readSettings();
	return (settings.sshRemotes as SshRemoteConfig[]) || [];
}

/**
 * Write SSH remotes array back to settings
 */
export function writeSshRemotes(remotes: SshRemoteConfig[]): void {
	writeSettingValue('sshRemotes', remotes);
}

/**
 * Resolve an SSH remote ID (partial or full)
 * Throws if ambiguous or not found
 */
export function resolveSshRemoteId(partialId: string): string {
	const remotes = readSshRemotes();
	const allIds = remotes.map((r) => r.id);
	const resolution = resolveId(partialId, allIds);

	if (resolution.ambiguous) {
		const matchList = resolution.matches
			.map((id) => {
				const remote = remotes.find((r) => r.id === id);
				return `  ${id.slice(0, 8)}  ${remote?.name || 'Unknown'}`;
			})
			.join('\n');
		throw new Error(`Ambiguous SSH remote ID '${partialId}'. Matches:\n${matchList}`);
	}

	if (!resolution.id) {
		throw new Error(`SSH remote not found: ${partialId}`);
	}

	return resolution.id;
}
