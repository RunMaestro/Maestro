/**
 * The mode words have one source: the pill and every surface that counts agents by mode read the
 * same three words, and classify an agent the same way the pill does.
 */

import { describe, it, expect } from 'vitest';
import {
	AGENT_MODE_LABELS,
	agentModeKind,
	agentModePillLabel,
} from '../../../renderer/utils/agentModeLabels';
import { federationBadgeCopy } from '../../../renderer/components/SessionList/FederationBadge';
import { AGENT_MODES, createModeSession } from '../../helpers';

describe('agentModeLabels', () => {
	it('names the three modes with the pill words', () => {
		expect(AGENT_MODE_LABELS).toEqual({ local: 'Local', remote: 'Remote', hosted: 'Hosted' });
		expect(federationBadgeCopy({ kind: 'local' }).label).toBe(agentModePillLabel('local'));
		expect(federationBadgeCopy({ kind: 'ssh', hostReady: false, canFederate: false }).label).toBe(
			agentModePillLabel('remote')
		);
		expect(federationBadgeCopy({ kind: 'hosted', peerName: 'box' }).label).toBe(
			agentModePillLabel('hosted')
		);
	});

	it('classifies each mode the way the pill does', () => {
		expect(AGENT_MODES.map((mode) => agentModeKind(createModeSession(mode), true))).toEqual([
			'local',
			'remote',
			'hosted',
		]);
	});

	it('reads a lifted record as Remote while hosted agents are off', () => {
		expect(agentModeKind(createModeSession('hosted'), false)).toBe('remote');
	});

	it('reads a remote cwd as Remote', () => {
		expect(agentModeKind({ cwd: 'ssh://box/home/me' }, true)).toBe('remote');
	});
});
