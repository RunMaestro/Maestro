import {
	AGENT_ICONS,
	DEFAULT_AGENT_ICON,
	getAgentIcon,
} from '../../../renderer/constants/agentIcons';

describe('agentIcons', () => {
	it('includes OpenClaw in shared icon mapping', () => {
		expect(AGENT_ICONS['openclaw']).toBe('🕸️');
	});

	it('returns configured icon for OpenClaw via getAgentIcon', () => {
		expect(getAgentIcon('openclaw')).toBe('🕸️');
	});

	it('falls back to default icon for unknown agents', () => {
		expect(getAgentIcon('mystery-agent')).toBe(DEFAULT_AGENT_ICON);
	});
});
