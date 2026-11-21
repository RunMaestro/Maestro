// Source: src/__tests__/renderer/components/plugins/PluginPanelFrame.test.ts
// Source: src/renderer/components/plugins/__tests__/PluginPanelFrame.test.tsx
import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import React from 'react';
import type { PanelContribution } from '../../../../shared/plugins/contributions';
import { THEMES } from '../../../../renderer/constants/themes';
import { PluginPanelFrame } from '../../../../renderer/components/plugins/PluginPanelFrame';
import { notifyToast } from '../../../../renderer/stores/notificationStore';
import { fireEvent } from '@testing-library/react';
import { PANEL_THEME_CHANNEL } from '../../../../shared/plugins/panel-theme';
import { PANEL_BRIDGE_CHANNEL } from '../../../../shared/plugins/panel-host';
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
describe('PluginPanelFrame', () => {
	const theme = THEMES.dracula;

	function panel(over: Partial<PanelContribution> = {}): PanelContribution {
		return {
			id: 'acme.tools/board',
			localId: 'board',
			pluginId: 'acme.tools',
			title: 'Acme Board',
			entry: 'panel.html',
			placement: 'modal',
			...over,
		};
	}

	/** Dispatch a guest-preload `ipc-message` event on the webview element. */
	function dispatchIpcMessage(webview: Element, channel: string, payload: unknown): void {
		const event = new Event('ipc-message');
		Object.assign(event, { channel, args: [payload] });
		webview.dispatchEvent(event);
	}

	beforeEach(() => {
		vi.mocked(notifyToast).mockClear();
		vi.mocked(window.maestro.plugins.invokeCommand)
			.mockReset()
			.mockResolvedValue({ dispatched: true });
	});

	afterEach(() => cleanup());

	describe('PluginPanelFrame render isolation', () => {
		it('renders a webview on the per-plugin partition and panel document URL, with provenance', () => {
			const { container } = render(
				React.createElement(PluginPanelFrame, { theme, panel: panel() })
			);

			expect(screen.getByText('from acme.tools')).toBeInTheDocument();

			const webview = container.querySelector('webview');
			expect(webview).not.toBeNull();
			// Per-plugin in-memory session - never persist:, never the app session.
			expect(webview?.getAttribute('partition')).toBe('plugin:acme.tools');
			// The document comes from the main-process protocol handler, never inline.
			expect(webview?.getAttribute('src')).toBe('plugin-panel://panel/acme.tools%2Fboard');
			expect(webview?.getAttribute('srcdoc')).toBeNull();
			// The renderer never supplies webPreferences - main forces them all in
			// will-attach-webview; anything set here would be untrusted anyway.
			expect(webview?.getAttribute('webpreferences')).toBeNull();
			expect(webview?.getAttribute('allowpopups')).toBeNull();
		});

		it('bridges only the guest ipc-message channel to the owning plugin command', async () => {
			const { container } = render(
				React.createElement(PluginPanelFrame, { theme, panel: panel() })
			);
			const webview = container.querySelector('webview');
			expect(webview).not.toBeNull();

			dispatchIpcMessage(webview!, 'maestro:invokeCommand', {
				commandId: 'open',
				args: { n: 1 },
			});
			await waitFor(() =>
				expect(window.maestro.plugins.invokeCommand).toHaveBeenCalledWith('acme.tools/open', {
					n: 1,
				})
			);

			vi.mocked(window.maestro.plugins.invokeCommand).mockClear();
			// Wrong channel, malformed payloads, and non-string commandId are ignored.
			dispatchIpcMessage(webview!, 'other-channel', { commandId: 'open' });
			dispatchIpcMessage(webview!, 'maestro:invokeCommand', null);
			dispatchIpcMessage(webview!, 'maestro:invokeCommand', { commandId: 42 });
			dispatchIpcMessage(webview!, 'maestro:invokeCommand', { commandId: '' });

			await Promise.resolve();
			expect(window.maestro.plugins.invokeCommand).not.toHaveBeenCalled();
		});

		it('reports an undelivered panel command without guessing plugin state or exposing arguments', async () => {
			vi.mocked(window.maestro.plugins.invokeCommand).mockResolvedValue({ dispatched: false });
			const { container } = render(
				React.createElement(PluginPanelFrame, { theme, panel: panel() })
			);
			const webview = container.querySelector('webview')!;

			dispatchIpcMessage(webview, 'maestro:invokeCommand', {
				commandId: 'save-token',
				args: { token: 'test-secret-must-not-appear' },
			});

			await waitFor(() =>
				expect(notifyToast).toHaveBeenCalledWith({
					color: 'red',
					title: 'Plugin',
					message:
						'Command could not be delivered to plugin "acme.tools". Check its status and the command input, then try again.',
				})
			);
			expect(JSON.stringify(vi.mocked(notifyToast).mock.calls)).not.toContain(
				'test-secret-must-not-appear'
			);
		});

		it('does not announce success before a delivered panel command has completed', async () => {
			const { container } = render(
				React.createElement(PluginPanelFrame, { theme, panel: panel() })
			);
			dispatchIpcMessage(container.querySelector('webview')!, 'maestro:invokeCommand', {
				commandId: 'save-token',
			});
			await waitFor(() => expect(window.maestro.plugins.invokeCommand).toHaveBeenCalledOnce());
			expect(notifyToast).not.toHaveBeenCalled();
		});

		it('shows the error state when the panel document fails to load', async () => {
			const { container } = render(
				React.createElement(PluginPanelFrame, { theme, panel: panel() })
			);
			const webview = container.querySelector('webview');
			expect(webview).not.toBeNull();

			webview!.dispatchEvent(new Event('did-fail-load'));

			await waitFor(() =>
				expect(screen.getByText('Panel content could not be loaded.')).toBeInTheDocument()
			);
			expect(container.querySelector('webview')).toBeNull();
			// Provenance stays even in the error state.
			expect(screen.getByText('from acme.tools')).toBeInTheDocument();
		});
	});
});
describe('PluginPanelFrame.theme-transfer', () => {
	const panel: PanelContribution = {
		id: 'acme.tools/board',
		localId: 'board',
		pluginId: 'acme.tools',
		title: 'Board',
		entry: 'board.html',
		placement: 'settings',
		size: 'default',
	};

	beforeEach(() => {
		window.maestro.plugins = {
			onPanelData: vi.fn(() => () => {}),
			invokeCommand: vi.fn().mockResolvedValue({ dispatched: true }),
		} as unknown as typeof window.maestro.plugins;
	});
	afterEach(() => cleanup());

	describe('PluginPanelFrame theme transfer', () => {
		it('sends the latest theme on dom-ready and later theme changes, then removes its listener', () => {
			const { container, rerender, unmount } = render(
				<PluginPanelFrame theme={THEMES.dracula} panel={panel} />
			);
			const webview = container.querySelector('webview') as HTMLElement;
			const send = vi.fn();
			Object.assign(webview, { send });
			expect(send).not.toHaveBeenCalled();

			// A theme change before the guest is ready must not send into an unattached webview.
			rerender(<PluginPanelFrame theme={THEMES['one-light']} panel={panel} />);
			expect(send).not.toHaveBeenCalled();
			expect(webview.style.backgroundColor).toBe('rgb(250, 250, 250)');
			webview.dispatchEvent(new Event('dom-ready'));
			expect(send).toHaveBeenCalledTimes(1);
			expect(send).toHaveBeenLastCalledWith(
				PANEL_THEME_CHANNEL,
				expect.objectContaining({
					colorScheme: 'light',
					colors: expect.objectContaining({
						'--maestro-bg-main': THEMES['one-light'].colors.bgMain,
					}),
				})
			);

			rerender(<PluginPanelFrame theme={THEMES.dracula} panel={panel} />);
			expect(send).toHaveBeenCalledTimes(2);
			expect(send.mock.calls[1][1].colorScheme).toBe('dark');
			unmount();
			webview.dispatchEvent(new Event('dom-ready'));
			expect(send).toHaveBeenCalledTimes(2);
		});

		it('does not send an old panel theme after switching panel identity', () => {
			const { container, rerender } = render(
				<PluginPanelFrame theme={THEMES.dracula} panel={panel} />
			);
			const webview = container.querySelector('webview')!;
			const send = vi.fn();
			Object.assign(webview, { send });
			rerender(
				<PluginPanelFrame
					theme={THEMES['one-light']}
					panel={{ ...panel, id: 'acme.tools/other' }}
				/>
			);
			expect(send).not.toHaveBeenCalled();
			webview.dispatchEvent(new Event('dom-ready'));
			expect(send).not.toHaveBeenCalled();
			const newWebview = container.querySelector('webview')!;
			expect(newWebview).not.toBe(webview);
			const newSend = vi.fn();
			Object.assign(newWebview, { send: newSend });
			newWebview.dispatchEvent(new Event('dom-ready'));
			expect(newSend).toHaveBeenCalledTimes(1);
			expect(newSend.mock.calls[0][1].colorScheme).toBe('light');
		});

		it('routes bridge commands to the current plugin and removes listeners after load failure', () => {
			const { container, rerender } = render(
				<PluginPanelFrame theme={THEMES.dracula} panel={panel} />
			);
			const webview = container.querySelector('webview')!;
			const send = vi.fn();
			Object.assign(webview, { send });
			rerender(
				<PluginPanelFrame
					theme={THEMES.dracula}
					panel={{ ...panel, id: 'other.tools/board', pluginId: 'other.tools' }}
				/>
			);
			const command = Object.assign(new Event('ipc-message'), {
				channel: PANEL_BRIDGE_CHANNEL,
				args: [{ commandId: 'run', args: { value: 1 } }],
			});
			fireEvent(webview, command);
			expect(window.maestro.plugins.invokeCommand).not.toHaveBeenCalled();
			const newWebview = container.querySelector('webview')!;
			expect(newWebview).not.toBe(webview);
			Object.assign(newWebview, { send });
			fireEvent(newWebview, command);
			expect(window.maestro.plugins.invokeCommand).toHaveBeenCalledWith('other.tools/run', {
				value: 1,
			});
			fireEvent(newWebview, new Event('did-fail-load'));
			expect(container.querySelector('webview')).toBeNull();
			fireEvent(newWebview, new Event('dom-ready'));
			fireEvent(newWebview, command);
			expect(send).not.toHaveBeenCalled();
			expect(window.maestro.plugins.invokeCommand).toHaveBeenCalledTimes(1);
		});
	});
});
