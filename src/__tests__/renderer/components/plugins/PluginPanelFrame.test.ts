/**
 * @file PluginPanelFrame.test.ts
 * @description withPanelCsp injects a restrictive Content-Security-Policy meta
 * (asserted by the load-bearing connect-src 'none' directive, by substring so
 * extra directives are fine) immediately after <head>, synthesizes a <head> under
 * a bare <html>, or prepends to a fragment - never dropping the original body.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import React from 'react';
import type { PanelContribution } from '../../../../shared/plugins/contributions';
import { THEMES } from '../../../../renderer/constants/themes';
import {
	PluginPanelFrame,
	withPanelCsp,
} from '../../../../renderer/components/plugins/PluginPanelFrame';

/** The CSP meta with its load-bearing connect-src 'none', tolerant of additional
 * directives inside the same content attribute. */
const CSP_META = /<meta http-equiv="Content-Security-Policy"[^>]*connect-src 'none'/;

const theme = THEMES.dracula;

function panel(over: Partial<PanelContribution> = {}): PanelContribution {
	return {
		id: 'acme.tools/board',
		localId: 'board',
		pluginId: 'acme.tools',
		title: 'Acme Board',
		entry: 'board.html',
		placement: 'left',
		...over,
	};
}

function dispatchFrameMessage(
	iframe: HTMLIFrameElement,
	data: unknown,
	origin: string = 'null'
): void {
	const event = new MessageEvent('message', { data, origin });
	Object.defineProperty(event, 'source', { value: iframe.contentWindow });
	window.dispatchEvent(event);
}

beforeEach(() => {
	vi.mocked(window.maestro.plugins.panelHtml).mockReset().mockResolvedValue({
		html: '<button>plugin action</button>',
	});
	vi.mocked(window.maestro.plugins.invokeCommand)
		.mockReset()
		.mockResolvedValue({ dispatched: true });
});

afterEach(() => cleanup());

describe('withPanelCsp', () => {
	it('inserts the CSP meta immediately after an existing <head>', () => {
		const out = withPanelCsp('<html><head></head><body>x</body></html>');
		expect(out).toMatch(CSP_META);
		const headIdx = out.indexOf('<head>');
		const metaIdx = out.indexOf('<meta http-equiv="Content-Security-Policy"');
		expect(metaIdx).toBe(headIdx + '<head>'.length);
		expect(out).toContain('<body>x</body>');
	});

	it('creates a <head> with the meta when there is an <html> but no <head>', () => {
		const out = withPanelCsp('<html><body>hello</body></html>');
		expect(out).toMatch(CSP_META);
		expect(out).toContain('<head>');
		expect(out).toContain('</head>');
		// The synthesized head (and its meta) precedes the body.
		expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<body>'));
		expect(out).toContain('<body>hello</body>');
	});

	it('prepends the meta to a bare fragment', () => {
		const out = withPanelCsp('hi');
		expect(out).toMatch(CSP_META);
		expect(out.indexOf('<meta')).toBe(0);
		expect(out.endsWith('hi')).toBe(true);
	});
});

describe('PluginPanelFrame render isolation', () => {
	it('loads plugin HTML into a sandboxed srcdoc iframe with plugin provenance', async () => {
		const { container } = render(React.createElement(PluginPanelFrame, { theme, panel: panel() }));

		await waitFor(() => expect(screen.getByText('from acme.tools')).toBeInTheDocument());
		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());

		const iframe = container.querySelector('iframe');
		expect(window.maestro.plugins.panelHtml).toHaveBeenCalledWith('acme.tools/board');
		expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts');
		expect(iframe?.getAttribute('sandbox')).not.toContain('allow-same-origin');
		expect(iframe?.getAttribute('src')).toBeNull();
		expect(iframe?.getAttribute('srcdoc')).toMatch(CSP_META);
		expect(iframe?.getAttribute('srcdoc')).toContain('<button>plugin action</button>');
	});

	it('only bridges opaque-origin messages from the owned frame to the owning plugin command', async () => {
		const { container } = render(React.createElement(PluginPanelFrame, { theme, panel: panel() }));
		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		const iframe = container.querySelector('iframe');
		expect(iframe).not.toBeNull();

		dispatchFrameMessage(iframe!, {
			type: 'maestro:invokeCommand',
			commandId: 'open',
			args: { n: 1 },
		});
		await waitFor(() =>
			expect(window.maestro.plugins.invokeCommand).toHaveBeenCalledWith('acme.tools/open', { n: 1 })
		);

		vi.mocked(window.maestro.plugins.invokeCommand).mockClear();
		dispatchFrameMessage(
			iframe!,
			{ type: 'maestro:invokeCommand', commandId: 'open' },
			'https://evil.test'
		);
		window.dispatchEvent(
			new MessageEvent('message', {
				data: { type: 'maestro:invokeCommand', commandId: 'open' },
				origin: 'null',
			})
		);
		dispatchFrameMessage(iframe!, { type: 'other', commandId: 'open' });

		await Promise.resolve();
		expect(window.maestro.plugins.invokeCommand).not.toHaveBeenCalled();
	});
});
