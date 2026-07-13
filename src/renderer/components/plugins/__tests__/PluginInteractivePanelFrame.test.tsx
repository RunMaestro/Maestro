import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
	PluginInteractivePanelFrame,
	type InteractivePanelHostBinder,
} from '../PluginInteractivePanelFrame';
import { THEMES } from '../../../constants/themes';
import type { CanonicalInteractivePanelContribution } from '../../../../shared/plugins/contributions';

const panel = {
	ownerPluginId: 'com.example.agent',
	localId: 'agent-panel',
	canonicalContributionId: 'com.example.agent/agent-panel',
	title: 'Agent workspace panel',
	entry: 'panel.html',
} as unknown as CanonicalInteractivePanelContribution;

const bind = vi.fn<InteractivePanelHostBinder['bind']>(() => vi.fn());
const binder: InteractivePanelHostBinder = { bind };

describe('PluginInteractivePanelFrame', () => {
	it('hosts the declared panel under its owner-bound partition and canonical panel URL', () => {
		const cleanup = vi.fn();
		bind.mockReturnValueOnce(cleanup);
		const { container, unmount } = render(
			<PluginInteractivePanelFrame theme={THEMES.dracula} panel={panel} binder={binder} />
		);

		expect(screen.getByText('from com.example.agent')).toBeVisible();
		const webview = container.querySelector('webview');
		expect(webview).not.toBeNull();
		expect(webview?.getAttribute('partition')).toBe('plugin:com.example.agent');
		expect(webview?.getAttribute('src')).toBe(
			'plugin-panel://panel/com.example.agent%2Fagent-panel'
		);
		expect(webview?.getAttribute('srcdoc')).toBeNull();
		expect(bind).toHaveBeenCalledOnce();
		expect(bind.mock.calls[0]?.[0]?.panel).toEqual(panel);
		unmount();
		expect(cleanup).toHaveBeenCalledOnce();
	});

	it('replaces a failed guest, restores focus, and gives keyboard users an accessible retry', async () => {
		bind.mockReset();
		const firstCleanup = vi.fn();
		const secondCleanup = vi.fn();
		bind.mockReturnValueOnce(firstCleanup).mockReturnValueOnce(secondCleanup);
		const { container } = render(
			<PluginInteractivePanelFrame theme={THEMES.dracula} panel={panel} binder={binder} />
		);

		const firstWebview = container.querySelector('webview');
		expect(firstWebview).not.toBeNull();
		fireEvent(firstWebview!, new Event('did-fail-load'));

		const retry = await screen.findByRole('button', { name: 'Retry panel' });
		expect(retry).toHaveFocus();
		expect(screen.getByRole('alert')).toHaveTextContent('Panel content could not be loaded.');
		expect(firstCleanup).toHaveBeenCalledOnce();

		fireEvent.click(retry);
		await waitFor(() => expect(bind).toHaveBeenCalledTimes(2));
		const retryWebview = container.querySelector('webview');
		expect(retryWebview).not.toBe(firstWebview);
		expect(retryWebview).toHaveFocus();
	});

	it('surfaces a synchronous binder failure through the same retry control', async () => {
		bind.mockReset();
		bind.mockImplementationOnce(() => {
			throw new Error('binding transport unavailable');
		});
		render(<PluginInteractivePanelFrame theme={THEMES.dracula} panel={panel} binder={binder} />);

		const retry = await screen.findByRole('button', { name: 'Retry panel' });
		expect(retry).toHaveFocus();
		expect(screen.getByRole('alert')).toHaveTextContent('Panel content could not be loaded.');
	});
});
