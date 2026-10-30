import { describe, expect, it } from 'vitest';
import { codexServerInteraction } from '../../../main/codex-app-server/interaction-requests';
import type { CodexAppServerRequest } from '../../../shared/maestro-lib/codex/protocol';

const context = { sessionId: 'session-a', tabId: 'tab-a', spawnGeneration: 3 };

describe('Codex native interactions', () => {
	it('echoes only an offered native approval decision', () => {
		const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['bun', 'test'] } };
		const interaction = codexServerInteraction(
			{
				id: 1,
				method: 'item/commandExecution/requestApproval',
				params: {
					turnId: 'turn-a',
					itemId: 'item-a',
					reason: 'Run tests?',
					availableDecisions: ['accept', amendment, 'decline', 'cancel'],
				},
			},
			context
		);
		expect(interaction?.request).toMatchObject({
			turnId: 'turn-a',
			toolCallId: 'item-a',
			spawnGeneration: 3,
			options: [
				{ optionId: 'decision-0', kind: 'allow-once' },
				{ optionId: 'decision-1', kind: 'allow-always' },
				{ optionId: 'decision-2', kind: 'reject-once' },
				{ optionId: 'decision-3', kind: 'reject-once' },
			],
		});
		expect(interaction?.answer({ outcome: 'selected', optionId: 'decision-1' })).toEqual({
			result: { decision: amendment },
		});
		expect(interaction?.answer({ outcome: 'cancelled', reason: 'timeout' })).toEqual({
			result: { decision: 'cancel' },
		});
	});

	it('maps permission-profile grants to turn scope and denies on cancellation', () => {
		const interaction = codexServerInteraction(
			{
				id: 1,
				method: 'item/permissions/requestApproval',
				params: { permissions: { network: { enabled: true } } },
			},
			context
		);
		expect(interaction?.answer({ outcome: 'selected', optionId: 'grant' })).toEqual({
			result: { permissions: { network: { enabled: true } }, scope: 'turn' },
		});
		expect(interaction?.answer({ outcome: 'cancelled', reason: 'owner-unavailable' })).toEqual({
			result: { permissions: {} },
		});
	});

	it('returns typed answers for every Codex user-input question', () => {
		const interaction = codexServerInteraction(
			{
				id: 1,
				method: 'item/tool/requestUserInput',
				params: {
					questions: [
						{
							id: 'approach',
							header: 'Approach',
							question: 'Which transport?',
							options: [{ label: 'Native' }, { label: 'Current' }],
						},
						{ id: 'token', question: 'Token?', isSecret: true, isOther: true, options: null },
					],
				},
			},
			context
		);
		expect(interaction?.request.questions).toHaveLength(2);
		expect(interaction?.request.secret).toBe(true);
		expect(
			interaction?.answer({
				outcome: 'answers',
				answers: { approach: 'Native', token: 'secret-value' },
			})
		).toEqual({
			result: {
				answers: {
					approach: { answers: ['Native'] },
					token: { answers: ['secret-value'] },
				},
			},
		});
	});

	it('accepts valid elicitation JSON and declines malformed content', () => {
		const request: CodexAppServerRequest = {
			id: 1,
			method: 'mcpServer/elicitation/request',
			params: { message: 'Provide settings', requestedSchema: { type: 'object' } },
		};
		const interaction = codexServerInteraction(request, context);
		expect(
			interaction?.answer({ outcome: 'answers', answers: { content: '{"enabled":true}' } })
		).toEqual({
			result: { action: 'accept', content: { enabled: true } },
		});
		expect(interaction?.answer({ outcome: 'answers', answers: { content: 'not-json' } })).toEqual({
			result: { action: 'decline' },
		});
	});
});
