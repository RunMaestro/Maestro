/**
 * Prompt Links panel (the Prompt Links window and the Prompt Links tile).
 *
 * What these defend:
 * - the window opens on the newest active link, or on the form when asked to
 *   compose (or when there is nothing to show),
 * - the create form sends exactly what the user chose: agent, prompt, use
 *   budget, expiry, open mode,
 * - a bad input is refused CLIENT-side, so the store is never asked,
 * - the new URL is shown once on its own screen, because only its hash is kept,
 * - inactive links are collapsed, revoke is two-step, Duplicate prefills the form,
 * - with the flag OFF the tile says so instead of offering links that cannot run.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { notifyToast, clipboardWrite } = vi.hoisted(() => ({
	notifyToast: vi.fn(),
	clipboardWrite: vi.fn(async (_text: string) => true),
}));
vi.mock('../../../../renderer/stores/notificationStore', () => ({
	notifyToast: (...args: unknown[]) => notifyToast(...args),
}));
vi.mock('../../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: (text: string) => clipboardWrite(text),
}));

import { PromptLinksPanel } from '../../../../renderer/components/PromptLinks/PromptLinksPanel';
import { ExtensionDetails } from '../../../../renderer/components/Settings/Extensions/ExtensionDetails';
import {
	BUILTIN_FEATURES,
	builtinExtension,
} from '../../../../renderer/components/Settings/Extensions/extensionModel';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { EncoreFeatureFlags, Session, Theme } from '../../../../renderer/types';

const theme = {
	colors: {
		textMain: '#eee',
		textDim: '#999',
		bgMain: '#111',
		bgActivity: '#222',
		accent: '#4af',
		border: '#333',
		warning: '#fa0',
		error: '#f44',
		success: '#4f4',
	},
} as unknown as Theme;

const ACTIVE = {
	id: 'l-active',
	agentId: 'agent-b',
	prompt: 'Summarize overnight PRs',
	label: 'Morning PRs',
	createdAt: Date.now() - 60_000,
	maxUses: 1,
	useCount: 0,
	open: 'background',
};
const SPENT = { ...ACTIVE, id: 'l-spent', label: 'Old one', useCount: 1 };

const promptLinks = {
	list: vi.fn(),
	create: vi.fn(),
	revoke: vi.fn(),
	rendererReady: vi.fn(),
};

function setAgents() {
	useSessionStore.setState({
		sessions: [
			{ id: 'agent-b', name: 'Beta', toolType: 'claude-code' },
			{ id: 'agent-a', name: 'Alpha', toolType: 'codex' },
			{ id: 'term', name: 'Shell', toolType: 'terminal' },
		] as unknown as Session[],
	});
}

function type(testId: string, value: string): void {
	fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

/** Pick an option in a ThemedSelect by its trigger's aria-label. */
function choose(label: string, option: string): void {
	fireEvent.click(screen.getByLabelText(label));
	fireEvent.click(screen.getByRole('option', { name: option }));
}

describe('PromptLinksPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		promptLinks.list.mockResolvedValue([ACTIVE, SPENT]);
		promptLinks.create.mockResolvedValue({
			link: { ...ACTIVE, id: 'l-new' },
			url: 'maestro://run/NEWTOKEN',
		});
		promptLinks.revoke.mockResolvedValue({ ...ACTIVE, revokedAt: Date.now() });
		(window as unknown as { maestro: unknown }).maestro = { promptLinks };
		setAgents();
	});

	afterEach(() => cleanup());

	it('opens on the newest active link, with inactive ones collapsed', async () => {
		render(<PromptLinksPanel theme={theme} />);
		expect(await screen.findByTestId('prompt-link-detail')).toHaveTextContent('Morning PRs');
		expect(screen.getByTestId('prompt-link-detail')).toHaveTextContent('Summarize overnight PRs');
		expect(screen.getAllByTestId('prompt-link-row')).toHaveLength(1);

		fireEvent.click(screen.getByTestId('prompt-links-toggle-inactive'));
		expect(screen.getAllByTestId('prompt-link-row')).toHaveLength(2);
	});

	it('opens on the form when composing, starting on the prefilled agent and prompt', async () => {
		render(
			<PromptLinksPanel theme={theme} initialAgentId="agent-b" initialPrompt="Draft" compose />
		);
		expect(screen.getByTestId('prompt-link-form')).toBeInTheDocument();
		expect(screen.getByLabelText('Agent')).toHaveTextContent('Beta');
		expect((screen.getByTestId('prompt-link-prompt') as HTMLTextAreaElement).value).toBe('Draft');
		await waitFor(() => expect(promptLinks.list).toHaveBeenCalled());
		// A load that finds links must not pull the user off the form.
		expect(screen.getByTestId('prompt-link-form')).toBeInTheDocument();
	});

	it('opens on the form when there are no links yet', async () => {
		promptLinks.list.mockResolvedValue([]);
		render(<PromptLinksPanel theme={theme} />);
		expect(await screen.findByTestId('prompt-link-form')).toBeInTheDocument();
		expect(screen.getByTestId('prompt-links-empty')).toHaveTextContent('No prompt links yet.');
	});

	it('offers only AI agents, alphabetically', async () => {
		render(<PromptLinksPanel theme={theme} compose />);
		fireEvent.click(screen.getByLabelText('Agent'));
		expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Alpha', 'Beta']);
		await waitFor(() => expect(promptLinks.list).toHaveBeenCalled());
	});

	it('creates a one-shot background link by default and shows its URL once', async () => {
		render(<PromptLinksPanel theme={theme} initialAgentId="agent-a" compose />);
		type('prompt-link-prompt', 'Prep me for standup');
		fireEvent.click(screen.getByTestId('prompt-link-create'));

		await waitFor(() => expect(screen.getByTestId('prompt-link-created')).toBeInTheDocument());
		expect(promptLinks.create).toHaveBeenCalledWith({
			agentId: 'agent-a',
			prompt: 'Prep me for standup',
			maxUses: 1,
			open: 'background',
		});
		expect((screen.getByTestId('prompt-link-created-url') as HTMLInputElement).value).toBe(
			'maestro://run/NEWTOKEN'
		);
		expect(screen.getByTestId('prompt-link-created')).toHaveTextContent('cannot be shown again');

		fireEvent.click(screen.getByTestId('prompt-link-copy'));
		await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith('maestro://run/NEWTOKEN'));
		expect(await screen.findByText('Copied')).toBeInTheDocument();
	});

	it('sends the chosen uses, expiry, label, and open mode', async () => {
		render(<PromptLinksPanel theme={theme} initialAgentId="agent-a" compose />);
		type('prompt-link-prompt', 'p');
		type('prompt-link-label', 'Standup');
		choose('Uses', 'Runs every time');
		choose('Expires', 'Expires in 7 days');
		choose('Opens in', 'Opens in the foreground');
		const before = Date.now();
		fireEvent.click(screen.getByTestId('prompt-link-create'));

		await waitFor(() => expect(promptLinks.create).toHaveBeenCalled());
		const input = promptLinks.create.mock.calls[0][0];
		expect(input).toMatchObject({
			agentId: 'agent-a',
			maxUses: null,
			open: 'foreground',
			label: 'Standup',
		});
		expect(input.expiresAt).toBeGreaterThanOrEqual(before + 7 * 86_400_000);
	});

	it('sends a limited use count', async () => {
		render(<PromptLinksPanel theme={theme} initialAgentId="agent-a" compose />);
		type('prompt-link-prompt', 'p');
		choose('Uses', 'Runs a set number of times');
		type('prompt-link-uses-count-input', '3');
		fireEvent.click(screen.getByTestId('prompt-link-create'));
		await waitFor(() => expect(promptLinks.create).toHaveBeenCalled());
		expect(promptLinks.create.mock.calls[0][0]).toMatchObject({ maxUses: 3 });
	});

	it('refuses a blank prompt without calling the store', async () => {
		render(<PromptLinksPanel theme={theme} initialAgentId="agent-a" compose />);
		fireEvent.click(screen.getByTestId('prompt-link-create'));
		expect(await screen.findByTestId('prompt-link-create-error')).toHaveTextContent(/prompt/i);
		expect(promptLinks.create).not.toHaveBeenCalled();
	});

	it("shows the store's refusal in its own words", async () => {
		promptLinks.create.mockRejectedValueOnce(new Error('Prompt Links is turned off.'));
		render(<PromptLinksPanel theme={theme} initialAgentId="agent-a" compose />);
		type('prompt-link-prompt', 'p');
		fireEvent.click(screen.getByTestId('prompt-link-create'));
		expect(await screen.findByTestId('prompt-link-create-error')).toHaveTextContent('turned off');
	});

	it('switches between links and the form from the list', async () => {
		render(<PromptLinksPanel theme={theme} />);
		await screen.findByTestId('prompt-link-detail');
		fireEvent.click(screen.getByTestId('prompt-links-new'));
		expect(screen.getByTestId('prompt-link-form')).toBeInTheDocument();
		fireEvent.click(screen.getByTestId('prompt-link-row'));
		expect(screen.getByTestId('prompt-link-detail')).toBeInTheDocument();
	});

	it('duplicates a link into the form with its prompt and settings', async () => {
		promptLinks.list.mockResolvedValue([
			{ ...ACTIVE, maxUses: null, open: 'foreground', label: 'Weekly' },
		]);
		render(<PromptLinksPanel theme={theme} />);
		await screen.findByTestId('prompt-link-detail');
		fireEvent.click(screen.getByTestId('prompt-link-duplicate'));

		expect((screen.getByTestId('prompt-link-prompt') as HTMLTextAreaElement).value).toBe(
			'Summarize overnight PRs'
		);
		expect((screen.getByTestId('prompt-link-label') as HTMLInputElement).value).toBe('Weekly');
		expect(screen.getByLabelText('Uses')).toHaveTextContent('Runs every time');
		expect(screen.getByLabelText('Opens in')).toHaveTextContent('foreground');
		expect(screen.getByLabelText('Agent')).toHaveTextContent('Beta');
	});

	it('revokes in two steps', async () => {
		render(<PromptLinksPanel theme={theme} />);
		await screen.findByTestId('prompt-link-detail');

		fireEvent.click(screen.getByTestId('prompt-link-revoke'));
		expect(promptLinks.revoke).not.toHaveBeenCalled();
		fireEvent.click(screen.getByTestId('prompt-link-revoke-confirm'));

		await waitFor(() => expect(promptLinks.revoke).toHaveBeenCalledWith('l-active'));
		expect(notifyToast).toHaveBeenCalledWith(expect.objectContaining({ color: 'green' }));
	});

	it('keeps a link that went inactive visible while it is selected', async () => {
		render(<PromptLinksPanel theme={theme} />);
		await screen.findByTestId('prompt-link-detail');
		promptLinks.list.mockResolvedValue([{ ...ACTIVE, revokedAt: Date.now() }, SPENT]);
		fireEvent.click(screen.getByTestId('prompt-link-revoke'));
		fireEvent.click(screen.getByTestId('prompt-link-revoke-confirm'));

		await waitFor(() =>
			expect(screen.getByTestId('prompt-link-status')).toHaveTextContent(/revoked/i)
		);
		expect(screen.getAllByTestId('prompt-link-row')).toHaveLength(2);
		expect(screen.queryByTestId('prompt-link-revoke')).not.toBeInTheDocument();
	});

	it('keeps the security note in view', async () => {
		render(<PromptLinksPanel theme={theme} />);
		expect(screen.getByTestId('prompt-links-warning')).toHaveTextContent('A link is a key');
		await waitFor(() => expect(promptLinks.list).toHaveBeenCalled());
	});
});

describe('Prompt Links tile body', () => {
	const flags = (enabled: boolean) => ({ promptLinks: enabled }) as unknown as EncoreFeatureFlags;

	function renderTile(enabled: boolean): void {
		const def = BUILTIN_FEATURES.find((f) => f.flag === 'promptLinks');
		if (!def) throw new Error('no builtin feature for flag promptLinks');
		render(
			<ExtensionDetails
				theme={theme}
				ext={builtinExtension(def, flags(enabled))}
				contributions={null}
				busy={false}
				onTogglePlugin={vi.fn()}
				onToggleBuiltin={vi.fn()}
				onUninstall={vi.fn()}
				onRevoke={vi.fn()}
				getGrants={vi.fn(async () => ({ requested: [], granted: [] }))}
			/>
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		promptLinks.list.mockResolvedValue([]);
		(window as unknown as { maestro: unknown }).maestro = { promptLinks };
		setAgents();
	});

	afterEach(() => cleanup());

	it('manages links when the feature is enabled', async () => {
		renderTile(true);
		await waitFor(() => expect(screen.getByTestId('prompt-links-panel')).toBeInTheDocument());
	});

	it('says to enable the feature first when it is off', () => {
		renderTile(false);
		expect(screen.getByTestId('extension-settings-disabled-hint')).toHaveTextContent(
			'Enable Prompt Links to create and manage links.'
		);
		expect(screen.queryByTestId('prompt-links-panel')).not.toBeInTheDocument();
	});
});
