// Source: src/__tests__/renderer/utils/openUrl.test.ts
// Source: src/__tests__/renderer/utils/linkify.test.tsx
// Source: src/__tests__/renderer/components/Settings/tabs/AboutTab.test.tsx
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { openUrl } from '../../../renderer/utils/openUrl';
import { openInMaestroBrowser } from '../../../renderer/utils/openUrl';
import { openInSystemBrowser } from '../../../renderer/utils/openUrl';
import React from 'react';
import { afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import * as urlRouting from '../../../renderer/utils/openUrl';
import { linkifyNode } from '../../../renderer/utils/linkify';
import type { Theme } from '../../../renderer/types';
import { screen } from '@testing-library/react';
import { AboutTab } from '../../../renderer/components/Settings/tabs/AboutTab';
import * as aboutUrls from '../../../renderer/utils/openUrl';
import { launchFromSettings } from '../../../renderer/utils/launchFromSettings';
const { settingsState, sessionState, setSessions } = vi.hoisted(() => {
	// `updateSessionWith`, the store writer openInMaestroBrowser uses on rc.
	const setSessions = vi.fn();
	return {
		settingsState: { useSystemBrowser: false },
		sessionState: {
			activeSession: { id: 'agent-1' } as { id: string } | null,
		},
		setSessions,
	};
});
vi.mock('../../../renderer/utils/launchFromSettings', () => ({
	launchFromSettings: vi.fn((open: () => void) => open()),
}));

vi.mock('../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: { getState: () => settingsState },
}));
vi.mock('../../../renderer/stores/sessionStore', () => ({
	useSessionStore: { getState: () => sessionState },
	selectActiveSession: (state: typeof sessionState) => state.activeSession,
	updateSessionWith: setSessions,
}));
vi.mock('../../../renderer/hooks/tabs/internal/browserTabHelpers', () => ({
	createBrowserTab: (_sessionId: string, url: string) => ({ id: 'browser-1', url }),
	activateBrowserTab: (session: { browserTabs: unknown[] }, tab: unknown) => ({
		...session,
		browserTabs: [...session.browserTabs, tab],
	}),
}));
describe('openUrl', () => {
	let openExternal: ReturnType<typeof vi.fn>;

	/** URL of the browser tab the last updateSessionWith call added, if any. */
	function openedMaestroUrl(): string | undefined {
		const calls = setSessions.mock.calls;
		const updater = calls[calls.length - 1]?.[1];
		if (!updater) return undefined;
		const next = updater({ id: 'agent-1', browserTabs: [] });
		return next.browserTabs[0]?.url;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		settingsState.useSystemBrowser = false;
		sessionState.activeSession = { id: 'agent-1' };
		openExternal = vi.fn();
		(window as any).maestro = { ...(window as any).maestro, shell: { openExternal } };
	});

	describe('openUrl - default routing', () => {
		it('opens http(s) in a Maestro tab when the setting says Maestro', () => {
			openUrl('https://example.com');
			expect(openedMaestroUrl()).toBe('https://example.com');
			expect(openExternal).not.toHaveBeenCalled();
		});

		it('opens http(s) in the system browser when the setting says system', () => {
			settingsState.useSystemBrowser = true;
			openUrl('https://example.com');
			expect(openExternal).toHaveBeenCalledWith('https://example.com');
			expect(setSessions).not.toHaveBeenCalled();
		});

		it('inverts the setting when the modifier is held', () => {
			settingsState.useSystemBrowser = true;
			openUrl('https://example.com', { ctrlKey: true });
			expect(openedMaestroUrl()).toBe('https://example.com');
		});
	});

	describe('openUrl - routing hints', () => {
		it('maestro+ always opens a Maestro tab, stripped, whatever the setting or modifier', () => {
			settingsState.useSystemBrowser = true;
			openUrl('maestro+http://localhost:8000/x', { ctrlKey: true });
			expect(openedMaestroUrl()).toBe('http://localhost:8000/x');
			expect(openExternal).not.toHaveBeenCalled();
		});

		it('system+ always opens the system browser, stripped, whatever the setting or modifier', () => {
			settingsState.useSystemBrowser = false;
			openUrl('system+https://github.com', { ctrlKey: true });
			expect(openExternal).toHaveBeenCalledWith('https://github.com');
			expect(setSessions).not.toHaveBeenCalled();
		});

		it.each(['maestro+file:///tmp/x', 'maestro+javascript:void(0)', 'system+ssh://host'])(
			'opens nothing for %s',
			(url) => {
				openUrl(url);
				expect(openExternal).not.toHaveBeenCalled();
				expect(setSessions).not.toHaveBeenCalled();
			}
		);

		it('falls back to the system browser, stripped, when there is no active agent', () => {
			sessionState.activeSession = null;
			openUrl('maestro+http://localhost:8000/x');
			expect(openExternal).toHaveBeenCalledWith('http://localhost:8000/x');
		});
	});

	describe('explicit openers strip hints too', () => {
		it('openInSystemBrowser strips a hint and refuses an invalid one', () => {
			openInSystemBrowser('maestro+https://x.com');
			expect(openExternal).toHaveBeenCalledWith('https://x.com');
			openExternal.mockClear();
			openInSystemBrowser('system+ssh://host');
			expect(openExternal).not.toHaveBeenCalled();
		});

		it('openInMaestroBrowser strips a hint and refuses an invalid one', () => {
			openInMaestroBrowser('system+https://x.com');
			expect(openedMaestroUrl()).toBe('https://x.com');
			setSessions.mockClear();
			openInMaestroBrowser('maestro+file:///tmp/x');
			expect(setSessions).not.toHaveBeenCalled();
		});
	});
});
describe('linkify', () => {
	const theme = { colors: { accentText: '#88aaff' } } as unknown as Theme;

	function renderText(text: string) {
		return render(<div>{linkifyNode(text, theme)}</div>);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		(window as any).maestro = { ...(window as any).maestro, shell: { openExternal: vi.fn() } };
	});

	describe('linkifyNode', () => {
		beforeEach(() => {
			vi.spyOn(urlRouting, 'openUrl').mockImplementation(() => {});
		});
		afterEach(() => vi.restoreAllMocks());
		it('opens a clicked URL through openUrl, not straight to the shell', () => {
			const { getByText } = renderText('see https://example.com/a.');
			fireEvent.click(getByText('https://example.com/a'));
			expect(openUrl).toHaveBeenCalledWith('https://example.com/a', { ctrlKey: false });
			expect((window as any).maestro.shell.openExternal).not.toHaveBeenCalled();
		});

		it('passes Cmd-click through as the inversion modifier', () => {
			const { getByText } = renderText('https://example.com');
			fireEvent.click(getByText('https://example.com'), { metaKey: true });
			expect(openUrl).toHaveBeenCalledWith('https://example.com', { ctrlKey: true });
		});

		it('links a routing-hinted URL as one link, hint included', () => {
			const { getByText } = renderText('preview at maestro+http://localhost:5173 now');
			fireEvent.click(getByText('maestro+http://localhost:5173'));
			expect(openUrl).toHaveBeenCalledWith('maestro+http://localhost:5173', { ctrlKey: false });
		});
	});
});
describe('AboutTab', () => {
	// __APP_VERSION__ / __COMMIT_HASH__ are injected by the bundler at build time.
	(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '1.0.0';
	(globalThis as unknown as { __COMMIT_HASH__: string }).__COMMIT_HASH__ = '';

	const theme = {
		colors: {
			accent: '#a78bfa',
			textMain: '#ffffff',
			textDim: '#888888',
			bgMain: '#1e1f29',
		},
	} as unknown as Theme;

	describe('AboutTab', () => {
		afterEach(() => vi.restoreAllMocks());
		beforeEach(() => {
			vi.clearAllMocks();
			vi.spyOn(aboutUrls, 'openInSystemBrowser').mockImplementation(() => {});
			vi.spyOn(aboutUrls, 'openUrl').mockImplementation(() => {});
		});

		it('renders the wordmark and tagline', () => {
			render(<AboutTab theme={theme} />);
			expect(screen.getByText('MAESTRO')).toBeInTheDocument();
			expect(screen.getByText('Agent Orchestration Command Center')).toBeInTheDocument();
		});

		it('renders the version from __APP_VERSION__', () => {
			render(<AboutTab theme={theme} />);
			expect(screen.getByText('v1.0.0')).toBeInTheDocument();
		});

		it('renders the origin caption with the founding date', () => {
			render(<AboutTab theme={theme} />);
			expect(screen.getByText('Born on Nov 26, 2025 in Austin, TX')).toBeInTheDocument();
		});

		it('closes Settings and opens the live privacy page when Privacy is clicked', () => {
			render(<AboutTab theme={theme} />);
			fireEvent.click(screen.getByRole('button', { name: /privacy/i }));
			expect(launchFromSettings).toHaveBeenCalledTimes(1);
			expect(openUrl).toHaveBeenCalledWith(
				expect.stringContaining('https://runmaestro.ai/privacy/')
			);
		});

		it('opens San Jac Saloon in the system browser when the Texas flag is clicked', () => {
			render(<AboutTab theme={theme} />);
			fireEvent.click(screen.getByLabelText('San Jac Saloon'));
			expect(openInSystemBrowser).toHaveBeenCalledWith('https://www.sanjacsaloon.com');
		});
	});
});
