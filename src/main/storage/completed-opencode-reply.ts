/** Turn-bound OpenCode reply reader. Accepts a read-only SQLite connection. */
interface ReplyDatabase {
	prepare(sql: string): {
		get(...params: (string | number)[]): unknown;
		all(...params: (string | number)[]): unknown[];
	};
}
export function readCompletedReply(
	db: ReplyDatabase,
	sessionId: string,
	startedAt: number,
	expectedMessageId?: string
): { messageId: string; text: string } | null {
	if (!Number.isFinite(startedAt) || !sessionId) return null;

	const user = db
		.prepare(
			`SELECT id, time_created FROM message
   WHERE session_id = ? AND time_created >= ? AND json_extract(data, '$.role') = 'user'
   ORDER BY time_created DESC, id DESC LIMIT 1`
		)
		.get(sessionId, startedAt) as { id: string; time_created: number } | undefined;
	if (!user) return null;
	const answer = db
		.prepare(
			`SELECT id, data FROM message
   WHERE session_id = ? AND time_created >= ? AND json_extract(data, '$.role') = 'assistant'
   AND json_extract(data, '$.parentID') = ? ORDER BY time_created DESC, id DESC LIMIT 1`
		)
		.get(sessionId, user.time_created, user.id) as { id: string; data: string } | undefined;
	if (!answer || (expectedMessageId && answer.id !== expectedMessageId)) return null;
	const meta = JSON.parse(answer.data);
	if (!meta.time?.completed || meta.finish !== 'stop' || meta.error) return null;
	const rows = db
		.prepare(
			`SELECT data FROM part WHERE session_id = ? AND message_id = ?
   ORDER BY time_created, id`
		)
		.all(sessionId, answer.id) as { data: string }[];
	const text = rows
		.map((row) => JSON.parse(row.data))
		.filter((part) => part.type === 'text' && !part.ignored && !part.synthetic)
		.map((part) => part.text || '')
		.join('');
	return text.trim() ? { messageId: answer.id, text } : null;
}
