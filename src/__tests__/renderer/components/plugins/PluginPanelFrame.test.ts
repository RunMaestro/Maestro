/**
 * @file PluginPanelFrame.test.ts
 * @description The panel frame renders an isolated <webview> surface - a
 * per-plugin partition (`plugin:<id>`) and the panel's own `plugin-panel://`
 * document URL, never srcdoc/inline HTML - under the non-suppressible
 * provenance line. The bridge accepts ONLY the guest preload's
 * `maestro:invokeCommand` ipc-message, namespaces the command to the owning
 * plugin, and forwards it over the broker-gated invokeCommand RPC. A failed
 * document load (unknown/ungranted panel) swaps the frame for an error state.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import React from 'react';
import type { PanelContribution } from '../../../../shared/plugins/contributions';
import { THEMES } from '../../../../renderer/constants/themes';
import { PluginPanelFrame } from '../../../../renderer/components/plugins/PluginPanelFrame';

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
	vi.mocked(window.maestro.plugins.invokeCommand)
		.mockReset()
		.mockResolvedValue({ dispatched: true });
});

afterEach(() => cleanup());

describe('PluginPanelFrame render isolation', () => {
	it('renders a webview on the per-plugin partition and panel document URL, with provenance', () => {
		const { container } = render(React.createElement(PluginPanelFrame, { theme, panel: panel() }));

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
		const { container } = render(React.createElement(PluginPanelFrame, { theme, panel: panel() }));
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

	it('shows the error state when the panel document fails to load', async () => {
		const { container } = render(React.createElement(PluginPanelFrame, { theme, panel: panel() }));
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
