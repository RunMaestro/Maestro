export function isStructuredThinkingResponse(content: string): boolean {
	const trimmed = content.trim();
	return (
		trimmed.startsWith('{"') && (trimmed.includes('"confidence"') || trimmed.includes('"message"'))
	);
}
