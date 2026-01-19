/**
 * @file group-chat-log.ts
 * @description Pipe-delimited log format utilities for Group Chat feature.
 *
 * Log format: TIMESTAMP|FROM|CONTENT
 * - TIMESTAMP: ISO 8601 format (e.g., 2024-01-15T10:30:00.000Z)
 * - FROM: Participant name (user, moderator, or agent name)
 * - CONTENT: Message content with escaped characters
 *
 * Escaping rules (order matters for escaping: backslashes first, then pipes, then newlines):
 * - Backslashes (\) -> \\
 * - Pipes (|) -> \|
 * - Newlines (\n) -> \n
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

/**
 * Message structure for parsed log entries.
 */
export interface GroupChatMessage {
	timestamp: string;
	from: string;
	content: string;
	readOnly?: boolean;
}

/**
 * Escapes content for storage in the pipe-delimited log format.
 * - Backslashes are escaped as \\\\
 * - Pipes are escaped as \\|
 * - Newlines are escaped as \\n
 *
 * Order matters: escape backslashes first, then pipes, then newlines.
 *
 * @param content - Raw content to escape
 * @returns Escaped content safe for log storage
 */
export function escapeContent(content: string): string {
	return content.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '\\n');
}

/**
 * Reverses escaping to restore original content from log format.
 *
 * Uses a single pass with alternation to correctly handle all escape sequences.
 * This prevents issues where \\n (escaped backslash + n) would be incorrectly
 * interpreted as an escaped newline.
 *
 * @param escaped - Escaped content from log
 * @returns Original unescaped content
 */
export function unescapeContent(escaped: string): string {
	// Use a single regex with alternation to handle all escapes correctly.
	// \\\\  matches escaped backslash
	// \\n   matches escaped newline
	// \\|   matches escaped pipe (note: \| in regex is just |, but \\| is backslash-pipe)
	return escaped.replace(/\\\\|\\n|\\\|/g, (match) => {
		switch (match) {
			case '\\\\':
				return '\\';
			case '\\n':
				return '\n';
			case '\\|':
				return '|';
			default:
				return match;
		}
	});
}

/**
 * Appends a message to the chat log file.
 *
 * @param logPath - Path to the log file
 * @param from - Sender name (user, moderator, or participant name)
 * @param content - Message content
 * @param readOnly - Optional flag indicating read-only mode
 */
export async function appendToLog(
	logPath: string,
	from: string,
	content: string,
	readOnly?: boolean
): Promise<void> {
	const timestamp = new Date().toISOString();
	const escapedContent = escapeContent(content);
	// Format: TIMESTAMP|FROM|CONTENT or TIMESTAMP|FROM|CONTENT|readOnly
	const line = readOnly
		? `${timestamp}|${from}|${escapedContent}|readOnly\n`
		: `${timestamp}|${from}|${escapedContent}\n`;

	// Ensure directory exists
	await fs.mkdir(path.dirname(logPath), { recursive: true });

	// Append to file
	await fs.appendFile(logPath, line, 'utf-8');
}

/**
 * Reads and parses the chat log file.
 *
 * @param logPath - Path to the log file
 * @returns Array of parsed messages
 */
export async function readLog(logPath: string): Promise<GroupChatMessage[]> {
	try {
		const content = await fs.readFile(logPath, 'utf-8');

		if (!content.trim()) {
			return [];
		}

		const lines = content.split('\n').filter((line) => line.trim());
		const messages: GroupChatMessage[] = [];

		for (const line of lines) {
			// Find unescaped pipes to split the line
			const pipeIndices: number[] = [];

			for (let i = 0; i < line.length; i++) {
				if (line[i] === '|' && (i === 0 || line[i - 1] !== '\\')) {
					pipeIndices.push(i);
				}
			}

			// Need at least 2 pipes for TIMESTAMP|FROM|CONTENT
			if (pipeIndices.length >= 2) {
				const timestamp = line.substring(0, pipeIndices[0]);
				const from = line.substring(pipeIndices[0] + 1, pipeIndices[1]);

				// Check if there's a 4th field (readOnly flag)
				let escapedContent: string;
				let readOnly = false;

				if (pipeIndices.length >= 3) {
					escapedContent = line.substring(pipeIndices[1] + 1, pipeIndices[2]);
					const flag = line.substring(pipeIndices[2] + 1);
					readOnly = flag === 'readOnly';
				} else {
					escapedContent = line.substring(pipeIndices[1] + 1);
				}

				messages.push({
					timestamp,
					from,
					content: unescapeContent(escapedContent),
					...(readOnly && { readOnly: true }),
				});
			}
		}

		return messages;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
}

/** Allowed image file extensions */
const ALLOWED_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];

/**
 * Save an image to the group chat's images directory.
 * Returns the filename for reference in chat log.
 *
 * @param imagesDir - Path to the images directory
 * @param imageBuffer - The image data as a Buffer
 * @param originalFilename - Original filename to extract extension from
 * @returns The generated filename for the saved image
 * @throws Error if extension is invalid or path traversal is detected
 */
export async function saveImage(
	imagesDir: string,
	imageBuffer: Buffer,
	originalFilename: string
): Promise<string> {
	const ext = path.extname(originalFilename).toLowerCase() || '.png';

	// Validate extension against whitelist
	if (!ALLOWED_IMAGE_EXTENSIONS.includes(ext)) {
		throw new Error(
			`Invalid image extension: ${ext}. Allowed: ${ALLOWED_IMAGE_EXTENSIONS.join(', ')}`
		);
	}

	const filename = `image-${uuidv4().slice(0, 8)}${ext}`;
	const filepath = path.join(imagesDir, filename);

	// Defense-in-depth: verify resolved path stays within expected directory
	const resolvedPath = path.resolve(filepath);
	const resolvedDir = path.resolve(imagesDir);
	if (!resolvedPath.startsWith(resolvedDir + path.sep) && resolvedPath !== resolvedDir) {
		throw new Error('Path traversal attempt detected');
	}

	await fs.mkdir(imagesDir, { recursive: true });
	await fs.writeFile(filepath, imageBuffer);

	return filename;
}
