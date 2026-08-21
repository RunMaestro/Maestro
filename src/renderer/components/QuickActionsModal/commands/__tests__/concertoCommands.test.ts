import { describe, expect, it, vi } from 'vitest';
import { buildConcertoCommands } from '../concertoCommands';

function build(overrides: Partial<Parameters<typeof buildConcertoCommands>[0]> = {}) {
	return buildConcertoCommands({
		concertoEnabled: true,
		stageOpen: false,
		cadenzasHidden: false,
		toggleConcertoStage: vi.fn(),
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

	it('offers both toggles even with an empty stage, since that is when they are needed', () => {
		expect(build().map((command) => command.id)).toEqual(['concerto-stage', 'concerto-cadenzas']);
	});

	it('names what the entry will actually do', () => {
		expect(build({ stageOpen: false })[0].label).toBe('Show Concerto Stage');
		expect(build({ stageOpen: true })[0].label).toBe('Hide Concerto Stage');
		expect(build({ cadenzasHidden: false })[1].label).toBe('Hide All Cadenzas');
		expect(build({ cadenzasHidden: true })[1].label).toBe('Show All Cadenzas');
	});

	it('runs the toggle and dismisses the palette', () => {
		const toggleConcertoStage = vi.fn();
		const toggleCadenzas = vi.fn();
		const setQuickActionOpen = vi.fn();
		const commands = build({ toggleConcertoStage, toggleCadenzas, setQuickActionOpen });

		commands[0].action();
		commands[1].action();

		expect(toggleConcertoStage).toHaveBeenCalledTimes(1);
		expect(toggleCadenzas).toHaveBeenCalledTimes(1);
		expect(setQuickActionOpen).toHaveBeenCalledTimes(2);
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});
});
