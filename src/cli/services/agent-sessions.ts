// Agent Sessions Service for CLI
// Reads Claude Code session files directly from disk without Electron dependencies.
// Supports listing sessions for an agent with sorting, limiting, and keyword search.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Constants (inlined from main/constants.ts to avoid Electron dependencies)
// ============================================================================

const TOKENS_PER_MILLION = 1_000_000;

const CLAUDE_PRICING = {
	INPUT_PER_MILLION: 3,
	OUTPUT_PER_MILLION: 15,
	CACHE_READ_PER_MILLION: 0.3,
	CACHE_CREATION_PER_MILLION: 3.75,
} as const;

const PARSE_LIMITS = {
	FIRST_MESSAGE_SCAN_LINES: 20,
	LAST_TIMESTAMP_SCAN_LINES: 10,
	FIRST_MESSAGE_PREVIEW_LENGTH: 200,
} as const;

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionInfo {
	sessionId: string;
	sessionName?: string;
	projectPath: string;
	timestamp: string;
	modifiedAt: string;
	firstMessage: string;
	messageCount: number;
	sizeBytes: number;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	durationSeconds: number;
	origin?: string;
	starred?: boolean;
}

export interface ListSessionsOptions {
	limit?: number;
	skip?: number;
	search?: string;
}

export interface ListSessionsResult {
	sessions: AgentSessionInfo[];
	totalCount: number;
	filteredCount: number;
}

// ============================================================================
// Origins Store (read from Electron Store JSON on disk)
// ============================================================================

interface StoredOriginData {
	origin?: string;
	sessionName?: string;
	starred?: boolean;
	contextUsage?: number;
}

interface OriginsStore {
	origins: Record<string, Record<string, string | StoredOriginData>>;
}

function readOriginsStore(): OriginsStore {
	const platform = os.platform();
	const home = os.homedir();
	let configDir: string;

	if (platform === 'darwin') {
		configDir = path.join(home, 'Library', 'Application Support', 'Maestro');
	} else if (platform === 'win32') {
		configDir = path.join(
			process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
			'Maestro'
		);
	} else {
		configDir = path.join(
			process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
			'Maestro'
		);
	}

	const filePath = path.join(configDir, 'claude-session-origins.json');

	try {
		const content = fs.readFileSync(filePath, 'utf-8');
		return JSON.parse(content) as OriginsStore;
	} catch {
		return { origins: {} };
	}
}

function getSessionOriginInfo(
	originsStore: OriginsStore,
	projectPath: string,
	sessionId: string
): { sessionName?: string; origin?: string; starred?: boolean } {
	const projectOrigins = originsStore.origins[projectPath];
	if (!projectOrigins) return {};

	const data = projectOrigins[sessionId];
	if (!data) return {};

	if (typeof data === 'string') {
		return { origin: data };
	}

	return {
		origin: data.origin,
		sessionName: data.sessionName,
		starred: data.starred,
	};
}

// ============================================================================
// Session Parsing
// ============================================================================

/** Encode project path the same way Claude Code does: replace / and . with - */
function encodeClaudeProjectPath(projectPath: string): string {
	return projectPath.replace(/[/.]/g, '-');
}

function calculateCost(
	inputTokens: number,
	outputTokens: number,
	cacheReadTokens: number,
	cacheCreationTokens: number
): number {
	return (
		(inputTokens / TOKENS_PER_MILLION) * CLAUDE_PRICING.INPUT_PER_MILLION +
		(outputTokens / TOKENS_PER_MILLION) * CLAUDE_PRICING.OUTPUT_PER_MILLION +
		(cacheReadTokens / TOKENS_PER_MILLION) * CLAUDE_PRICING.CACHE_READ_PER_MILLION +
		(cacheCreationTokens / TOKENS_PER_MILLION) * CLAUDE_PRICING.CACHE_CREATION_PER_MILLION
	);
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.filter((part: { type?: string }) => part.type === 'text')
			.map((part: { type?: string; text?: string }) => part.text || '')
			.filter((text: string) => text.trim())
			.join(' ');
	}
	return '';
}

function parseSessionContent(
	content: string,
	sessionId: string,
	projectPath: string,
	stats: { size: number; mtimeMs: number }
): AgentSessionInfo | null {
	try {
		const lines = content.split('\n').filter((l) => l.trim());

		let firstAssistantMessage = '';
		let firstUserMessage = '';
		let timestamp = new Date(stats.mtimeMs).toISOString();

		const userMessageCount = (content.match(/"type"\s*:\s*"user"/g) || []).length;
		const assistantMessageCount = (content.match(/"type"\s*:\s*"assistant"/g) || []).length;
		const messageCount = userMessageCount + assistantMessageCount;

		for (let i = 0; i < Math.min(lines.length, PARSE_LIMITS.FIRST_MESSAGE_SCAN_LINES); i++) {
			try {
				const entry = JSON.parse(lines[i]);
				if (!firstUserMessage && entry.type === 'user' && entry.message?.content) {
					const textContent = extractTextFromContent(entry.message.content);
					if (textContent.trim()) {
						firstUserMessage = textContent;
						timestamp = entry.timestamp || timestamp;
					}
				}
				if (!firstAssistantMessage && entry.type === 'assistant' && entry.message?.content) {
					const textContent = extractTextFromContent(entry.message.content);
					if (textContent.trim()) {
						firstAssistantMessage = textContent;
						break;
					}
				}
			} catch {
				// Skip malformed lines
			}
		}

		const previewMessage = firstAssistantMessage || firstUserMessage;

		// Fast regex-based token extraction
		let totalInputTokens = 0;
		let totalOutputTokens = 0;
		let totalCacheReadTokens = 0;
		let totalCacheCreationTokens = 0;

		for (const m of content.matchAll(/"input_tokens"\s*:\s*(\d+)/g))
			totalInputTokens += parseInt(m[1], 10);
		for (const m of content.matchAll(/"output_tokens"\s*:\s*(\d+)/g))
			totalOutputTokens += parseInt(m[1], 10);
		for (const m of content.matchAll(/"cache_read_input_tokens"\s*:\s*(\d+)/g))
			totalCacheReadTokens += parseInt(m[1], 10);
		for (const m of content.matchAll(/"cache_creation_input_tokens"\s*:\s*(\d+)/g))
			totalCacheCreationTokens += parseInt(m[1], 10);

		const costUsd = calculateCost(
			totalInputTokens,
			totalOutputTokens,
			totalCacheReadTokens,
			totalCacheCreationTokens
		);

		// Extract last timestamp for duration
		let lastTimestamp = timestamp;
		for (
			let i = lines.length - 1;
			i >= Math.max(0, lines.length - PARSE_LIMITS.LAST_TIMESTAMP_SCAN_LINES);
			i--
		) {
			try {
				const entry = JSON.parse(lines[i]);
				if (entry.timestamp) {
					lastTimestamp = entry.timestamp;
					break;
				}
			} catch {
				// Skip malformed lines
			}
		}

		const startTime = new Date(timestamp).getTime();
		const endTime = new Date(lastTimestamp).getTime();
		const durationSeconds = Math.max(0, Math.floor((endTime - startTime) / 1000));

		return {
			sessionId,
			projectPath,
			timestamp,
			modifiedAt: new Date(stats.mtimeMs).toISOString(),
			firstMessage: previewMessage.slice(0, PARSE_LIMITS.FIRST_MESSAGE_PREVIEW_LENGTH),
			messageCount,
			sizeBytes: stats.size,
			costUsd,
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
			cacheReadTokens: totalCacheReadTokens,
			cacheCreationTokens: totalCacheCreationTokens,
			durationSeconds,
		};
	} catch {
		return null;
	}
}

// ============================================================================
// Public API
// ============================================================================

/**
 * List sessions for a given project path (Claude Code only).
 * Reads .jsonl files from ~/.claude/projects/<encoded-path>/ and returns
 * session metadata sorted by modified date (newest first).
 *
 * @param projectPath - Absolute project directory path (from Maestro session cwd)
 * @param options - Limit and search options
 * @returns List of sessions with metadata
 */
export function listClaudeSessions(
	projectPath: string,
	options: ListSessionsOptions = {}
): ListSessionsResult {
	const { limit = 25, skip = 0, search } = options;

	const encodedPath = encodeClaudeProjectPath(projectPath);
	const projectDir = path.join(os.homedir(), '.claude', 'projects', encodedPath);

	// Check if the directory exists
	if (!fs.existsSync(projectDir)) {
		return { sessions: [], totalCount: 0, filteredCount: 0 };
	}

	// List all .jsonl files
	const files = fs.readdirSync(projectDir).filter((f) => f.endsWith('.jsonl'));

	// Read origins store for session names
	const originsStore = readOriginsStore();

	// Parse each session file
	const sessions: AgentSessionInfo[] = [];
	for (const filename of files) {
		const sessionId = filename.replace('.jsonl', '');
		const filePath = path.join(projectDir, filename);

		try {
			const stats = fs.statSync(filePath);
			if (stats.size === 0) continue; // Skip empty files

			const content = fs.readFileSync(filePath, 'utf-8');
			const session = parseSessionContent(content, sessionId, projectPath, {
				size: stats.size,
				mtimeMs: stats.mtimeMs,
			});

			if (session) {
				// Attach origin info
				const originInfo = getSessionOriginInfo(originsStore, projectPath, sessionId);
				session.sessionName = originInfo.sessionName;
				session.origin = originInfo.origin;
				session.starred = originInfo.starred;
				sessions.push(session);
			}
		} catch {
			// Skip files that can't be read
		}
	}

	// Sort by modified date (newest first)
	sessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

	const totalCount = sessions.length;

	// Apply keyword search filter
	let filtered = sessions;
	if (search) {
		const searchLower = search.toLowerCase();
		filtered = sessions.filter((s) => {
			// Search in session name
			if (s.sessionName?.toLowerCase().includes(searchLower)) return true;
			// Search in first message preview
			if (s.firstMessage.toLowerCase().includes(searchLower)) return true;
			return false;
		});
	}

	const filteredCount = filtered.length;

	// Apply skip and limit for pagination
	const paginated = filtered.slice(skip, skip + limit);

	return { sessions: paginated, totalCount, filteredCount };
}
