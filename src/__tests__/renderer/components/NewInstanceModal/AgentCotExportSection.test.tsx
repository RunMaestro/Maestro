/**
 * @fileoverview Tests for AgentCotExportSection, the one control of chain of
 * thought export.
 *
 * The section talks to `window.maestro.cotExport` and to nothing else, so every
 * test hands it a fake of that API and reads what the fake was asked.
 */

import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentCotExportSection } from '../../../../renderer/components/NewInstanceModal/AgentCotExportSection';
import type {
	CotAgentStatus,
	CotChainVerifyResult,
	CotFolderValidation,
	CotSetResult,
} from '../../../../shared/cotExport/types';
import { mockTheme } from '../../../helpers/mockTheme';

// lucide-react icons are mocked globally in src/__tests__/setup.ts using a Proxy

const mocks = vi.hoisted(() => ({ webDesktop: false }));

vi.mock('../../../../renderer/utils/runtimeContext', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/utils/runtimeContext')>()),
	isWebDesktop: () => mocks.webDesktop,
}));

const AGENT = 'agent-1';
const FOLDER = path.join(path.sep, 'audit', 'backend');
const TOGGLE_LABEL = 'Keep an audit log for this agent';

const statusOf = (overrides: Partial<CotAgentStatus> = {}): CotAgentStatus => ({
	enabled: false,
	folder: null,
	turnsToday: 0,
	unencrypted: false,
	...overrides,
});

const verdictOf = (overrides: Partial<CotChainVerifyResult> = {}): CotChainVerifyResult => ({
	folder: FOLDER,
	ok: true,
	filesChecked: 3,
	recordsChecked: 12,
	headMatches: true,
	...overrides,
});

function createApi(initial: CotAgentStatus = statusOf()) {
	return {
		get: vi.fn(),
		set: vi.fn<(agentId: string, choice: unknown) => Promise<CotSetResult>>(),
		status: vi.fn<(agentId: string) => Promise<CotAgentStatus>>().mockResolvedValue(initial),
		validateFolder: vi.fn<(agentId: string, folder: string) => Promise<CotFolderValidation>>(),
		verify: vi.fn<(agentId: string) => Promise<CotChainVerifyResult[]>>(),
	};
}

type FakeApi = ReturnType<typeof createApi>;

function renderSection(
	props: Partial<React.ComponentProps<typeof AgentCotExportSection>> = {}
): ReturnType<typeof render> {
	return render(
		<AgentCotExportSection
			theme={mockTheme}
			agentId={AGENT}
			agentName="Backend"
			supportsReasoning
			usesInteractiveTokenSource={false}
			{...props}
		/>
	);
}

/** The section with `api` installed, once its first status has arrived. */
async function renderLoaded(
	api: FakeApi,
	props: Partial<React.ComponentProps<typeof AgentCotExportSection>> = {}
): Promise<void> {
	(window.maestro as any).cotExport = api;
	renderSection(props);
	await waitFor(() => expect(screen.getByText('Choose Folder')).not.toBeDisabled());
}

const toggle = (): HTMLElement => screen.getByRole('switch', { name: TOGGLE_LABEL });
const isOn = (): boolean => toggle().getAttribute('aria-checked') === 'true';

describe('AgentCotExportSection', () => {
	let selectFolder: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		mocks.webDesktop = false;
		selectFolder = vi.fn().mockResolvedValue(null);
		(window.maestro as any).dialog = { ...(window.maestro as any).dialog, selectFolder };
	});

	afterEach(() => {
		delete (window.maestro as any).cotExport;
	});

	describe('where it shows', () => {
		it('renders nothing without the API', () => {
			const { container } = renderSection();

			expect(container.innerHTML).toBe('');
		});

		it('renders nothing in the browser build, where the preload still exposes the API', () => {
			const api = createApi();
			(window.maestro as any).cotExport = api;
			mocks.webDesktop = true;

			const { container } = renderSection();

			expect(container.innerHTML).toBe('');
			expect(api.status).not.toHaveBeenCalled();
		});

		it('renders the heading and loads the status of its agent', async () => {
			const api = createApi();
			await renderLoaded(api);

			expect(screen.getByText('Audit Log')).toBeInTheDocument();
			expect(api.status).toHaveBeenCalledWith(AGENT);
		});

		it('says so, and holds every control, when the status cannot be read', async () => {
			const api = createApi();
			api.status.mockRejectedValue(
				new Error("Error invoking remote method 'cotExport:status': Error: store is locked")
			);
			(window.maestro as any).cotExport = api;
			renderSection();

			expect(await screen.findByText(/could not read the audit log settings/i)).toHaveTextContent(
				'store is locked'
			);
			expect(screen.getByRole('alert')).not.toHaveTextContent('cotExport:status');
			expect(screen.getByText('Choose Folder')).toBeDisabled();
			expect(toggle()).toBeDisabled();
			expect(screen.getByText('Verify Log')).toBeDisabled();
		});
	});

	describe('the folder', () => {
		it('shows that no folder is chosen and keeps the toggle disabled', async () => {
			await renderLoaded(createApi());

			expect(screen.getByTestId('cot-export-folder')).toHaveTextContent('No folder chosen');
			expect(toggle()).toBeDisabled();
			expect(isOn()).toBe(false);
		});

		it('shows the stored folder as text that can be selected', async () => {
			await renderLoaded(createApi(statusOf({ folder: FOLDER })));

			const shown = screen.getByTestId('cot-export-folder');
			expect(shown).toHaveTextContent(FOLDER);
			expect(shown.className).toContain('select-text');
			expect(toggle()).not.toBeDisabled();
		});

		it('shows the reason of a rejected folder and never saves it', async () => {
			const api = createApi();
			selectFolder.mockResolvedValue(FOLDER);
			api.validateFolder.mockResolvedValue({
				ok: false,
				reason: 'The folder is inside the working directory of an agent.',
			});
			await renderLoaded(api);

			fireEvent.click(screen.getByText('Choose Folder'));

			const reason = await screen.findByText(
				'The folder is inside the working directory of an agent.'
			);
			expect(reason).toHaveStyle({ color: mockTheme.colors.error });
			expect(api.validateFolder).toHaveBeenCalledWith(AGENT, FOLDER);
			expect(api.set).not.toHaveBeenCalled();
			expect(screen.getByTestId('cot-export-folder')).toHaveTextContent('No folder chosen');
			expect(toggle()).toBeDisabled();
		});

		it('saves an accepted folder at once, under its real path, with the switch as it was', async () => {
			const api = createApi();
			const resolved = path.join(path.sep, 'private', 'audit', 'backend');
			selectFolder.mockResolvedValue(FOLDER);
			api.validateFolder.mockResolvedValue({ ok: true, resolved });
			api.set.mockResolvedValue({ ok: true, status: statusOf({ folder: resolved }) });
			await renderLoaded(api);

			fireEvent.click(screen.getByText('Choose Folder'));

			await waitFor(() =>
				expect(screen.getByTestId('cot-export-folder')).toHaveTextContent(resolved)
			);
			expect(api.set).toHaveBeenCalledWith(AGENT, { enabled: false, folder: resolved });
			expect(toggle()).not.toBeDisabled();
		});

		it('changes nothing when the folder picker is cancelled', async () => {
			const api = createApi();
			await renderLoaded(api);

			fireEvent.click(screen.getByText('Choose Folder'));

			await waitFor(() => expect(selectFolder).toHaveBeenCalled());
			await waitFor(() => expect(screen.getByText('Choose Folder')).not.toBeDisabled());
			expect(api.validateFolder).not.toHaveBeenCalled();
			expect(api.set).not.toHaveBeenCalled();
		});

		it('shows the reason when the save of a folder is refused', async () => {
			const api = createApi();
			selectFolder.mockResolvedValue(FOLDER);
			api.validateFolder.mockResolvedValue({ ok: true, resolved: FOLDER });
			api.set.mockResolvedValue({ ok: false, reason: 'Maestro could not save the change.' });
			await renderLoaded(api);

			fireEvent.click(screen.getByText('Choose Folder'));

			expect(await screen.findByText('Maestro could not save the change.')).toBeInTheDocument();
			expect(screen.getByTestId('cot-export-folder')).toHaveTextContent('No folder chosen');
		});
	});

	describe('the toggle', () => {
		it('saves at once through set, with the folder left as it is', async () => {
			const api = createApi(statusOf({ folder: FOLDER }));
			api.set.mockResolvedValue({
				ok: true,
				status: statusOf({ enabled: true, folder: FOLDER }),
			});
			await renderLoaded(api);

			fireEvent.click(toggle());

			await waitFor(() => expect(isOn()).toBe(true));
			expect(api.set).toHaveBeenCalledWith(AGENT, { enabled: true, folder: FOLDER });
		});

		it('turns export off with the stored folder', async () => {
			const api = createApi(statusOf({ enabled: true, folder: FOLDER }));
			api.set.mockResolvedValue({ ok: true, status: statusOf({ folder: FOLDER }) });
			await renderLoaded(api);

			fireEvent.click(toggle());

			await waitFor(() => expect(isOn()).toBe(false));
			expect(api.set).toHaveBeenCalledWith(AGENT, { enabled: false, folder: FOLDER });
		});

		it('stays off and shows the reason when turning on is refused', async () => {
			const api = createApi(statusOf({ folder: FOLDER }));
			api.set.mockResolvedValue({ ok: false, reason: 'Maestro cannot write to the folder.' });
			await renderLoaded(api);

			fireEvent.click(toggle());

			expect(await screen.findByText('Maestro cannot write to the folder.')).toBeInTheDocument();
			expect(isOn()).toBe(false);
		});

		it('keeps a rejected call inside the section', async () => {
			const api = createApi(statusOf({ folder: FOLDER }));
			api.set.mockRejectedValue(
				new Error("Error invoking remote method 'cotExport:set': Error: Not available")
			);
			await renderLoaded(api);

			fireEvent.click(toggle());

			expect(await screen.findByTestId('cot-export-change-error')).toHaveTextContent(
				'Not available'
			);
			expect(isOn()).toBe(false);
			expect(toggle()).not.toBeDisabled();
		});

		it('states what a change does under the toggle', async () => {
			await renderLoaded(createApi());

			expect(
				screen.getByText(
					/Applies from this agent's next message\. Maestro never deletes these files\. The folder must be outside every agent's working directory\./
				)
			).toBeInTheDocument();
		});
	});

	describe('the notes', () => {
		it('says which turns are recorded and which are not', async () => {
			await renderLoaded(createApi());

			const scope = screen.getByTestId('cot-export-scope');
			expect(scope).toHaveTextContent(
				"Recorded: messages sent in this app, Auto Run tasks, Group Chat replies, Cue runs, and answers to another agent's question."
			);
			expect(scope).toHaveTextContent(
				'A turn started from the command line is recorded with its prompt and how it ended, without its output.'
			);
			expect(scope).toHaveTextContent(
				'Not recorded: anything a program the agent starts does on its own.'
			);
		});

		it('says that reasoning a provider returns encrypted is recorded as proof, not as text', async () => {
			await renderLoaded(createApi());

			expect(screen.getByTestId('cot-export-reasoning')).toHaveTextContent(
				'Reasoning is recorded as far as the provider shows it. When a provider returns it encrypted, the log holds proof that a reasoning block existed (its size and hash), not its text.'
			);
		});

		const UNSUPPORTED = /This provider does not expose its reasoning\./;
		const INTERACTIVE = /Reasoning may be missing while this agent runs through the interactive/;

		it('says that the provider does not expose its reasoning', async () => {
			await renderLoaded(createApi(), { supportsReasoning: false });

			expect(screen.getByText(UNSUPPORTED)).toHaveTextContent(
				'Prompts are still recorded, and so are tool calls, results, replies, and usage when the provider reports them.'
			);
		});

		it('says that reasoning may be missing on the interactive token source', async () => {
			await renderLoaded(createApi(), { usesInteractiveTokenSource: true });

			expect(screen.getByText(INTERACTIVE)).toBeInTheDocument();
		});

		it('shows neither note for a provider that exposes reasoning over the API', async () => {
			await renderLoaded(createApi());

			expect(screen.queryByText(UNSUPPORTED)).not.toBeInTheDocument();
			expect(screen.queryByText(INTERACTIVE)).not.toBeInTheDocument();
		});
	});

	describe('the status line', () => {
		it('shows the last write as relative time and the turns recorded today', async () => {
			await renderLoaded(
				createApi(
					statusOf({
						enabled: true,
						folder: FOLDER,
						lastWriteAt: Date.now() - 5 * 60_000,
						turnsToday: 3,
					})
				)
			);

			expect(screen.getByTestId('cot-export-status')).toHaveTextContent(
				'Last write 5m ago. 3 turns recorded today.'
			);
		});

		it('says that nothing is written yet, and counts one turn as one', async () => {
			await renderLoaded(createApi(statusOf({ folder: FOLDER, turnsToday: 1 })));

			expect(screen.getByTestId('cot-export-status')).toHaveTextContent(
				'No record written yet. 1 turn recorded today.'
			);
		});

		it('shows no write line before a folder is chosen', async () => {
			await renderLoaded(createApi());

			expect(screen.queryByTestId('cot-export-status')).not.toBeInTheDocument();
		});

		it('warns when the settings are only obscured, on a system with no key store', async () => {
			await renderLoaded(createApi(statusOf({ unencrypted: true })));

			const warning = screen.getByTestId('cot-export-unencrypted');
			expect(warning).toHaveTextContent(
				'This system has no key store, so the settings for this feature are obscured, not encrypted.'
			);
			expect(warning).toHaveStyle({ color: mockTheme.colors.warning });
		});

		it('shows no warning when the settings are sealed', async () => {
			await renderLoaded(createApi());

			expect(screen.queryByTestId('cot-export-unencrypted')).not.toBeInTheDocument();
		});

		it('shows the last failure in the error color, even with export off and no folder', async () => {
			await renderLoaded(
				createApi(
					statusOf({
						lastError: { message: 'Maestro could not read the saved settings.', at: Date.now() },
					})
				)
			);

			const failure = screen.getByTestId('cot-export-last-error');
			expect(failure).toHaveTextContent('Maestro could not read the saved settings.');
			expect(failure).toHaveStyle({ color: mockTheme.colors.error });
		});

		it('shows the status that a change returned', async () => {
			const api = createApi(statusOf({ folder: FOLDER }));
			api.set.mockResolvedValue({
				ok: true,
				status: statusOf({ enabled: true, folder: FOLDER, turnsToday: 7 }),
			});
			await renderLoaded(api);

			fireEvent.click(toggle());

			await waitFor(() =>
				expect(screen.getByTestId('cot-export-status')).toHaveTextContent('7 turns recorded today.')
			);
		});
	});

	describe('Verify Log', () => {
		it('is held until a folder is chosen', async () => {
			await renderLoaded(createApi());

			expect(screen.getByText('Verify Log')).toBeDisabled();
		});

		it('renders the intact line of a chain that verifies', async () => {
			const api = createApi(statusOf({ enabled: true, folder: FOLDER }));
			api.verify.mockResolvedValue([verdictOf()]);
			await renderLoaded(api);

			fireEvent.click(screen.getByText('Verify Log'));

			const output = await screen.findByTestId('cot-export-verification');
			expect(output).toHaveTextContent('Intact: 12 records in 3 files');
			expect(output).toHaveTextContent(FOLDER);
			expect(output.className).toContain('select-text');
			expect(api.verify).toHaveBeenCalledWith(AGENT);
		});

		it('counts one record in one file as one', async () => {
			const api = createApi(statusOf({ folder: FOLDER }));
			api.verify.mockResolvedValue([verdictOf({ recordsChecked: 1, filesChecked: 1 })]);
			await renderLoaded(api);

			fireEvent.click(screen.getByText('Verify Log'));

			expect(await screen.findByTestId('cot-export-verification')).toHaveTextContent(
				'Intact: 1 record in 1 file'
			);
		});

		it('renders the file, the position, and the reason of a broken chain', async () => {
			const api = createApi(statusOf({ enabled: true, folder: FOLDER }));
			const file = path.join(FOLDER, '2026', '10', '10', '14', 'turn-a.jsonl');
			api.verify.mockResolvedValue([
				verdictOf({
					ok: false,
					firstBreak: {
						file,
						chainSeq: 7,
						reason:
							'Record 7 was changed after it was written: its contents no longer match its hash.',
					},
				}),
			]);
			await renderLoaded(api);

			fireEvent.click(screen.getByText('Verify Log'));

			const output = await screen.findByTestId('cot-export-verification');
			expect(output).toHaveTextContent(file);
			expect(output).toHaveTextContent('Broken at position 7');
			expect(output).toHaveTextContent(
				'Record 7 was changed after it was written: its contents no longer match its hash.'
			);
			expect(output).not.toHaveTextContent('Intact');
			// The link itself held up to the head, so the end of the log is not called into question.
			expect(output).not.toHaveTextContent('is not the last one Maestro wrote');
		});

		it('says that the end of the log was changed when the head does not match', async () => {
			const api = createApi(statusOf({ enabled: true, folder: FOLDER }));
			api.verify.mockResolvedValue([verdictOf({ ok: false, headMatches: false })]);
			await renderLoaded(api);

			fireEvent.click(screen.getByText('Verify Log'));

			const output = await screen.findByTestId('cot-export-verification');
			expect(output).toHaveTextContent(
				'The newest record in this folder is not the last one Maestro wrote: records were removed from the end of the log, or added to it.'
			);
			expect(output).toHaveTextContent('Checked 12 records in 3 files.');
			expect(output).not.toHaveTextContent('Intact');
		});

		it('says that a folder could not be checked, and gives no verdict on it', async () => {
			const api = createApi(statusOf({ enabled: true, folder: FOLDER }));
			api.verify.mockResolvedValue([
				verdictOf({
					ok: false,
					headMatches: false,
					filesChecked: 0,
					recordsChecked: 0,
					error: 'The folder could not be read (EACCES).',
				}),
			]);
			await renderLoaded(api);

			fireEvent.click(screen.getByText('Verify Log'));

			const output = await screen.findByTestId('cot-export-verification');
			expect(output).toHaveTextContent(
				'Maestro could not check this folder: The folder could not be read (EACCES).'
			);
			// Nothing was read, so nothing is said about the log itself.
			expect(output).not.toHaveTextContent('Intact');
			expect(output).not.toHaveTextContent('is not the last one Maestro wrote');
			expect(output).not.toHaveTextContent('Checked');
		});

		it('renders one verdict per chain, the current folder first', async () => {
			const api = createApi(statusOf({ enabled: true, folder: FOLDER }));
			const past = path.join(path.sep, 'audit', 'old');
			api.verify.mockResolvedValue([
				verdictOf(),
				verdictOf({ folder: past, recordsChecked: 40, filesChecked: 9 }),
			]);
			await renderLoaded(api);

			fireEvent.click(screen.getByText('Verify Log'));

			const output = await screen.findByTestId('cot-export-verification');
			const verdicts = Array.from(output.querySelectorAll('li')).map((item) => item.textContent);
			expect(verdicts).toHaveLength(2);
			expect(verdicts[0]).toContain(FOLDER);
			expect(verdicts[0]).toContain('Intact: 12 records in 3 files');
			expect(verdicts[1]).toContain(past);
			expect(verdicts[1]).toContain('Intact: 40 records in 9 files');
		});

		it('says so when there is no log to verify', async () => {
			const api = createApi(statusOf({ folder: FOLDER }));
			api.verify.mockResolvedValue([]);
			await renderLoaded(api);

			fireEvent.click(screen.getByText('Verify Log'));

			expect(await screen.findByText('There is no log to verify yet.')).toBeInTheDocument();
		});

		it('shows why a verify could not run, without the name of the channel', async () => {
			const api = createApi(statusOf({ enabled: true, folder: FOLDER }));
			api.verify.mockRejectedValue(
				new Error(
					"Error invoking remote method 'cotExport:verify': Error: EACCES: permission denied, scandir '/audit/backend'"
				)
			);
			await renderLoaded(api);

			fireEvent.click(screen.getByText('Verify Log'));

			const failure = await screen.findByText(/Maestro could not verify the log/);
			expect(failure).toHaveTextContent("EACCES: permission denied, scandir '/audit/backend'");
			expect(failure).not.toHaveTextContent('cotExport:verify');
			expect(failure).toHaveStyle({ color: mockTheme.colors.error });
			await waitFor(() => expect(screen.getByText('Verify Log')).not.toBeDisabled());
		});

		it('reads the status again after a verify, which can leave a failure behind', async () => {
			const api = createApi(statusOf({ enabled: true, folder: FOLDER }));
			api.verify.mockResolvedValue([verdictOf({ ok: false, headMatches: false })]);
			await renderLoaded(api);
			api.status.mockResolvedValue(
				statusOf({
					enabled: true,
					folder: FOLDER,
					lastError: { message: 'The head could not be checked.', at: Date.now() },
				})
			);

			fireEvent.click(screen.getByText('Verify Log'));

			expect(await screen.findByTestId('cot-export-last-error')).toHaveTextContent(
				'The head could not be checked.'
			);
			expect(api.status).toHaveBeenCalledTimes(2);
		});
	});

	describe('an agent switch', () => {
		it('loads the other agent and drops what the first one showed', async () => {
			const api = createApi(statusOf({ enabled: true, folder: FOLDER }));
			api.verify.mockResolvedValue([verdictOf()]);
			(window.maestro as any).cotExport = api;
			const view = renderSection();
			await waitFor(() => expect(isOn()).toBe(true));
			fireEvent.click(screen.getByText('Verify Log'));
			await screen.findByTestId('cot-export-verification');

			api.status.mockResolvedValue(statusOf());
			view.rerender(
				<AgentCotExportSection
					theme={mockTheme}
					agentId="agent-2"
					agentName="Frontend"
					supportsReasoning
					usesInteractiveTokenSource={false}
				/>
			);

			await waitFor(() =>
				expect(screen.getByTestId('cot-export-folder')).toHaveTextContent('No folder chosen')
			);
			expect(api.status).toHaveBeenLastCalledWith('agent-2');
			expect(isOn()).toBe(false);
			expect(screen.queryByTestId('cot-export-verification')).not.toBeInTheDocument();
		});
	});

	describe('what the file may not do', () => {
		const source = fs.readFileSync(
			path.join(
				__dirname,
				'..',
				'..',
				'..',
				'..',
				'renderer',
				'components',
				'NewInstanceModal',
				'AgentCotExportSection.tsx'
			),
			'utf8'
		);
		const imports = source
			.split('\n')
			.filter((line) => /^\s*(import\b|\}\s*from\b)/.test(line) || /\bfrom '/.test(line));

		it('imports no logger and no error reporter', () => {
			// A log line lands in a file agents can read, and a report carries the
			// channel's name off the machine.
			expect(imports.join('\n')).not.toMatch(/logger|sentry/i);
			expect(source).not.toMatch(/\bconsole\.|captureException|captureMessage/);
		});

		it('reads and writes no store of the app', () => {
			// Nothing of this feature may sit where the dialog's Save, the CLI, or
			// a web client can pick it up.
			expect(imports.join('\n')).not.toMatch(/stores\/|settings/i);
			expect(source).not.toMatch(/onSave|useSessionStore|useSettingsStore/);
		});
	});
});
