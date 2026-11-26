/**
 * WorktreeConfigModal: mode parity (docs/parity/agent-ux-parity.md).
 *
 * A local, an SSH, and a hosted agent get the same modal: the same Browse (enabled, same title),
 * the same placeholder and help text, no "remote" notice, and the same "not found" error. Only the
 * transport differs: the directory is browsed and checked where the agent's files live.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorktreeConfigModal } from '../../../renderer/components/WorktreeConfigModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { AGENT_MODES, createModeSession, type AgentMode } from '../../helpers';
import { browseAndPick, MODE_REMOTE_ID, resetPathPicker } from '../../helpers/pathPicker';
import { mockTheme } from '../../helpers/mockTheme';
import type { Session } from '../../../renderer/types';

afterEach(() => {
	resetPathPicker();
	vi.mocked(window.maestro.fs.readDir).mockReset();
});

function renderMode(mode: AgentMode, onSaveConfig = vi.fn(), overrides: Partial<Session> = {}) {
	const session = createModeSession(mode, {
		cwd: '/work/repo',
		projectRoot: '/work/repo',
		...overrides,
	});
	const view = render(
		<LayerStackProvider>
			<WorktreeConfigModal
				isOpen={true}
				onClose={vi.fn()}
				theme={mockTheme}
				session={session}
				onSaveConfig={onSaveConfig}
				onCreateWorktree={vi.fn()}
				onDisableConfig={vi.fn()}
			/>
		</LayerStackProvider>
	);
	return { view, onSaveConfig };
}

const drawn = () => {
	const browse = screen.getByTitle('Browse for directory') as HTMLButtonElement;
	const input = screen.getByPlaceholderText('/path/to/worktrees') as HTMLInputElement;
	return {
		browseDisabled: browse.disabled,
		value: input.value,
		text: document.body.textContent,
	};
};

describe('WorktreeConfigModal: mode parity (local, SSH, hosted)', () => {
	it('draws the same modal in every mode', async () => {
		const results: Record<string, ReturnType<typeof drawn>> = {};
		for (const mode of AGENT_MODES) {
			const { view } = renderMode(mode);
			await waitFor(() => expect(window.maestro.git.checkGhCli).toHaveBeenCalled());
			results[mode] = drawn();
			view.unmount();
		}
		expect(results.ssh).toEqual(results.local);
		expect(results.hosted).toEqual(results.local);
		expect(results.local.browseDisabled).toBe(false);
		expect(results.local.value).toBe('/work');
		expect(results.local.text).toContain('Base directory where worktrees will be created');
		expect(results.local.text).not.toMatch(/remote|server/i);
	});

	it.each(AGENT_MODES)('%s: Browse picks the directory where the agent runs', async (mode) => {
		renderMode(mode);
		await browseAndPick(
			mode,
			() => fireEvent.click(screen.getByTitle('Browse for directory')),
			'/picked/worktrees'
		);
		expect(screen.getByPlaceholderText('/path/to/worktrees')).toHaveValue('/picked/worktrees');
	});

	// SSH switched off keeps the remote id it had. That agent is local, so Browse is the native
	// dialog, never the remote picker on the stale id.
	it('a remote id left on an agent with SSH off does not route Browse to that remote', async () => {
		renderMode('local', vi.fn(), {
			sessionSshRemoteConfig: { enabled: false, remoteId: MODE_REMOTE_ID },
		});
		await browseAndPick(
			'local',
			() => fireEvent.click(screen.getByTitle('Browse for directory')),
			'/picked/worktrees'
		);
		expect(screen.getByPlaceholderText('/path/to/worktrees')).toHaveValue('/picked/worktrees');
	});

	it.each(AGENT_MODES)(
		'%s: a missing directory shows the same error, checked where it lives',
		async (mode) => {
			vi.mocked(window.maestro.fs.readDir).mockRejectedValue(new Error('not found'));
			const { onSaveConfig } = renderMode(mode);
			fireEvent.click(screen.getByText('Save Configuration'));
			expect(
				await screen.findByText('Directory not found. Please select a valid directory.')
			).toBeInTheDocument();
			expect(window.maestro.fs.readDir).toHaveBeenCalledWith(
				'/work',
				mode === 'local' ? undefined : MODE_REMOTE_ID
			);
			expect(onSaveConfig).not.toHaveBeenCalled();
		}
	);
});
