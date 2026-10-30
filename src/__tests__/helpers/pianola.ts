/** Attributable, independent native decisions for learning contract tests. */
import type { DecisionPair } from '../../shared/pianola/transcript-mining';

export function createMockNativeDecisionPair(index: string | number = 1): DecisionPair {
	const question = 'Should I run `git status`?';
	const answer = 'Yes, run git status.';
	const askedAt = '2026-10-28T00:00:00.000Z';
	const answeredAt = '2026-10-28T00:00:01.000Z';
	return {
		agent: 'native',
		sessionId: 'fixture-tab',
		classification: {
			kind: 'question',
			risk: 'low',
			topic: question,
			questionText: question,
			confidence: 'high',
			evidence: { messageId: `question-${index}`, reason: 'native question', structured: true },
		},
		ask: question,
		reply: answer,
		polarity: 'affirmative',
		askedAt,
		repliedAt: answeredAt,
		evidence: {
			version: 1,
			sourceKind: 'native-human-resolution',
			principal: 'chris',
			actorId: 'desktop',
			agentId: 'fixture-agent',
			groupId: 'fixture-group',
			tabId: 'fixture-tab',
			questionMessageId: `question-${index}`,
			answerMessageId: `answer-${index}`,
			askedAt,
			answeredAt,
			question,
			answer,
			action: null,
			conditions: null,
		},
	};
}
