import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { PluginPanelFrame } from '../PluginPanelFrame';
import { THEMES } from '../../../constants/themes';
import { PANEL_THEME_CHANNEL } from '../../../../shared/plugins/panel-theme';
import { PANEL_BRIDGE_CHANNEL } from '../../../../shared/plugins/panel-host';
import type { PanelContribution } from '../../../../shared/plugins/contributions';

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
			<PluginPanelFrame theme={THEMES['one-light']} panel={{ ...panel, id: 'acme.tools/other' }} />
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
