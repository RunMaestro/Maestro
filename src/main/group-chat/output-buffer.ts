/**
 * Output buffer management for group chat.
 * Buffers streaming output from group chat processes and releases on process exit.
 */

// Buffer for group chat output (keyed by sessionId)
// We buffer output and only route it on process exit to avoid duplicate messages from streaming chunks
// Uses array of chunks for O(1) append performance instead of O(n) string concatenation
// Tracks totalLength incrementally to avoid O(n) reduce on every append
const groupChatOutputBuffers = new Map<string, { chunks: string[]; totalLength: number }>();

/** Append data to group chat output buffer. O(1) operation. */
export function appendToGroupChatBuffer(sessionId: string, data: string): number {
	let buffer = groupChatOutputBuffers.get(sessionId);
	if (!buffer) {
		buffer = { chunks: [], totalLength: 0 };
		groupChatOutputBuffers.set(sessionId, buffer);
	}
	buffer.chunks.push(data);
	buffer.totalLength += data.length;
	return buffer.totalLength;
}

/** Get buffered output as a single string. Joins chunks on read. */
export function getGroupChatBufferedOutput(sessionId: string): string | undefined {
	const buffer = groupChatOutputBuffers.get(sessionId);
	if (!buffer || buffer.chunks.length === 0) return undefined;
	return buffer.chunks.join('');
}

/** Clear the buffer for a session. Call after processing buffered output. */
export function clearGroupChatBuffer(sessionId: string): void {
	groupChatOutputBuffers.delete(sessionId);
}

/** Check if a session has buffered output. */
export function hasGroupChatBuffer(sessionId: string): boolean {
	const buffer = groupChatOutputBuffers.get(sessionId);
	return buffer !== undefined && buffer.chunks.length > 0;
}
