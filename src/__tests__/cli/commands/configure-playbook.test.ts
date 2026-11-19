/**
 * @file configure-playbook.test.ts
 * @description `maestro-cli playbook configure`: the read form, saving answers
 * through the desktop's `update_playbook` message, refusing undeclared or
 * invalid answers with exit 2, and removing Maestro's missing-parameters halt
 * marker only once nothing required is missing.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Playbook, SessionInfo } from '../../../shared/types';

vi.mock('../../../cli/services/playbooks', () => ({
	findPlaybookById: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	getSessionById: vi.fn(),
}));

vi.mock('../../../cli/services/session-command', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/session-command')>()),
	sendSimpleCommand: vi.fn(),
}));

import { configurePlaybook } from '../../../cli/commands/configure-playbook';
import { findPlaybookById } from '../../../cli/services/playbooks';
import { getSessionById } from '../../../cli/services/storage';
import { sendSimpleCommand } from '../../../cli/services/session-command';
import { buildMissingParamsHaltMarker } from '../../../shared/autorunMarkers';

const PROMPT = [
	'<!-- CONFIGURE: The pull request to review -->',
	'**PR_URL:** `https://github.com/OWNER/REPO/pull/XXX`',
	'',
	'<!-- CONFIGURE: How many items to process -->',
	'**MAX_ITEMS:** `25`',
].join('\n');

describe('playbook configure', () => {
	let tmp: string;
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;
	let playbook: Playbook;

	const lastJson = () => JSON.parse(String(logSpy.mock.calls[logSpy.mock.calls.length - 1][0]));

	beforeEach(() => {
		vi.clearAllMocks();
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-configure-playbook-'));
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`process.exit(${code})`);
		});
		playbook = {
			id: 'pb-1',
			name: 'Review',
			createdAt: 0,
			updatedAt: 0,
			documents: [{ filename: 'first', resetOnCompletion: false }],
			loopEnabled: false,
			prompt: PROMPT,
			parameterValues: { MAX_ITEMS: '3' },
		};
		vi.mocked(findPlaybookById).mockReturnValue({ playbook, agentId: 'agent-1' });
		vi.mocked(getSessionById).mockReturnValue({
			id: 'agent-1',
			name: 'Agent',
			toolType: 'claude-code',
			cwd: tmp,
			autoRunFolderPath: tmp,
		} as SessionInfo);
		vi.mocked(sendSimpleCommand).mockResolvedValue({ success: true });
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		exitSpy.mockRestore();
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('without --set, reads the form and the missing required names', async () => {
		await configurePlaybook('pb-1', { json: true });

		expect(sendSimpleCommand).not.toHaveBeenCalled();
		expect(lastJson()).toMatchObject({
			success: true,
			playbookId: 'pb-1',
			missing: ['PR_URL'],
			parameters: [
				{ name: 'PR_URL', required: true },
				{ name: 'MAX_ITEMS', required: false, default: '25', value: '3' },
			],
		});
	});

	it('saves the merged answers through update_playbook and clears the halt marker', async () => {
		const doc = path.join(tmp, 'first.md');
		fs.writeFileSync(doc, `${buildMissingParamsHaltMarker(['PR_URL'])}\n# First\n- [ ] task\n`);

		await configurePlaybook('pb-1', {
			json: true,
			set: ['PR_URL=https://github.com/acme/app/pull/7'],
		});

		expect(sendSimpleCommand).toHaveBeenCalledWith(
			{
				type: 'update_playbook',
				sessionId: 'agent-1',
				playbookId: 'pb-1',
				updates: {
					parameterValues: { MAX_ITEMS: '3', PR_URL: 'https://github.com/acme/app/pull/7' },
				},
			},
			'update_playbook_result'
		);
		expect(lastJson()).toMatchObject({ success: true, missing: [], clearedHaltMarkers: ['first'] });
		expect(fs.readFileSync(doc, 'utf-8')).toBe('# First\n- [ ] task\n');
	});

	it('keeps the halt marker while a required parameter is still missing', async () => {
		const doc = path.join(tmp, 'first.md');
		const content = `${buildMissingParamsHaltMarker(['PR_URL'])}\n# First\n`;
		fs.writeFileSync(doc, content);

		// NAME= clears a saved answer; PR_URL stays unanswered.
		await configurePlaybook('pb-1', { json: true, set: ['MAX_ITEMS='] });

		const [message] = vi.mocked(sendSimpleCommand).mock.calls[0];
		expect(message.updates).toEqual({ parameterValues: {} });
		expect(lastJson()).toMatchObject({ missing: ['PR_URL'], clearedHaltMarkers: [] });
		expect(fs.readFileSync(doc, 'utf-8')).toBe(content);
	});

	it('refuses an undeclared name with exit 2 and saves nothing', async () => {
		await expect(configurePlaybook('pb-1', { set: ['PR_LINK=https://x.test'] })).rejects.toThrow(
			'process.exit(2)'
		);
		expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('PR_LINK is not a parameter'));
		expect(sendSimpleCommand).not.toHaveBeenCalled();
	});

	it('refuses a malformed --set with exit 2', async () => {
		await expect(configurePlaybook('pb-1', { json: true, set: ['PR_URL'] })).rejects.toThrow(
			'process.exit(2)'
		);
		expect(lastJson()).toMatchObject({ success: false, code: 'INVALID_PARAMETERS' });
	});

	it('fails when the desktop does not save the playbook', async () => {
		vi.mocked(sendSimpleCommand).mockResolvedValue({ success: false });
		await expect(
			configurePlaybook('pb-1', { json: true, set: ['PR_URL=https://x.test/1'] })
		).rejects.toThrow('process.exit(1)');
		expect(lastJson()).toMatchObject({ success: false });
	});
});
