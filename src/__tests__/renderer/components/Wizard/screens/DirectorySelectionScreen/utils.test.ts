import { describe, expect, it, vi, beforeEach } from 'vitest';
import { checkForExistingAutoRunDocs } from '../../../../../../renderer/components/Wizard/screens/DirectorySelectionScreen/utils/existingDocs';
import { getWizardSshRemoteId } from '../../../../../../renderer/components/Wizard/screens/DirectorySelectionScreen/utils/sshRemote';
import { getWizardYoloFlag } from '../../../../../../renderer/components/Wizard/screens/DirectorySelectionScreen/utils/yoloFlag';
import type { AgentConfig } from '../../../../../../renderer/types';

const sentryMocks = vi.hoisted(() => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

vi.mock('../../../../../../renderer/utils/sentry', () => sentryMocks);

describe('DirectorySelectionScreen utils', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('derives SSH remote ID only when remote config is enabled', () => {
		expect(getWizardSshRemoteId(undefined)).toBeUndefined();
		expect(getWizardSshRemoteId({ enabled: false, remoteId: 'remote-1' })).toBeUndefined();
		expect(getWizardSshRemoteId({ enabled: true, remoteId: null })).toBeUndefined();
		expect(getWizardSshRemoteId({ enabled: true, remoteId: 'remote-1' })).toBe('remote-1');
	});

	it('extracts YOLO flag from dedicated args before base args', () => {
		const agent = {
			id: 'codex',
			name: 'Codex',
			command: 'codex',
			binaryName: 'codex',
			args: ['--yes'],
			yoloModeArgs: ['run', '--dangerously-bypass-approvals'],
		} as AgentConfig;

		expect(getWizardYoloFlag(agent)).toBe('codex run --dangerously-bypass-approvals');
	});

	it('falls back to supported base args for YOLO display', () => {
		const agent = {
			id: 'claude-code',
			name: 'Claude Code',
			command: 'claude',
			args: ['--dangerously-skip-permissions'],
		} as AgentConfig;

		expect(getWizardYoloFlag(agent)).toBe('claude --dangerously-skip-permissions');
		expect(getWizardYoloFlag({ ...agent, args: [] })).toBeNull();
		expect(getWizardYoloFlag(null)).toBeNull();
	});

	it('checks existing Auto Run docs and swallows recoverable read failures', async () => {
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: true,
			files: ['a.md', 'b.md'],
		});

		await expect(checkForExistingAutoRunDocs('/project', 'remote-1')).resolves.toEqual({
			exists: true,
			count: 2,
		});
		expect(window.maestro.autorun.listDocs).toHaveBeenCalledWith(
			'/project/.maestro/playbooks',
			'remote-1'
		);

		vi.mocked(window.maestro.autorun.listDocs).mockRejectedValueOnce(new Error('missing'));
		await expect(checkForExistingAutoRunDocs('/project')).resolves.toEqual({
			exists: false,
			count: 0,
		});
	});

	it('reports and rethrows unexpected Auto Run docs lookup failures', async () => {
		const error = new Error('network timeout');
		vi.mocked(window.maestro.autorun.listDocs).mockRejectedValueOnce(error);

		await expect(checkForExistingAutoRunDocs('/project')).rejects.toThrow('network timeout');

		expect(sentryMocks.captureException).toHaveBeenCalledWith(
			error,
			expect.objectContaining({
				extra: expect.objectContaining({
					context: 'checkForExistingAutoRunDocs',
					dirPath: '/project',
				}),
			})
		);
	});
});
