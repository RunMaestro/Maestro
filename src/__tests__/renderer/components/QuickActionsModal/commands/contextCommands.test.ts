import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 9: the hosted-runtime flag defaults to false, so the OFF path is what most of this file runs.
const hosted = vi.hoisted(() => ({
	isLibraryRuntimeHosting: vi.fn(() => false),
	setAiTabStarred: vi.fn(
		async () => ({ ok: true, value: undefined }) as { ok: boolean; value?: undefined }
	),
}));
vi.mock('../../../../../renderer/services/libraryRuntime', () => ({
	isLibraryRuntimeHosting: hosted.isLibraryRuntimeHosting,
}));
vi.mock('../../../../../renderer/services/agentOps', () => ({
	setAiTabStarred: hosted.setAiTabStarred,
}));

import { buildActiveTabContextCommands } from '../../../../../renderer/components/QuickActionsModal/commands/contextCommands';
import { onStarredSessionsChanged } from '../../../../../renderer/utils/starredSessions';
import type { Session } from '../../../../../renderer/types';
import { createMockSession } from '../../../../helpers/mockSession';
import { createMockAITab } from '../../../../helpers/mockTab';

describe('the Star Session palette command', () => {
	const setSessions = vi.fn();
	const close = vi.fn();

	const build = (starred: boolean) => {
		const tab = createMockAITab({ id: 'tab-1', starred, agentSessionId: 'provider-1' });
		const session = createMockSession({ id: 's1', aiTabs: [tab], activeTabId: 'tab-1' });
		const commands = buildActiveTabContextCommands({
			activeSession: session,
			activeSessionId: 's1',
			activeTabType: 'ai',
			ghCliAvailable: false,
			setSessions,
			setQuickActionOpen: close,
			safeClipboardWrite: async () => true,
			flashCopiedToClipboard: vi.fn(),
			onCopyTabContext: vi.fn(),
			onExportTabHtml: vi.fn(),
			onPublishTabGist: vi.fn(),
		});
		return { session, command: commands.find((command) => command.id === 'toggleStarTab')! };
	};

	beforeEach(() => {
		setSessions.mockClear();
		close.mockClear();
		hosted.isLibraryRuntimeHosting.mockReturnValue(false);
		hosted.setAiTabStarred.mockClear();
		hosted.setAiTabStarred.mockResolvedValue({ ok: true, value: undefined });
	});
	afterEach(() => {
		hosted.isLibraryRuntimeHosting.mockReturnValue(false);
	});

	it('labels the command for the direction it will go', () => {
		expect(build(false).command.label).toBe('Star Session');
		expect(build(true).command.label).toBe('Unstar Session');
	});

	it('flips the star in the store and closes the palette, with no runtime command when the setting is off', () => {
		const { session, command } = build(false);
		command.action();
		const update = setSessions.mock.calls[0][0] as (prev: Session[]) => Session[];
		expect(update([session])[0].aiTabs[0].starred).toBe(true);
		expect(close).toHaveBeenCalledWith(false);
		expect(hosted.setAiTabStarred).not.toHaveBeenCalled();
	});

	describe('when the library runtime is hosted', () => {
		beforeEach(() => hosted.isLibraryRuntimeHosting.mockReturnValue(true));

		it('also sends the star as a command', () => {
			const { session, command } = build(false);
			command.action();
			const update = setSessions.mock.calls[0][0] as (prev: Session[]) => Session[];
			expect(update([session])[0].aiTabs[0].starred).toBe(true);
			expect(hosted.setAiTabStarred).toHaveBeenCalledWith('s1', 'tab-1', true);
			expect(close).toHaveBeenCalledWith(false);
		});

		it('sends an unstar the same way', () => {
			build(true).command.action();
			expect(hosted.setAiTabStarred).toHaveBeenCalledWith('s1', 'tab-1', false);
		});

		it('tells the starred-sessions cache once the runtime has answered, and not when it refused', async () => {
			const changed = vi.fn();
			const stop = onStarredSessionsChanged(changed);
			build(false).command.action();
			await Promise.resolve();
			await Promise.resolve();
			expect(changed).toHaveBeenCalledTimes(1);

			hosted.setAiTabStarred.mockResolvedValue({ ok: false });
			build(false).command.action();
			await Promise.resolve();
			await Promise.resolve();
			expect(changed).toHaveBeenCalledTimes(1);
			stop();
		});
	});
});
