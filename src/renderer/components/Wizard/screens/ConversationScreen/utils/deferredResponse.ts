const DEFERRED_RESPONSE_PATTERNS = [
	/let me (?:research|investigate|look into|think about|analyze|examine|check|explore)/i,
	/give me a (?:moment|minute|second)/i,
	/i(?:'ll| will) (?:look into|research|investigate|get back|check)/i,
	/(?:researching|investigating|looking into) (?:this|that|it)/i,
	/let me (?:take a )?(?:closer )?look/i,
];

export function containsDeferredResponsePhrase(message: string): boolean {
	return DEFERRED_RESPONSE_PATTERNS.some((pattern) => pattern.test(message));
}

export const AUTO_CONTINUE_MESSAGE = 'Please proceed with your analysis.';
