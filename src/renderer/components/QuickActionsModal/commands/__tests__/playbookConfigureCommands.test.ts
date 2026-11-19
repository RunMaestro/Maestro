import { describe, expect, it, vi } from 'vitest';
import { buildPlaybookConfigureCommands } from '../playbookConfigureCommands';

describe('buildPlaybookConfigureCommands', () => {
	it('offers nothing without an agent in view', () => {
		expect(
			buildPlaybookConfigureCommands({
				openPlaybookConfigure: vi.fn(),
				setQuickActionOpen: vi.fn(),
				shortcuts: {},
			})
		).toEqual([]);
	});

	it('opens the form on the agent in view and closes the palette', () => {
		const openPlaybookConfigure = vi.fn();
		const setQuickActionOpen = vi.fn();
		const shortcut = { id: 'openPlaybookConfigure', label: 'Configure Playbook', keys: ['Alt'] };
		const [entry] = buildPlaybookConfigureCommands({
			activeAgentId: 'agent-1',
			openPlaybookConfigure,
			setQuickActionOpen,
			shortcuts: { openPlaybookConfigure: shortcut },
		});
		expect(entry.label).toBe('Configure Playbook');
		expect(entry.shortcut).toBe(shortcut);
		entry.action();
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
		expect(openPlaybookConfigure).toHaveBeenCalledWith({ sessionId: 'agent-1' });
	});
});
