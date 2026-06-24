import { describe, it, expect } from 'vitest';
import { prependNewSessionMessage } from '../../shared/newSessionMessage';

describe('prependNewSessionMessage', () => {
	it('prefixes the message with a separator before the prompt', () => {
		expect(prependNewSessionMessage('do the task', 'always check linting')).toBe(
			'always check linting\n\n---\n\ndo the task'
		);
	});

	it('returns the prompt unchanged when no message is provided', () => {
		expect(prependNewSessionMessage('do the task', undefined)).toBe('do the task');
	});

	it('returns the prompt unchanged for an empty or whitespace-only message', () => {
		expect(prependNewSessionMessage('do the task', '')).toBe('do the task');
		expect(prependNewSessionMessage('do the task', '   \n\t')).toBe('do the task');
	});

	it('preserves the original message body (only the empty check is trimmed)', () => {
		// Leading/trailing content inside the message is kept verbatim.
		expect(prependNewSessionMessage('prompt', '  keep me  ')).toBe('  keep me  \n\n---\n\nprompt');
	});
});
