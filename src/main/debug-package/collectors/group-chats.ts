/**
 * Group Chats Collector
 *
 * Collects group chat metadata without message content.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface GroupChatInfo {
	id: string;
	name: string;
	moderatorAgentId: string;
	participantCount: number;
	participants: Array<{
		name: string;
		agentId: string;
	}>;
	messageCount: number; // Count only, no content
	createdAt: number;
	updatedAt: number;
}

/**
 * Count messages in a group chat log file without loading content.
 */
function countMessages(logPath: string): number {
	try {
		if (!fs.existsSync(logPath)) {
			return 0;
		}
		const content = fs.readFileSync(logPath, 'utf-8');
		// Each line is a JSON message
		return content.split('\n').filter((line) => line.trim()).length;
	} catch {
		return 0;
	}
}

/**
 * Collect group chat metadata without message content.
 */
export async function collectGroupChats(): Promise<GroupChatInfo[]> {
	const groupChats: GroupChatInfo[] = [];

	const groupChatsPath = path.join(app.getPath('userData'), 'group-chats');

	if (!fs.existsSync(groupChatsPath)) {
		return groupChats;
	}

	try {
		const files = fs.readdirSync(groupChatsPath);

		for (const file of files) {
			if (!file.endsWith('.json') || file.endsWith('.log.json')) {
				continue;
			}

			const filePath = path.join(groupChatsPath, file);

			try {
				const content = fs.readFileSync(filePath, 'utf-8');
				const chat = JSON.parse(content);

				// Get corresponding log file for message count
				const logPath = path.join(groupChatsPath, `${path.basename(file, '.json')}.log.json`);
				const messageCount = countMessages(logPath);

				const chatInfo: GroupChatInfo = {
					id: chat.id || path.basename(file, '.json'),
					name: chat.name || 'Unnamed Group',
					moderatorAgentId: chat.moderatorAgentId || chat.moderator?.agentId || 'unknown',
					participantCount: Array.isArray(chat.participants) ? chat.participants.length : 0,
					participants: Array.isArray(chat.participants)
						? chat.participants.map((p: any) => ({
								name: p.name || 'Unknown',
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
	} catch {
		// Directory read failed
	}

	return groupChats;
}
