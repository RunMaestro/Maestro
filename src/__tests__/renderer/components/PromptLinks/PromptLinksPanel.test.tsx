/**
 * Prompt Links panel (the Prompt Links window and the Prompt Links tile).
 *
 * What these defend:
 * - the create form sends exactly what the user chose: agent, prompt, use
 *   budget, expiry, open mode,
 * - a bad input is refused CLIENT-side, so the store is never asked,
 * - the new URL is shown once with a copy button, because only its hash is kept,
 * - the list shows active links by default and revoke is two-step,
 * - with the flag OFF the tile says so instead of offering links that cannot run.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

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

	it('offers only AI agents, alphabetically, starting on the prefilled one', async () => {
		render(<PromptLinksPanel theme={theme} initialAgentId="agent-b" initialPrompt="Draft" />);
		const select = screen.getByTestId('prompt-link-agent') as HTMLSelectElement;
		expect([...select.options].map((o) => o.textContent)).toEqual(['Alpha', 'Beta']);
		expect(select.value).toBe('agent-b');
		expect((screen.getByTestId('prompt-link-prompt') as HTMLTextAreaElement).value).toBe('Draft');
		await waitFor(() => expect(promptLinks.list).toHaveBeenCalled());
	});

	it('creates a one-shot background link by default and shows its URL once', async () => {
		render(<PromptLinksPanel theme={theme} initialAgentId="agent-a" />);
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
	});

	it('sends the chosen uses, expiry, label, and open mode', async () => {
		render(<PromptLinksPanel theme={theme} initialAgentId="agent-a" />);
		type('prompt-link-prompt', 'p');
		type('prompt-link-label', 'Standup');
		fireEvent.click(screen.getByTestId('prompt-link-uses-unlimited'));
		type('prompt-link-expiry', '7d');
		fireEvent.click(screen.getByTestId('prompt-link-open-foreground'));
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
		render(<PromptLinksPanel theme={theme} initialAgentId="agent-a" />);
		type('prompt-link-prompt', 'p');
		fireEvent.click(screen.getByTestId('prompt-link-uses-count'));
		type('prompt-link-uses-count-input', '3');
		fireEvent.click(screen.getByTestId('prompt-link-create'));
		await waitFor(() => expect(promptLinks.create).toHaveBeenCalled());
		expect(promptLinks.create.mock.calls[0][0]).toMatchObject({ maxUses: 3 });
	});

	it('refuses a blank prompt without calling the store', async () => {
		render(<PromptLinksPanel theme={theme} initialAgentId="agent-a" />);
		fireEvent.click(screen.getByTestId('prompt-link-create'));
		expect(await screen.findByTestId('prompt-link-create-error')).toHaveTextContent(/prompt/i);
		expect(promptLinks.create).not.toHaveBeenCalled();
	});

	it("shows the store's refusal in its own words", async () => {
		promptLinks.create.mockRejectedValueOnce(new Error('Prompt Links is turned off.'));
		render(<PromptLinksPanel theme={theme} initialAgentId="agent-a" />);
		type('prompt-link-prompt', 'p');
		fireEvent.click(screen.getByTestId('prompt-link-create'));
		expect(await screen.findByTestId('prompt-link-create-error')).toHaveTextContent('turned off');
	});

	it('lists active links by default and reveals the rest on request', async () => {
		render(<PromptLinksPanel theme={theme} />);
		await waitFor(() => expect(screen.getAllByTestId('prompt-link-row')).toHaveLength(1));
		expect(screen.getByText('Morning PRs')).toBeInTheDocument();

		fireEvent.click(screen.getByTestId('prompt-links-toggle-inactive'));
		expect(screen.getAllByTestId('prompt-link-row')).toHaveLength(2);
	});

	it('revokes in two steps', async () => {
		render(<PromptLinksPanel theme={theme} />);
		await waitFor(() => expect(screen.getAllByTestId('prompt-link-row')).toHaveLength(1));

		fireEvent.click(screen.getByTestId('prompt-link-revoke'));
		expect(promptLinks.revoke).not.toHaveBeenCalled();
		fireEvent.click(screen.getByTestId('prompt-link-revoke-confirm'));

		await waitFor(() => expect(promptLinks.revoke).toHaveBeenCalledWith('l-active'));
		expect(notifyToast).toHaveBeenCalledWith(expect.objectContaining({ color: 'green' }));
	});

	it('says when there are no links yet', async () => {
		promptLinks.list.mockResolvedValue([]);
		render(<PromptLinksPanel theme={theme} />);
		expect(await screen.findByTestId('prompt-links-empty')).toHaveTextContent(
			'No prompt links yet.'
		);
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
