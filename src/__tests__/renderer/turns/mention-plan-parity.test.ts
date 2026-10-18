/**
 * Parity: the library's `planMentions` against the desktop's `planCrossAgentMentions`.
 *
 * The desktop plans over its session store; a library client plans over the store records it
 * holds. Both are built from the same roster functions and the same shared timing rules, so for
 * the same roster and message they must agree on the targets, the routing, and whether the source
 * agent is sent to. This feeds both the same cases.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { planCrossAgentMentions } from '../../../renderer/services/crossAgentMentions';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Group, Session } from '../../../renderer/types';
import { planMentions } from '../../../shared/maestro-lib/mentions/roster';
import { createMockSession } from '../../helpers/mockSession';

const SESSIONS: Session[] = [
	createMockSession({ id: 'src', name: 'Frontend' }),
	createMockSession({ id: 'be', name: 'Backend', groupId: 'g-core' }),
	createMockSession({ id: 'docs', name: 'Docs Writer', groupId: 'g-core' }),
	createMockSession({ id: 'site', name: 'RunMaestro.ai' }),
	createMockSession({ id: 'sh', name: 'Shell', toolType: 'terminal' }),
];
const GROUPS = [{ id: 'g-core', name: 'Core', emoji: '', collapsed: false }] as Group[];

const MESSAGES = [
	'hello there',
	'@Backend which branch?',
	'@RunMaestro.ai fix the landing page',
	'@src/app.ts explain this, and ask @Backend',
	'ask @Backend which branch?',
	'what does @Backend think too?',
	'check with @Backend first, then fix the build',
	'based on what @Docs-Writer says, rewrite the intro',
	'look into the flake, then send what you find to @Backend',
	'let @Backend know when this is done',
	'ask @Backend first, then send it to @Docs-Writer',
	'@Docs-Writer @Backend @Docs-Writer compare',
	'@Core please review',
	'@Frontend talk to yourself',
	'see "@Backend" in the log',
];

describe('mention planning parity', () => {
	beforeEach(() => {
		useSessionStore.setState({ sessions: SESSIONS, groups: GROUPS });
	});

	for (const message of MESSAGES) {
		it(message, () => {
			const desktop = planCrossAgentMentions(message, 'src');
			const library = planMentions(message, SESSIONS, GROUPS, 'src');
			expect(
				library && {
					targetSessionIds: library.targetAgentIds,
					routing: library.routing,
					suppressLocal: library.suppressLocal,
				}
			).toEqual(
				// The fields both planners share. `inferredRouting` / `routingSource`
				// describe the composer's routing override, a desktop-only concept.
				desktop && {
					targetSessionIds: desktop.targetSessionIds,
					routing: desktop.routing,
					suppressLocal: desktop.suppressLocal,
				}
			);
		});
	}

	it('covers every routing', () => {
		const routings = new Set(
			MESSAGES.map((message) => planMentions(message, SESSIONS, GROUPS, 'src')?.routing)
		);
		expect(routings).toEqual(new Set([undefined, 'only', 'parallel', 'consult-first', 'handoff']));
	});
});
