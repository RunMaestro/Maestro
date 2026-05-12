#!/usr/bin/env bun
/**
 * Import large JSONL sessions from ~/.claude/projects/-Volumes-VRAM/
 * into a single Maestro session with multiple aiTabs under VRAM group.
 *
 * Filters: 1MB+, last 10 days, excludes cleaned/ subdirectory
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { randomUUID } from 'crypto';

const HOME = process.env.HOME || '';
const SESSIONS_PATH = join(HOME, 'Library/Application Support/maestro-dev/maestro-sessions.json');
const GROUPS_PATH = join(HOME, 'Library/Application Support/maestro-dev/maestro-groups.json');
const JSONL_DIR = join(HOME, '.claude/projects/-Volumes-VRAM');

const MIN_SIZE = 1 * 1024 * 1024; // 1MB
const MAX_AGE_DAYS = 10;

interface LogEntry {
	id: string;
	timestamp: number;
	source: 'user' | 'stderr' | 'system';
	text: string;
	images?: string[];
	delivered?: boolean;
}

// Extract conversation logs from a JSONL file
function extractConversation(jsonlPath: string): { logs: LogEntry[]; firstUserMsg: string } {
	const content = readFileSync(jsonlPath, 'utf-8');
	const lines = content.split('\n').filter((line) => line.trim());
	const logs: LogEntry[] = [];
	let firstUserMsg = '';

	for (const line of lines) {
		try {
			const entry = JSON.parse(line);

			if (entry.type === 'user' && entry.message?.content) {
				const msgContent = entry.message.content;
				// CRITICAL: Only use STRING content, skip ARRAY (tool results)
				if (typeof msgContent === 'string' && msgContent.trim()) {
					if (!firstUserMsg) {
						firstUserMsg = msgContent.trim().slice(0, 120);
					}
					logs.push({
						id: entry.uuid || randomUUID(),
						timestamp: new Date(entry.timestamp).getTime(),
						source: 'user',
						text: msgContent + '\n',
						images: [],
						delivered: true,
					});
				}
			} else if (entry.type === 'assistant' && Array.isArray(entry.message)) {
				// Assistant message - extract text blocks only
				const textParts = entry.message
					.filter((m: any) => m.type === 'text' && m.text)
					.map((m: any) => m.text);

				if (textParts.length > 0) {
					logs.push({
						id: entry.uuid || `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
						timestamp: new Date(entry.timestamp).getTime(),
						source: 'stderr',
						text: textParts.join('\n'),
					});
				}
			}
		} catch (e) {
			// Skip invalid lines
		}
	}

	return { logs, firstUserMsg };
}

function main() {
	const now = Date.now();
	const cutoff = now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

	console.log(`Scanning ${JSONL_DIR} for files >= 1MB, modified within ${MAX_AGE_DAYS} days...`);

	// Find qualifying files
	const files: { path: string; size: number; mtime: Date; sessionId: string }[] = [];

	for (const entry of readdirSync(JSONL_DIR)) {
		if (!entry.endsWith('.jsonl')) continue;

		const fullPath = join(JSONL_DIR, entry);
		const stat = statSync(fullPath);

		if (stat.size >= MIN_SIZE && stat.mtimeMs >= cutoff) {
			files.push({
				path: fullPath,
				size: stat.size,
				mtime: stat.mtime,
				sessionId: basename(entry, '.jsonl'),
			});
		}
	}

	// Sort by size descending
	files.sort((a, b) => b.size - a.size);

	console.log(`Found ${files.length} qualifying files\n`);

	if (files.length === 0) {
		console.log('No files match criteria. Exiting.');
		return;
	}

	// Load existing sessions and groups
	const sessionsData = JSON.parse(readFileSync(SESSIONS_PATH, 'utf-8'));
	const groupsData = existsSync(GROUPS_PATH)
		? JSON.parse(readFileSync(GROUPS_PATH, 'utf-8'))
		: { groups: [] };

	// Find or create VRAM group
	let vramGroup = groupsData.groups.find((g: any) => g.name === 'VRAM');
	if (!vramGroup) {
		vramGroup = {
			id: randomUUID(),
			name: 'VRAM',
			emoji: '💾',
			collapsed: false,
		};
		groupsData.groups.push(vramGroup);
		writeFileSync(GROUPS_PATH, JSON.stringify(groupsData, null, '\t'));
		console.log(`Created VRAM group: ${vramGroup.id}`);
	} else {
		console.log(`Using existing VRAM group: ${vramGroup.id}`);
	}

	// Check if VRAM session already exists
	const existingVram = sessionsData.sessions.find(
		(s: any) => s.name === 'VRAM Sessions' && s.groupId === vramGroup.id
	);
	if (existingVram) {
		// Remove it so we can recreate fresh
		sessionsData.sessions = sessionsData.sessions.filter((s: any) => s.id !== existingVram.id);
		console.log(`Removed existing VRAM Sessions agent for fresh import`);
	}

	// Build aiTabs from each JSONL file
	const aiTabs: any[] = [];
	const unifiedTabOrder: any[] = [];

	for (const file of files) {
		const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
		process.stdout.write(
			`  Processing ${file.sessionId.slice(0, 8).toUpperCase()} (${sizeMB}MB)... `
		);

		const { logs, firstUserMsg } = extractConversation(file.path);

		if (logs.length === 0) {
			console.log('no displayable content, skipping');
			continue;
		}

		const tabId = randomUUID();

		// Estimate token usage from file size (rough: ~4 chars per token)
		const estimatedTokens = Math.round(file.size / 4);

		aiTabs.push({
			id: tabId,
			agentSessionId: file.sessionId,
			name: null,
			starred: file.size >= 10 * 1024 * 1024, // Star files >= 10MB
			logs: logs,
			inputValue: '',
			stagedImages: [],
			usageStats: {
				inputTokens: estimatedTokens,
				outputTokens: Math.round(estimatedTokens * 0.5),
				cacheReadInputTokens: Math.round(estimatedTokens * 2),
				cacheCreationInputTokens: Math.round(estimatedTokens * 0.2),
				totalCostUsd: Math.round(estimatedTokens * 0.000015 * 100) / 100,
				contextWindow: 200000,
			},
			createdAt: file.mtime.getTime(),
			state: 'idle',
			saveToHistory: true,
			showThinking: 'off',
			awaitingSessionId: false,
			isGeneratingName: false,
			hasUnread: false,
			isAtBottom: true,
			scrollTop: 0,
		});

		unifiedTabOrder.push({ type: 'ai', id: tabId });

		console.log(`${logs.length} entries (first: "${firstUserMsg.slice(0, 60)}...")`);
	}

	console.log(`\nCreated ${aiTabs.length} tabs from ${files.length} files`);

	// Create the VRAM session
	const sessionId = randomUUID();
	const firstTabId = aiTabs[0]?.id || randomUUID();

	// Calculate aggregate usage stats
	const totalInput = aiTabs.reduce(
		(sum: number, t: any) => sum + (t.usageStats?.inputTokens || 0),
		0
	);
	const totalOutput = aiTabs.reduce(
		(sum: number, t: any) => sum + (t.usageStats?.outputTokens || 0),
		0
	);
	const totalCost = aiTabs.reduce(
		(sum: number, t: any) => sum + (t.usageStats?.totalCostUsd || 0),
		0
	);

	const vramSession = {
		id: sessionId,
		groupId: vramGroup.id,
		name: 'VRAM Sessions',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/Volumes/VRAM',
		fullPath: '/Volumes/VRAM',
		projectRoot: '/Volumes/VRAM',
		isGitRepo: true,
		aiLogs: [],
		shellLogs: [
			{
				id: randomUUID(),
				timestamp: now,
				source: 'system',
				text: 'Shell Session Ready.',
			},
		],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 3200,
		isLive: false,
		changedFiles: [],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		fileTreeAutoRefreshInterval: 180,
		shellCwd: '/Volumes/VRAM',
		aiCommandHistory: [],
		shellCommandHistory: [],
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: aiTabs,
		activeTabId: firstTabId,
		filePreviewTabs: [],
		activeFileTabId: null,
		unifiedTabOrder: unifiedTabOrder,
		closedTabHistory: [],
		unifiedClosedTabHistory: [],
		usageStats: {
			inputTokens: totalInput,
			outputTokens: totalOutput,
			cacheReadInputTokens: totalInput * 2,
			cacheCreationInputTokens: Math.round(totalInput * 0.2),
			totalCostUsd: Math.round(totalCost * 100) / 100,
			reasoningTokens: 0,
			contextWindow: 200000,
		},
		agentSessionId: aiTabs[0]?.agentSessionId || null,
		agentCommands: [],
		fileTreeStats: { fileCount: 0, folderCount: 0, totalSize: 0 },
	};

	sessionsData.sessions.push(vramSession);

	// Write back
	console.log(`\nWriting updated sessions...`);
	writeFileSync(SESSIONS_PATH, JSON.stringify(sessionsData, null, '\t'));
	console.log(`Done! Created "VRAM Sessions" with ${aiTabs.length} tabs in VRAM group.`);
	console.log(
		`Aggregate: ~${(totalInput / 1000000).toFixed(1)}M input tokens, $${totalCost.toFixed(2)} estimated cost`
	);
}

main();
