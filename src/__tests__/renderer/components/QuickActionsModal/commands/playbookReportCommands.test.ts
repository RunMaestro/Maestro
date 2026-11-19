import { describe, expect, it, vi } from 'vitest';
import { buildPlaybookReportCommands } from '../../../../../renderer/components/QuickActionsModal/commands/playbookReportCommands';

function build(overrides: Partial<Parameters<typeof buildPlaybookReportCommands>[0]> = {}) {
	return buildPlaybookReportCommands({
		activeAgentId: 'agent-1',
		waitingCount: 0,
		openPlaybookReport: vi.fn(),
		setQuickActionOpen: vi.fn(),
		...overrides,
	});
}

describe('buildPlaybookReportCommands', () => {
	it('offers nothing with no agent and no waiting report', () => {
		expect(build({ activeAgentId: undefined })).toEqual([]);
	});

	it('offers the entry for the active agent', () => {
		const [command] = build();
		expect(command.label).toBe('Open Last Playbook Report');
		expect(command.subtext).toMatch(/last playbook run/);
	});

	it('says how many reports are waiting, even with no agent in view', () => {
		const [command] = build({ activeAgentId: undefined, waitingCount: 2 });
		expect(command.subtext).toBe('2 finished runs waiting to be read');
	});

	it('closes the palette and opens the report', () => {
		const openPlaybookReport = vi.fn();
		const setQuickActionOpen = vi.fn();
		const [command] = build({ openPlaybookReport, setQuickActionOpen });
		command.action();
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
		expect(openPlaybookReport).toHaveBeenCalledTimes(1);
	});
});
