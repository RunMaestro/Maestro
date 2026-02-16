/**
 * Group Chats Collector
 *
 * Collects group chat metadata without message content.
 */

import { app } from 'electron';
import { promises as fsPromises } from 'fs';
import * as path from 'path';

export interface GroupChatInfo {
	id: string;
	moderatorAgentId: string;
	participantCount: number;
	participants: Array<{
		agentId: string;
	}>;
	messageCount: number; // Count only, no content
	createdAt: number;
	updatedAt: number;
}

/**
 * Count messages in a group chat log file without loading content.
 */
async function countMessages(logPath: string): Promise<number> {
	try {
		const content = await fsPromises.readFile(logPath, 'utf-8');
		return content.split('\n').filter((line) => line.trim()).length;
	} catch {
		return 0;
	}
}

/**
 * Collect group chat metadata without message content.
 */
export async function collectGroupChats(): Promise<GroupChatInfo[]> {
	const groupChatsPath = path.join(app.getPath('userData'), 'group-chats');
	let files: string[] = [];

	try {
		const stats = await fsPromises.stat(groupChatsPath);
		if (!stats.isDirectory()) {
			return [];
		}
		files = await fsPromises.readdir(groupChatsPath);
	} catch {
		return [];
	}

	const groupChats: GroupChatInfo[] = [];

	for (const file of files) {
		if (!file.endsWith('.json') || file.endsWith('.log.json')) {
			continue;
		}

		const filePath = path.join(groupChatsPath, file);

		try {
			const content = await fsPromises.readFile(filePath, 'utf-8');
			const chat = JSON.parse(content);

			const logPath = path.join(groupChatsPath, `${path.basename(file, '.json')}.log.json`);
			const messageCount = await countMessages(logPath);

			const chatInfo: GroupChatInfo = {
				id: chat.id || path.basename(file, '.json'),
				moderatorAgentId: chat.moderatorAgentId || chat.moderator?.agentId || 'unknown',
				participantCount: Array.isArray(chat.participants) ? chat.participants.length : 0,
				participants: Array.isArray(chat.participants)
					? chat.participants.map((p: any) => ({
							agentId: p.agentId || 'unknown',
						}))
					: [],
				messageCount,
				createdAt: chat.createdAt || 0,
				updatedAt: chat.updatedAt || 0,
			};

			groupChats.push(chatInfo);
		} catch {
			// Skip files that can't be parsed
		}
	}

	return groupChats;
}
