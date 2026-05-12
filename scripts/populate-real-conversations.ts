#!/usr/bin/env bun
/**
 * Populate Maestro sessions with real conversation content from Claude Code JSONL files
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

const SESSIONS_PATH = join(
	process.env.HOME || '',
	'Library/Application Support/maestro-dev/maestro-sessions.json'
);

const CLAUDE_PROJECTS_PATH = join(process.env.HOME || '', '.claude/projects');

interface LogEntry {
	id: string;
	timestamp: number;
	source: 'user' | 'stderr' | 'system';
	text: string;
	images?: string[];
	delivered?: boolean;
}

interface AITab {
	id: string;
	agentSessionId: string | null;
	logs: LogEntry[];
	[key: string]: unknown;
}

interface Session {
	id: string;
	name: string;
	aiTabs: AITab[];
	[key: string]: unknown;
}

interface SessionsFile {
	sessions: Session[];
}

// Parse a JSONL file and extract user/assistant messages
function extractConversation(jsonlPath: string): LogEntry[] {
	if (!existsSync(jsonlPath)) {
		console.log(`  JSONL not found: ${jsonlPath}`);
		return [];
	}

	const content = readFileSync(jsonlPath, 'utf-8');
	const lines = content.split('\n').filter((line) => line.trim());
	const logs: LogEntry[] = [];

	for (const line of lines) {
		try {
			const entry = JSON.parse(line);

			if (entry.type === 'user' && entry.message?.content) {
				// User message - only include if content is a string (not tool_result arrays)
				const content = entry.message.content;
				if (typeof content === 'string' && content.trim()) {
					logs.push({
						id: entry.uuid || randomUUID(),
						timestamp: new Date(entry.timestamp).getTime(),
						source: 'user',
						text: content + '\n',
						images: [],
						delivered: true,
					});
				}
				// Skip array content (tool results) - not displayable user messages
			} else if (entry.type === 'assistant' && Array.isArray(entry.message)) {
				// Assistant message - find text content
				const textParts = entry.message
					.filter((m: any) => m.type === 'text' && m.text)
					.map((m: any) => m.text);

				if (textParts.length > 0) {
					logs.push({
						id: entry.uuid || `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
						timestamp: new Date(entry.timestamp).getTime(),
						source: 'stderr', // Maestro uses stderr for AI responses
						text: textParts.join('\n'),
					});
				}
			}
		} catch (e) {
			// Skip invalid JSON lines
		}
	}

	return logs;
}

function main() {
	console.log('Loading Maestro sessions...');
	const sessionsData: SessionsFile = JSON.parse(readFileSync(SESSIONS_PATH, 'utf-8'));

	let updatedCount = 0;

	for (const session of sessionsData.sessions) {
		// Skip LOOKHERE - it already has real data
		if (session.name === 'LOOKHERE') {
			console.log(`Skipping ${session.name} (already has real data)`);
			continue;
		}

		console.log(`\nProcessing session: ${session.name}`);

		for (const tab of session.aiTabs) {
			if (!tab.agentSessionId) {
				console.log(`  Tab ${tab.id.slice(0, 8)}: No agentSessionId, skipping`);
				continue;
			}

			// Force re-process tabs that have [object Object] issues or only placeholder
			const needsReprocess = tab.logs.some(
				(log) =>
					log.text.includes('[object Object]') ||
					(log.source === 'system' && log.text === 'Session loaded from Claude Code')
			);

			if (!needsReprocess && tab.logs.length > 1) {
				console.log(
					`  Tab ${tab.agentSessionId.slice(0, 8).toUpperCase()}: Already has ${tab.logs.length} valid logs, skipping`
				);
				continue;
			}

			// Find the JSONL file for this session
			// Try different project path encodings
			const projectPaths = [
				'-Volumes-VRAM-00-09-System-01-Tools-Maestro',
				'-Volumes-VRAM-00-09-System-01-Tools-transcription-app',
				'-Volumes-VRAM-00-09-System-01-Tools-search-engine',
				'-Volumes-VRAM-00-09-System-01-Tools-ron-biography',
				'-Volumes-VRAM-10-19-Work-10-Hacker-Valley-Media-10-09-technology-10-09-01-website-hvm-website-payloadcms',
				'-Users-ronaldeddings',
			];

			let foundLogs: LogEntry[] = [];

			for (const projectPath of projectPaths) {
				const jsonlPath = join(CLAUDE_PROJECTS_PATH, projectPath, `${tab.agentSessionId}.jsonl`);
				if (existsSync(jsonlPath)) {
					console.log(
						`  Tab ${tab.agentSessionId.slice(0, 8).toUpperCase()}: Found JSONL at ${projectPath}`
					);
					foundLogs = extractConversation(jsonlPath);
					break;
				}
			}

			if (foundLogs.length > 0) {
				tab.logs = foundLogs;
				updatedCount++;
				console.log(
					`  Tab ${tab.agentSessionId.slice(0, 8).toUpperCase()}: Populated ${foundLogs.length} conversation entries`
				);
			} else {
				console.log(
					`  Tab ${tab.agentSessionId.slice(0, 8).toUpperCase()}: No JSONL found or empty conversation`
				);
			}
		}
	}

	// Write back
	console.log(`\nWriting updated sessions (${updatedCount} tabs updated)...`);
	writeFileSync(SESSIONS_PATH, JSON.stringify(sessionsData, null, '\t'));
	console.log('Done!');
}

main();
