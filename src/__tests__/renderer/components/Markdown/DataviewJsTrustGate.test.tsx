/**
 * The DataviewJS trust gate (D3, DV-12): `useDataviewJsRunPolicy()` decides from the settings, the browser
 * build, and the vault root main names; `DataviewJsTrustGate` mounts the guest in a trusted vault, and in
 * any other shows the source, says the script would read the vault, and offers "Run once" (a main-side
 * grant, then this block only) and "Always trust this vault" (main's trust service).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { DataviewJsTrustGate } from '../../../../renderer/components/Markdown/components/DataviewJsTrustGate';
import type { DataviewDocumentScope } from '../../../../renderer/components/Markdown/components/DataviewDocumentContext';
import {
	useDataviewJsRunPolicy,
	type DataviewJsRunState,
} from '../../../../renderer/hooks/file/useDataviewJsRunPolicy';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { clearCachedResources } from '../../../../renderer/hooks/utils/useCachedResource';
import { isWebDesktop } from '../../../../renderer/utils/runtimeContext';
import { mockTheme } from '../../../helpers/mockTheme';

vi.mock('../../../../renderer/components/Markdown/components/DataviewJsFrame', () => ({
	DataviewJsFrame: ({ code }: { code: string }) => <div data-testid="guest-frame">{code}</div>,
}));
vi.mock('../../../../renderer/utils/runtimeContext', () => ({ isWebDesktop: vi.fn(() => false) }));

const ROOT = '/vault';
const NOTE = '/vault/Notes/Note.md';
const SCRIPT = 'dv.paragraph(dv.current().file.name)';

function scope(overrides: Partial<DataviewDocumentScope> = {}): DataviewDocumentScope {
	return { filePath: NOTE, agentId: 'agent-1', openLink: vi.fn(), ...overrides };
}

function state(overrides: Partial<DataviewJsRunState> = {}): DataviewJsRunState {
	return { policy: 'ask', root: ROOT, resolving: false, error: null, ...overrides };
}

const dataview = () => vi.mocked(window.maestro.dataview);

beforeEach(() => {
	vi.clearAllMocks();
	clearCachedResources();
	vi.mocked(isWebDesktop).mockReturnValue(false);
	useSettingsStore.setState({
		encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, dataview: true },
		dataviewJsEnabled: true,
		dataviewJsTrustedRoots: [],
	});
	dataview().jsRoot.mockResolvedValue({ root: ROOT, sshRemoteId: null });
	dataview().jsRunOnce.mockResolvedValue({ root: ROOT, sshRemoteId: null });
});

describe('useDataviewJsRunPolicy', () => {
	const note = { agentId: 'agent-1', filePath: NOTE };

	it('asks in an untrusted vault once main names the root', async () => {
		const { result } = renderHook(() => useDataviewJsRunPolicy(note));
		expect(result.current).toMatchObject({ policy: 'ask', root: null, resolving: true });
		await waitFor(() => expect(result.current.root).toBe(ROOT));
		expect(result.current).toMatchObject({ policy: 'ask', resolving: false, error: null });
		expect(dataview().jsRoot).toHaveBeenCalledWith(note);
	});

	it('runs in a trusted vault, and follows the trust list as it changes', async () => {
		useSettingsStore.setState({ dataviewJsTrustedRoots: ['/vault/'] });
		const { result } = renderHook(() => useDataviewJsRunPolicy(note));
		await waitFor(() => expect(result.current.policy).toBe('run'));

		act(() => useSettingsStore.setState({ dataviewJsTrustedRoots: [] }));
		expect(result.current.policy).toBe('ask');
	});

	it('is disabled, and never asks main, while the feature or the setting is off', () => {
		useSettingsStore.setState({ dataviewJsEnabled: false });
		const { result, rerender } = renderHook(() => useDataviewJsRunPolicy(note));
		expect(result.current).toEqual({
			policy: 'disabled',
			root: null,
			resolving: false,
			error: null,
		});

		act(() =>
			useSettingsStore.setState({
				dataviewJsEnabled: true,
				encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, dataview: false },
			})
		);
		rerender();
		expect(result.current.policy).toBe('disabled');
		expect(dataview().jsRoot).not.toHaveBeenCalled();
	});

	it('is desktop-only in the browser build, and never asks main', () => {
		vi.mocked(isWebDesktop).mockReturnValue(true);
		useSettingsStore.setState({ dataviewJsTrustedRoots: [ROOT] });
		const { result } = renderHook(() => useDataviewJsRunPolicy(note));
		expect(result.current).toMatchObject({ policy: 'desktop-only', resolving: false });
		expect(dataview().jsRoot).not.toHaveBeenCalled();
	});

	it('reports why main could not name the root, and keeps asking', async () => {
		dataview().jsRoot.mockRejectedValueOnce(new Error('Dataview: no agent with id "agent-1"'));
		const { result } = renderHook(() => useDataviewJsRunPolicy(note));
		await waitFor(() => expect(result.current.error).toMatch(/no agent with id/));
		expect(result.current).toMatchObject({ policy: 'ask', root: null, resolving: false });
	});
});

describe('DataviewJsTrustGate', () => {
	it('mounts the guest in a trusted vault', () => {
		render(
			<DataviewJsTrustGate
				code={SCRIPT}
				theme={mockTheme}
				doc={scope()}
				run={state({ policy: 'run' })}
			/>
		);
		expect(screen.getByTestId('guest-frame')).toHaveTextContent(SCRIPT);
		expect(document.querySelector('[data-dataview-js-trust]')).toBeNull();
	});

	it('shows a placeholder, never the prompt, while the root resolves', () => {
		render(
			<DataviewJsTrustGate
				code={SCRIPT}
				theme={mockTheme}
				doc={scope()}
				run={state({ root: null, resolving: true })}
			/>
		);
		expect(document.querySelector('[data-dataview-loading]')).not.toBeNull();
		expect(document.querySelector('[data-dataview-js-trust]')).toBeNull();
		expect(screen.queryByTestId('guest-frame')).toBeNull();
	});

	it('shows the source as code, explains the read, and offers both buttons when it asks', () => {
		render(<DataviewJsTrustGate code={SCRIPT} theme={mockTheme} doc={scope()} run={state()} />);
		const prompt = document.querySelector('[data-dataview-js-trust]')!;
		expect(prompt).not.toBeNull();
		expect(prompt.querySelector('pre, code')).not.toBeNull();
		expect(prompt.textContent).toContain(SCRIPT);
		expect(screen.getByText(/would read your vault \(\/vault\)/)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Run once' })).toBeEnabled();
		expect(screen.getByRole('button', { name: 'Always trust this vault' })).toBeEnabled();
		expect(screen.queryByTestId('guest-frame')).toBeNull();
	});

	it('Run once asks main for the grant, then runs this block until the script changes', async () => {
		const doc = scope();
		const { rerender } = render(
			<DataviewJsTrustGate code={SCRIPT} theme={mockTheme} doc={doc} run={state()} />
		);
		fireEvent.click(screen.getByRole('button', { name: 'Run once' }));

		expect(dataview().jsRunOnce).toHaveBeenCalledWith({ agentId: 'agent-1', filePath: NOTE });
		expect(await screen.findByTestId('guest-frame')).toHaveTextContent(SCRIPT);
		expect(dataview().trust).not.toHaveBeenCalled();
		expect(useSettingsStore.getState().dataviewJsTrustedRoots).toEqual([]);

		rerender(<DataviewJsTrustGate code={`${SCRIPT};`} theme={mockTheme} doc={doc} run={state()} />);
		expect(screen.queryByTestId('guest-frame')).toBeNull();
		expect(document.querySelector('[data-dataview-js-trust]')).not.toBeNull();
	});

	it('Run once in one note never runs a block of another', async () => {
		const { rerender } = render(
			<DataviewJsTrustGate code={SCRIPT} theme={mockTheme} doc={scope()} run={state()} />
		);
		fireEvent.click(screen.getByRole('button', { name: 'Run once' }));
		await screen.findByTestId('guest-frame');

		rerender(
			<DataviewJsTrustGate
				code={SCRIPT}
				theme={mockTheme}
				doc={scope({ filePath: '/vault/Notes/Other.md' })}
				run={state()}
			/>
		);
		expect(screen.queryByTestId('guest-frame')).toBeNull();
	});

	it('keeps asking, and says why, when main refuses Run once', async () => {
		dataview().jsRunOnce.mockRejectedValueOnce(new Error('Dataview: DataviewJS is turned off.'));
		render(<DataviewJsTrustGate code={SCRIPT} theme={mockTheme} doc={scope()} run={state()} />);
		fireEvent.click(screen.getByRole('button', { name: 'Run once' }));

		expect(await screen.findByText(/DataviewJS is turned off/)).toBeInTheDocument();
		expect(screen.queryByTestId('guest-frame')).toBeNull();
		expect(screen.getByRole('button', { name: 'Run once' })).toBeEnabled();
	});

	it('Always trust this vault adds the root through main and applies the answered list', async () => {
		dataview().trust.mockResolvedValueOnce({
			root: ROOT,
			trusted: true,
			changed: true,
			roots: [ROOT],
		});
		window.maestro.settings.set = vi.fn();
		render(<DataviewJsTrustGate code={SCRIPT} theme={mockTheme} doc={scope()} run={state()} />);
		fireEvent.click(screen.getByRole('button', { name: 'Always trust this vault' }));

		expect(dataview().trust).toHaveBeenCalledWith({ root: ROOT });
		await waitFor(() => expect(useSettingsStore.getState().dataviewJsTrustedRoots).toEqual([ROOT]));
		// Main wrote the setting; the window never writes it back.
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
		expect(dataview().jsRunOnce).not.toHaveBeenCalled();
	});

	it('cannot trust a vault whose root main has not named, and shows why', () => {
		render(
			<DataviewJsTrustGate
				code={SCRIPT}
				theme={mockTheme}
				doc={scope()}
				run={state({ root: null, error: 'Dataview: no agent with id "agent-1"' })}
			/>
		);
		expect(screen.getByRole('button', { name: 'Always trust this vault' })).toBeDisabled();
		expect(screen.getByText(/would read your vault \(this vault\)/)).toBeInTheDocument();
		expect(screen.getByText(/no agent with id/)).toBeInTheDocument();
	});

	it('renders a script that carries markup as text, never as HTML', () => {
		const hostile = '<img src=x onerror="window.pwned=1"> dv.paragraph("x")';
		render(<DataviewJsTrustGate code={hostile} theme={mockTheme} doc={scope()} run={state()} />);
		const prompt = document.querySelector('[data-dataview-js-trust]')!;
		expect(prompt.querySelector('img')).toBeNull();
		expect(prompt.textContent).toContain('onerror');
	});
});
