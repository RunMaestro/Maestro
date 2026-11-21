import { describe as __maestroMicrobenchDescribe } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { buildConcertoCommands } from '../concertoCommands';
import { buildPromptLinksCommands } from '../promptLinksCommands';
__maestroMicrobenchDescribe('concertoCommands', () => {
	function build(overrides: Partial<Parameters<typeof buildConcertoCommands>[0]> = {}) {
		return buildConcertoCommands({
			concertoEnabled: true,
			stageOpen: false,
			cadenzasHidden: false,
			stageFloating: false,
			toggleConcertoStage: vi.fn(),
			toggleStageFloating: vi.fn(),
			toggleCadenzas: vi.fn(),
			setQuickActionOpen: vi.fn(),
			shortcuts: {},
			...overrides,
		});
	}

	describe('buildConcertoCommands', () => {
		it('offers nothing while the Concerto Encore Feature is off', () => {
			expect(build({ concertoEnabled: false })).toEqual([]);
		});

		it('offers every toggle even with an empty stage, since that is when they are needed', () => {
			expect(build().map((command) => command.id)).toEqual([
				'concerto-stage',
				'concerto-stage-float',
				'concerto-cadenzas',
			]);
		});

		it('names what the entry will actually do', () => {
			expect(build({ stageOpen: false })[0].label).toBe('Show Concerto Stage');
			expect(build({ stageOpen: true })[0].label).toBe('Hide Concerto Stage');
			expect(build({ stageFloating: false })[1].label).toBe('Pop Concerto Stage Out');
			expect(build({ stageFloating: true })[1].label).toBe('Dock Concerto Stage');
			expect(build({ cadenzasHidden: false })[2].label).toBe('Hide All Cadenzas');
			expect(build({ cadenzasHidden: true })[2].label).toBe('Show All Cadenzas');
		});

		it('runs the toggle and dismisses the palette', () => {
			const toggleConcertoStage = vi.fn();
			const toggleStageFloating = vi.fn();
			const toggleCadenzas = vi.fn();
			const setQuickActionOpen = vi.fn();
			const commands = build({
				toggleConcertoStage,
				toggleStageFloating,
				toggleCadenzas,
				setQuickActionOpen,
			});

			commands[0].action();
			commands[1].action();
			commands[2].action();

			expect(toggleConcertoStage).toHaveBeenCalledTimes(1);
			expect(toggleStageFloating).toHaveBeenCalledTimes(1);
			expect(toggleCadenzas).toHaveBeenCalledTimes(1);
			expect(setQuickActionOpen).toHaveBeenCalledTimes(3);
			expect(setQuickActionOpen).toHaveBeenCalledWith(false);
		});
	});
});
__maestroMicrobenchDescribe('promptLinksCommands', () => {
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
			expect(openPromptLinks).toHaveBeenCalledWith({
				agentId: 'agent-1',
				compose: true,
				prompt: 'Ship it',
			});

			openPromptLinks.mockClear();
			const [, blank] = build({ openPromptLinks, activeDraft: '   ' });
			blank.action();
			expect(openPromptLinks).toHaveBeenCalledWith({ agentId: 'agent-1', compose: true });
		});

		it('opens the window with no prefill from the plain entry', () => {
			const openPromptLinks = vi.fn();
			const [open] = build({ openPromptLinks });
			open.action();
			expect(openPromptLinks).toHaveBeenCalledWith();
		});
	});
});
