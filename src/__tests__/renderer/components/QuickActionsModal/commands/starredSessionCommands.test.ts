import { describe, expect, it, vi } from 'vitest';
import { buildStarredSessionCommands } from '../../../../../renderer/components/QuickActionsModal/commands/starredSessionCommands';
import type { StarredItem } from '../../../../../renderer/hooks/session/useStarredItems';

const openItem: StarredItem = {
	kind: 'open',
	key: 'open:agent-1:tab-1',
	displayName: 'Refactor parser',
	agentName: 'Atlas',
	parentSessionId: 'agent-1',
	tabId: 'tab-1',
};

const closedItem: StarredItem = {
	kind: 'closed',
	key: 'closed:claude-code:abc',
	displayName: 'Release checklist',
	agentName: 'Hermes',
	parentSessionId: 'agent-2',
	agentId: 'claude-code',
	agentSessionId: 'abc',
	projectPath: '/proj',
	sessionName: 'Release checklist',
};

describe('buildStarredSessionCommands', () => {
	it('returns nothing when no session is starred', () => {
		expect(buildStarredSessionCommands({ starredItems: [], activateStarredItem: vi.fn() })).toEqual(
			[]
		);
	});

	it('emits one entry per starred session, open and closed alike', () => {
		const actions = buildStarredSessionCommands({
			starredItems: [openItem, closedItem],
			activateStarredItem: vi.fn(),
		});
		expect(actions.map((a) => a.id)).toEqual([
			'starred-open:agent-1:tab-1',
			'starred-closed:claude-code:abc',
		]);
		expect(actions[0].subtext).toBe('Open tab');
		expect(actions[1].subtext).toMatch(/resume/i);
	});

	it('puts the session and agent names in the label, since the palette filters on it', () => {
		const [action] = buildStarredSessionCommands({
			starredItems: [openItem],
			activateStarredItem: vi.fn(),
		});
		const label = action.label.toLowerCase();
		expect(label).toContain('starred');
		expect(label).toContain('refactor parser');
		expect(label).toContain('atlas');
	});

	it('activates the item through the shared Left Bar path', () => {
		const activateStarredItem = vi.fn();
		const actions = buildStarredSessionCommands({
			starredItems: [openItem, closedItem],
			activateStarredItem,
		});
		actions[1].action();
		expect(activateStarredItem).toHaveBeenCalledWith(closedItem);
	});
});
