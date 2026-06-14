export function extractStreamingTextFromChunk(chunk: string): string {
	let streamingText = '';

	try {
		const lines = chunk.split('\n').filter((line) => line.trim());
		for (const line of lines) {
			try {
				const msg = JSON.parse(line);

				if (
					msg.type === 'stream_event' &&
					msg.event?.type === 'content_block_delta' &&
					msg.event?.delta?.text
				) {
					streamingText += msg.event.delta.text;
				}
			} catch {
				// Ignore non-JSON lines.
			}
		}
	} catch {
		// Ignore parse errors.
	}

	return streamingText;
}
