// Source: src/__tests__/renderer/components/QuickActionsModal/commands/quickChatCommands.test.ts
// Source: src/__tests__/renderer/components/QuickActionsModal/commands/starredSessionCommands.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { buildQuickChatCommands } from '../../../../../renderer/components/QuickActionsModal/commands/quickChatCommands';
import { buildStarredSessionCommands } from '../../../../../renderer/components/QuickActionsModal/commands/starredSessionCommands';
import type { StarredItem } from '../../../../../renderer/hooks/session/useStarredItems';
describeSourceSuite('quickChatCommands', () => {
	function build(overrides: Partial<Parameters<typeof buildQuickChatCommands>[0]> = {}) {
		return buildQuickChatCommands({
			quickChatAvailable: true,
			hotkey: ['Alt', 'Space'],
			openQuickChat: vi.fn(),
			setQuickActionOpen: vi.fn(),
			...overrides,
		});
	}

	describe('buildQuickChatCommands', () => {
		it('offers nothing when Quick Chat is unavailable', () => {
			expect(build({ quickChatAvailable: false })).toEqual([]);
		});

		it('shows the hotkey from the Quick Chat settings', () => {
			const [command] = build({ hotkey: ['Meta', 'Shift', 'K'] });
			expect(command.id).toBe('open-quick-chat');
			expect(command.shortcut?.keys).toEqual(['Meta', 'Shift', 'K']);
		});

		it('shows no chord when the hotkey is unbound', () => {
			const [command] = build({ hotkey: [] });
			expect(command.shortcut).toBeUndefined();
		});

		it('opens the window and closes the palette', () => {
			const openQuickChat = vi.fn();
			const setQuickActionOpen = vi.fn();
			const [command] = build({ openQuickChat, setQuickActionOpen });
			command.action();
			expect(openQuickChat).toHaveBeenCalledTimes(1);
			expect(setQuickActionOpen).toHaveBeenCalledWith(false);
		});
	});
});
describeSourceSuite('starredSessionCommands', () => {
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
			expect(
				buildStarredSessionCommands({ starredItems: [], activateStarredItem: vi.fn() })
			).toEqual([]);
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
});
