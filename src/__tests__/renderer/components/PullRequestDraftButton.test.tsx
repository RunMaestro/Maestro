/**
 * Tests for PullRequestDraftButton ("Draft with local model").
 *
 * What it draws is decided by the Git drafts task's readiness, resolved in the
 * main process: nothing while the task is off (the default), a disabled button
 * with the reason while its source cannot run, and a working button otherwise.
 * A press fills the form through `onDraft` and does nothing else.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { PullRequestDraftButton } from '../../../renderer/components/PullRequestDraftButton';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { QWEN3_1_7B_ID } from '../../../shared/local-models/model-catalog';
import type { LocalModelTaskReadiness } from '../../../shared/local-models/task-readiness';
import type { PullRequestDraftResult } from '../../../shared/gitDrafts';
import { mockTheme } from '../../helpers/mockTheme';

const CWD = '/test/worktree';

const taskReadiness = vi.fn();
const draftPullRequest = vi.fn();

const LOCAL = { type: 'local', modelId: QWEN3_1_7B_ID } as const;
const ENDPOINT = { type: 'endpoint', endpointId: 'ep-1', model: 'qwen3:latest' } as const;

function verdict(patch: Partial<LocalModelTaskReadiness>): LocalModelTaskReadiness {
	return {
		taskId: 'git-drafts',
		label: 'Git drafts',
		needs: 'text-gen',
		assignment: LOCAL,
		state: 'ready',
		detail: 'Runs Qwen3 1.7B Instruct (Q4_K_M) on this machine.',
		...patch,
	};
}

const DRAFT: PullRequestDraftResult = {
	success: true,
	title: 'Add retry with backoff',
	body: 'Retries failed requests.\n\n- Add backoff',
	baseBranch: 'main',
	commitCount: 2,
	truncated: false,
	producedBy: 'Qwen3 1.7B Instruct (Q4_K_M)',
};

function renderButton(
	overrides: Partial<React.ComponentProps<typeof PullRequestDraftButton>> = {}
) {
	const props = {
		theme: mockTheme,
		cwd: CWD,
		baseBranch: 'main',
		onDraft: vi.fn(),
		...overrides,
	};
	return { ...render(<PullRequestDraftButton {...props} />), props };
}

/** A promise the test settles by hand, to hold a draft in flight. */
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe('PullRequestDraftButton', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useSettingsStore.setState({
			localModelAssignments: { 'git-drafts': LOCAL },
			localModelEndpoints: [],
		});
		taskReadiness.mockResolvedValue([verdict({})]);
		draftPullRequest.mockResolvedValue(DRAFT);
		(globalThis as unknown as { window: { maestro: unknown } }).window.maestro = {
			localModels: { taskReadiness, draftPullRequest },
		};
	});

	it('asks for the readiness of the one task it offers', async () => {
		renderButton();
		await screen.findByTestId('pr-draft-button');
		expect(taskReadiness).toHaveBeenCalledWith('git-drafts');
	});

	it('draws nothing while the task is off', async () => {
		taskReadiness.mockResolvedValue([
			verdict({ assignment: { type: 'off' }, state: 'off', detail: 'Git drafts is off.' }),
		]);
		const { container } = renderButton();

		await waitFor(() => expect(taskReadiness).toHaveBeenCalled());
		await act(async () => {});
		expect(container).toBeEmptyDOMElement();
	});

	it('draws nothing until readiness has answered, or when it cannot be read', async () => {
		taskReadiness.mockRejectedValue(new Error('bridge down'));
		const { container } = renderButton();

		await waitFor(() => expect(taskReadiness).toHaveBeenCalled());
		await act(async () => {});
		expect(container).toBeEmptyDOMElement();
	});

	it('shows the button with the model it will run on when ready', async () => {
		renderButton();

		const button = await screen.findByTestId('pr-draft-button');
		expect(button).toBeEnabled();
		expect(button).toHaveTextContent('Draft with local model');
		expect(screen.getByTestId('pr-draft-source')).toHaveTextContent('Qwen3 1.7B Instruct (Q4_K_M)');
		expect(screen.queryByTestId('pr-draft-unavailable')).not.toBeInTheDocument();
	});

	it('names an endpoint source as model on endpoint', async () => {
		useSettingsStore.setState({
			localModelAssignments: { 'git-drafts': ENDPOINT },
			localModelEndpoints: [
				{
					id: 'ep-1',
					name: 'Ollama',
					kind: 'ollama',
					baseUrl: 'http://127.0.0.1:11434',
					enabled: true,
				},
			],
		});
		taskReadiness.mockResolvedValue([verdict({ assignment: ENDPOINT })]);
		renderButton();

		expect(await screen.findByTestId('pr-draft-source')).toHaveTextContent(
			'qwen3:latest on Ollama'
		);
	});

	it('is disabled with the readiness reason when the source cannot run', async () => {
		taskReadiness.mockResolvedValue([
			verdict({
				state: 'unavailable',
				reason: 'model-not-installed',
				detail: 'Qwen3 1.7B Instruct (Q4_K_M) is not downloaded.',
				suggestedAction: 'Download it in Settings -> Local Models.',
			}),
		]);
		renderButton();

		const button = await screen.findByTestId('pr-draft-button');
		expect(button).toBeDisabled();
		expect(screen.getByTestId('pr-draft-unavailable')).toHaveTextContent(
			'Qwen3 1.7B Instruct (Q4_K_M) is not downloaded. Download it in Settings -> Local Models.'
		);

		fireEvent.click(button);
		expect(draftPullRequest).not.toHaveBeenCalled();
	});

	it('is disabled while the form is locked', async () => {
		renderButton({ disabled: true });
		expect(await screen.findByTestId('pr-draft-button')).toBeDisabled();
	});

	it('fills the form with the draft and says who wrote it', async () => {
		const { props } = renderButton({ baseBranch: 'develop' });

		fireEvent.click(await screen.findByTestId('pr-draft-button'));

		await waitFor(() =>
			expect(props.onDraft).toHaveBeenCalledWith({
				title: 'Add retry with backoff',
				body: 'Retries failed requests.\n\n- Add backoff',
			})
		);
		expect(draftPullRequest).toHaveBeenCalledWith({ cwd: CWD, baseBranch: 'develop' });
		expect(screen.getByTestId('pr-draft-note')).toHaveTextContent(
			'Drafted by Qwen3 1.7B Instruct (Q4_K_M) from 2 commits. Review it before creating.'
		);
	});

	it('says when the summary was shortened to fit the model', async () => {
		draftPullRequest.mockResolvedValue({ ...DRAFT, commitCount: 1, truncated: true });
		renderButton();

		fireEvent.click(await screen.findByTestId('pr-draft-button'));

		expect(await screen.findByTestId('pr-draft-note')).toHaveTextContent(
			'from 1 commit (summary shortened to fit the model)'
		);
	});

	it('shows a spinner label and blocks a second press while drafting', async () => {
		const pending = deferred<PullRequestDraftResult>();
		draftPullRequest.mockReturnValue(pending.promise);
		renderButton();

		const button = await screen.findByTestId('pr-draft-button');
		fireEvent.click(button);

		await waitFor(() => expect(button).toHaveTextContent('Drafting...'));
		expect(button).toBeDisabled();
		fireEvent.click(button);
		expect(draftPullRequest).toHaveBeenCalledTimes(1);

		await act(async () => pending.resolve(DRAFT));
		expect(button).toHaveTextContent('Draft with local model');
		expect(button).toBeEnabled();
	});

	it('shows the reason and fills nothing when the draft fails', async () => {
		draftPullRequest.mockResolvedValue({
			success: false,
			status: 'no-changes',
			error: 'feat has no commits that main does not have, so there is nothing to draft from.',
		});
		const { props } = renderButton();

		fireEvent.click(await screen.findByTestId('pr-draft-button'));

		expect(await screen.findByTestId('pr-draft-error')).toHaveTextContent(
			'feat has no commits that main does not have'
		);
		expect(props.onDraft).not.toHaveBeenCalled();
		expect(screen.queryByTestId('pr-draft-note')).not.toBeInTheDocument();
	});

	it('re-reads readiness when the source turned out to be unavailable', async () => {
		draftPullRequest.mockResolvedValue({
			success: false,
			status: 'unavailable',
			error: 'Ollama is not reachable.',
		});
		renderButton();

		fireEvent.click(await screen.findByTestId('pr-draft-button'));

		expect(await screen.findByTestId('pr-draft-error')).toHaveTextContent(
			'Ollama is not reachable.'
		);
		await waitFor(() => expect(taskReadiness).toHaveBeenCalledTimes(2));
	});

	it('shows a rejected call as an error', async () => {
		draftPullRequest.mockRejectedValue(new Error('engine exploded'));
		renderButton();

		fireEvent.click(await screen.findByTestId('pr-draft-button'));

		expect(await screen.findByTestId('pr-draft-error')).toHaveTextContent('engine exploded');
	});

	it('drops a draft written against a target branch that is no longer picked', async () => {
		const pending = deferred<PullRequestDraftResult>();
		draftPullRequest.mockReturnValue(pending.promise);
		const { props, rerender } = renderButton();

		fireEvent.click(await screen.findByTestId('pr-draft-button'));
		await waitFor(() => expect(draftPullRequest).toHaveBeenCalledTimes(1));

		rerender(<PullRequestDraftButton {...props} baseBranch="develop" />);
		await act(async () => pending.resolve(DRAFT));

		expect(props.onDraft).not.toHaveBeenCalled();
		expect(screen.getByTestId('pr-draft-button')).toHaveTextContent('Draft with local model');
	});

	it('fills nothing after the form closed mid-draft', async () => {
		const pending = deferred<PullRequestDraftResult>();
		draftPullRequest.mockReturnValue(pending.promise);
		const { props, unmount } = renderButton();

		fireEvent.click(await screen.findByTestId('pr-draft-button'));
		await waitFor(() => expect(draftPullRequest).toHaveBeenCalledTimes(1));

		unmount();
		await act(async () => pending.resolve(DRAFT));

		expect(props.onDraft).not.toHaveBeenCalled();
	});
});
