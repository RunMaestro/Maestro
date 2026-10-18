import { describe, expect, it } from 'vitest';
import {
	MENTION_ROUTING_COPY,
	MENTION_ROUTING_ORDER,
} from '../../../../../renderer/components/InputArea/components/mentionRoutingCopy';
import {
	inferMentionTiming,
	messageStartsWithAgentMention,
	type MentionRouting,
} from '../../../../../shared/crossAgentContext';

/** The routing the wording rules give a message, as `planCrossAgentMentions` decides it. */
function routeByWording(message: string): MentionRouting {
	return messageStartsWithAgentMention(message) ? 'only' : inferMentionTiming(message);
}

describe('mentionRoutingCopy', () => {
	it('lists every routing exactly once', () => {
		expect([...MENTION_ROUTING_ORDER].sort()).toEqual(Object.keys(MENTION_ROUTING_COPY).sort());
	});

	// The hint teaches these phrasings; one that routed elsewhere would teach
	// the user the wrong thing.
	it.each(MENTION_ROUTING_ORDER)('every %s example routes to that mode', (mode) => {
		for (const example of MENTION_ROUTING_COPY[mode].examples) {
			expect(routeByWording(example), example).toBe(mode);
		}
	});
});
