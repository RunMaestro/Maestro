import { describe, expect, it } from 'vitest';
import type { ElicitationContext } from '@github/copilot-sdk';
import {
	copilotElicitationQuestions,
	copilotElicitationResult,
} from '../../../../../shared/maestro-lib/harness/copilot/elicitation';

function request(
	required?: string[],
	defaults?: { count?: number; enabled?: boolean; formatted?: boolean }
): ElicitationContext {
	return {
		sessionId: 'session-a',
		message: 'Values',
		requestedSchema: {
			type: 'object',
			required,
			properties: {
				count: {
					type: 'number',
					title: 'Count',
					...(defaults?.count !== undefined ? { default: defaults.count } : {}),
				},
				enabled: {
					type: 'boolean',
					title: 'Enabled',
					...(defaults?.enabled !== undefined ? { default: defaults.enabled } : {}),
				},
				optional: {
					type: 'string',
					title: 'Optional',
					description: 'Leave blank if unknown',
					...(defaults?.formatted ? { format: 'email' } : {}),
				},
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

	it('accepts boolean defaults and rejects blank or array numeric answers', () => {
		expect(
			copilotElicitationResult(request([], { enabled: true }), {
				outcome: 'answers',
				answers: {},
			})
		).toEqual({
			action: 'accept',
			content: { enabled: true, withDefault: 'default' },
		});
		for (const count of ['', '  ', ['5']]) {
			expect(
				copilotElicitationResult(request(), {
					outcome: 'answers',
					answers: { count },
				})
			).toEqual({ action: 'decline' });
		}
	});

	it('preserves required state, defaults, descriptions, and choices for the prompt', () => {
		const questions = copilotElicitationQuestions(request(['count'], { enabled: true }));
		expect(questions.find((question) => question.id === 'count')).toMatchObject({
			required: true,
		});
		expect(questions.find((question) => question.id === 'enabled')).toMatchObject({
			required: false,
			default: 'true',
			allowCustom: false,
			options: [
				{ label: 'true', kind: 'choice' },
				{ label: 'false', kind: 'choice' },
			],
		});
		expect(questions.find((question) => question.id === 'optional')).toMatchObject({
			required: false,
			description: 'Leave blank if unknown',
		});
		expect(questions.find((question) => question.id === 'withDefault')).toMatchObject({
			default: 'default',
		});
	});

	it('rejects empty answers that violate formatted string constraints', () => {
		const questions = copilotElicitationQuestions(request([], { formatted: true }));
		expect(questions.find((question) => question.id === 'optional')?.allowEmpty).toBe(false);
		expect(questions.find((question) => question.id === 'withDefault')?.allowEmpty).toBe(true);
	});
});
