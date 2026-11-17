import { describe, expect, it, vi } from 'vitest';
import { buildPromptLinksCommands } from '../promptLinksCommands';

function build(overrides: Partial<Parameters<typeof buildPromptLinksCommands>[0]> = {}) {
	return buildPromptLinksCommands({
		promptLinksEnabled: true,
		activeAgent: { id: 'agent-1', name: 'Research' },
		openPromptLinks: vi.fn(),
		setQuickActionOpen: vi.fn(),
		shortcuts: {},
		...overrides,
	});
}

describe('buildPromptLinksCommands', () => {
	it('offers nothing while the Prompt Links Encore Feature is off', () => {
		expect(build({ promptLinksEnabled: false })).toEqual([]);
	});

	it('offers the window and a create entry for the agent in view', () => {
		expect(build().map((c) => c.id)).toEqual(['promptLinks', 'createPromptLink']);
	});

	it('offers only the window when no agent is in view', () => {
		expect(build({ activeAgent: undefined }).map((c) => c.id)).toEqual(['promptLinks']);
	});

	it('opens the window on the agent, carrying a non-blank draft as the prompt', () => {
		const openPromptLinks = vi.fn();
		const setQuickActionOpen = vi.fn();
		const [, create] = build({ openPromptLinks, setQuickActionOpen, activeDraft: 'Ship it' });
		create.action();
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
		expect(openPromptLinks).toHaveBeenCalledWith({ agentId: 'agent-1', prompt: 'Ship it' });

		openPromptLinks.mockClear();
		const [, blank] = build({ openPromptLinks, activeDraft: '   ' });
		blank.action();
		expect(openPromptLinks).toHaveBeenCalledWith({ agentId: 'agent-1' });
	});

	it('opens the window with no prefill from the plain entry', () => {
		const openPromptLinks = vi.fn();
		const [open] = build({ openPromptLinks });
		open.action();
		expect(openPromptLinks).toHaveBeenCalledWith();
	});
});
