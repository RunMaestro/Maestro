/**
 * Conversational PRD Planner — deterministic stub gateway
 *
 * Simulates multi-phase planning without calling an LLM:
 *   Turn 1: captures problem, asks about users.
 *   Turn 2: captures users, asks about success criteria.
 *   Turn 3: captures successCriteria, asks about scope.
 *   Turn 4: captures scope, asks about constraints.
 *   Turn 5+: emits ready-to-finalize.
 */

import type {
	ConversationalPrdGateway,
	ConversationalPrdGatewayRequest,
	ConversationalPrdGatewayResponse,
} from './gateway';

export class StructuredConversationalPrdGateway implements ConversationalPrdGateway {
	async respond(
		request: ConversationalPrdGatewayRequest
	): Promise<ConversationalPrdGatewayResponse> {
		const userTurnIndex = request.history.filter((m) => m.role === 'user').length;
		return buildTurnResponse(userTurnIndex, request.userMessage);
	}
}

function buildTurnResponse(
	userTurnIndex: number,
	userMessage: string
): ConversationalPrdGatewayResponse {
	switch (userTurnIndex) {
		case 0:
			return {
				messageToUser:
					"Got it \u2014 I've noted the problem. Who are the primary users of this feature? " +
					'Is it developers, end-users, team leads, or another group?',
				prdDraftDelta: { problem: userMessage },
				status: 'gathering',
			};

		case 1:
			return {
				messageToUser:
					'Understood. What are the success criteria for this feature? ' +
					'Describe at least one measurable outcome \u2014 something we can observe or test.',
				prdDraftDelta: { users: userMessage },
				status: 'gathering',
			};

		case 2:
			return {
				messageToUser:
					'Good. What is the bounded scope of the solution? ' +
					"Describe what is in scope for this PRD \u2014 we can capture what's out of scope next.",
				prdDraftDelta: { successCriteria: userMessage },
				status: 'gathering',
			};

		case 3:
			return {
				messageToUser:
					'Noted. Are there any hard constraints \u2014 platform requirements, ' +
					'performance budgets, compliance needs, or a delivery deadline? ' +
					'If not, just say "none" and I will finalize the draft.',
				prdDraftDelta: { scope: userMessage },
				status: 'gathering',
			};

		default: {
			const isNone = /^\s*(none|n\/a|no)\s*$/i.test(userMessage);
			const constraintDelta = isNone ? {} : { constraints: userMessage };
			const notesDelta =
				userTurnIndex > 4
					? { notes: `Additional context from turn ${userTurnIndex + 1}: ${userMessage}` }
					: {};

			return {
				messageToUser:
					"I've captured the following PRD fields: problem, users, successCriteria, scope. " +
					'The draft looks complete. Does everything look right? ' +
					'If yes, click "Commit to Work Graph" to create the PRD item.',
				prdDraftDelta: {
					...constraintDelta,
					...notesDelta,
					title: 'New Feature (confirm or update this title)',
				},
				status: 'ready-to-finalize',
			};
		}
	}
}
