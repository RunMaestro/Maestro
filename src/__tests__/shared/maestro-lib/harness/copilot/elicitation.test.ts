import { describe, expect, it } from 'vitest';
import type { ElicitationContext } from '@github/copilot-sdk';
import { copilotElicitationResult } from '../../../../../shared/maestro-lib/harness/copilot/elicitation';

function request(required?: string[]): ElicitationContext {
	return {
		sessionId: 'session-a',
		message: 'Values',
		requestedSchema: {
			type: 'object',
			required,
			properties: {
				count: { type: 'number', title: 'Count' },
				enabled: { type: 'boolean', title: 'Enabled' },
				optional: { type: 'string', title: 'Optional' },
				withDefault: { type: 'string', default: 'default' },
			},
		},
	};
}

describe('copilotElicitationResult', () => {
	it('omits unanswered optional fields and applies declared defaults', () => {
		expect(copilotElicitationResult(request(), { outcome: 'answers', answers: {} })).toEqual({
			action: 'accept',
			content: { withDefault: 'default' },
		});
	});

	it('rejects non-finite numeric content and missing required fields', () => {
		expect(
			copilotElicitationResult(request(['count']), {
				outcome: 'answers',
				answers: { count: 'not-a-number' },
			})
		).toEqual({ action: 'decline' });
		expect(
			copilotElicitationResult(request(['count']), { outcome: 'answers', answers: {} })
		).toEqual({
			action: 'decline',
		});
	});

	it('coerces valid boolean and numeric fields', () => {
		expect(
			copilotElicitationResult(request(['count', 'enabled']), {
				outcome: 'answers',
				answers: { count: '2.5', enabled: 'true' },
			})
		).toEqual({ action: 'accept', content: { count: 2.5, enabled: true, withDefault: 'default' } });
	});
});
