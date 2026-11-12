/** Bounded in-memory group replies spill to a private file instead of dropping bytes. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MAX_GROUP_CHAT_BUFFER_SIZE } from '../constants';

const MAX_REPLY_CHARACTERS = 64 * 1024 * 1024;
const buffers = new Map<
	string,
	{ chunks: string[]; length: number; dir?: string; error?: string }
>();

export function appendToGroupChatBuffer(sessionId: string, data: string): number {
	let b = buffers.get(sessionId);
	if (!b) {
		b = { chunks: [], length: 0 };
		buffers.set(sessionId, b);
	}
	if (b.error) return b.length;
	try {
		if (b.length + data.length > MAX_REPLY_CHARACTERS)
			throw new Error('reply exceeds 64 MiB character budget');
		if (!b.dir && b.length + data.length > MAX_GROUP_CHAT_BUFFER_SIZE) {
			b.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-reply-'));
			fs.chmodSync(b.dir, 0o700);
			fs.writeFileSync(path.join(b.dir, 'reply'), b.chunks.join(''), { mode: 0o600 });
			b.chunks = [];
		}
		if (b.dir) fs.appendFileSync(path.join(b.dir, 'reply'), data);
		else b.chunks.push(data);
		b.length += data.length;
	} catch {
		b.error =
			'Reply capture failed: output storage unavailable or reply budget exceeded. Automatic retry stopped.';
	}
	return b.length;
}
export function getGroupChatBufferedOutput(sessionId: string): string | undefined {
	const b = buffers.get(sessionId);
	if (!b) return undefined;
	if (b.error) return b.error;
	try {
		return b.dir ? fs.readFileSync(path.join(b.dir, 'reply'), 'utf8') : b.chunks.join('');
	} catch {
		return 'Reply capture failed: saved output cannot be read. Automatic retry stopped.';
	}
}
export function clearGroupChatBuffer(sessionId: string): void {
	const b = buffers.get(sessionId);
	if (b?.dir) fs.rmSync(b.dir, { recursive: true, force: true });
	buffers.delete(sessionId);
}
export function hasGroupChatBuffer(sessionId: string): boolean {
	return buffers.has(sessionId);
}
/** Compatibility: output is never silently truncated; storage failure is explicit. */
export function isGroupChatBufferTruncated(_sessionId: string): boolean {
	return false;
}
