// Source: src/__tests__/renderer/components/MarketplaceModal/components/MarketplaceHeader.test.tsx
// Source: src/__tests__/renderer/utils/buildMaestroUrl.test.ts
import { afterEach } from 'vitest';
import { beforeEach } from 'vitest';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { render } from '@testing-library/react';
import { MarketplaceHeader } from '../../../../../renderer/components/MarketplaceModal/components';
import { mockTheme } from '../_fixtures';
import * as urlBuilder from '../../../../../renderer/utils/buildMaestroUrl';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { buildMaestroUrl } from '../../../../../renderer/utils/buildMaestroUrl';
const openUrlMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../../renderer/utils/openUrl', () => ({
	openUrl: (...args: unknown[]) => openUrlMock(...args),
}));
describe('MarketplaceHeader', () => {
	const baseProps = (overrides: Partial<React.ComponentProps<typeof MarketplaceHeader>> = {}) => ({
		theme: mockTheme,
		fromCache: true,
		cacheAge: 5 * 60_000,
		isRefreshing: false,
		showHelp: false,
		onToggleHelp: vi.fn(),
		onCloseHelp: vi.fn(),
		onRefresh: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	});

	describe('MarketplaceHeader', () => {
		afterEach(() => vi.restoreAllMocks());
		beforeEach(() => {
			openUrlMock.mockReset();
			vi.spyOn(urlBuilder, 'buildMaestroUrl').mockImplementation((url) => 'maestro:' + url);
		});

		it('renders title, cached status, refresh, and close controls', () => {
			const onRefresh = vi.fn();
			const onClose = vi.fn();
			const { getByText, getByTitle } = render(
				<MarketplaceHeader {...baseProps({ onRefresh, onClose })} />
			);

			expect(getByText('Playbook Exchange')).toBeTruthy();
			expect(getByText('Cached 5m ago')).toBeTruthy();

			fireEvent.click(getByTitle('Refresh marketplace data'));
			expect(onRefresh).toHaveBeenCalledTimes(1);

			fireEvent.click(getByTitle('Close (Esc)'));
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('shows Live status and refresh spinner state', () => {
			const { getByText, getByTestId } = render(
				<MarketplaceHeader
					{...baseProps({ fromCache: false, cacheAge: null, isRefreshing: true })}
				/>
			);

			expect(getByText('Live')).toBeTruthy();
			expect(getByTestId('refreshcw-icon').getAttribute('class')).toContain('animate-spin');
		});

		it('toggles and closes the help popover', () => {
			const onToggleHelp = vi.fn();
			const onCloseHelp = vi.fn();
			const { getByTitle, getByText } = render(
				<MarketplaceHeader {...baseProps({ showHelp: true, onToggleHelp, onCloseHelp })} />
			);

			fireEvent.click(getByTitle('About the Playbook Exchange'));
			expect(onToggleHelp).toHaveBeenCalledTimes(1);

			expect(getByText('About the Playbook Exchange')).toBeTruthy();
			fireEvent.click(getByText('Close'));
			expect(onCloseHelp).toHaveBeenCalledTimes(1);
		});

		it('opens GitHub and docs links from header and help popover', () => {
			const onCloseHelp = vi.fn();
			const { getByTitle, getByText } = render(
				<MarketplaceHeader {...baseProps({ showHelp: true, onCloseHelp })} />
			);

			fireEvent.click(getByTitle('Submit your playbook to the community'));
			expect(openUrlMock).toHaveBeenCalledWith('https://github.com/RunMaestro/Maestro-Playbooks');

			fireEvent.click(getByText('github.com/RunMaestro/Maestro-Playbooks'));
			expect(openUrlMock).toHaveBeenCalledWith('https://github.com/RunMaestro/Maestro-Playbooks');
			expect(onCloseHelp).toHaveBeenCalledTimes(1);

			fireEvent.click(getByText('Read more at docs.runmaestro.ai/playbook-exchange'));
			expect(openUrlMock).toHaveBeenCalledWith(
				'maestro:https://docs.runmaestro.ai/playbook-exchange'
			);
			expect(onCloseHelp).toHaveBeenCalledTimes(2);
		});
	});
});
describe('buildMaestroUrl', () => {
	describe('buildMaestroUrl', () => {
		it('appends theme ID as query parameter for built-in themes', () => {
			useSettingsStore.setState({ activeThemeId: 'dracula' });
			const url = buildMaestroUrl('https://runmaestro.ai');
			expect(url).toBe('https://runmaestro.ai/?theme=dracula');
		});

		it('preserves existing path segments', () => {
			useSettingsStore.setState({ activeThemeId: 'nord' });
			const url = buildMaestroUrl('https://runmaestro.ai/discord');
			expect(url).toBe('https://runmaestro.ai/discord?theme=nord');
		});

		it('preserves existing query parameters', () => {
			useSettingsStore.setState({ activeThemeId: 'tokyo-night' });
			const url = buildMaestroUrl('https://docs.runmaestro.ai/?foo=bar');
			expect(url).toBe('https://docs.runmaestro.ai/?foo=bar&theme=tokyo-night');
		});

		it('falls back to dark for custom theme with dark mode', () => {
			useSettingsStore.setState({ activeThemeId: 'custom' });
			// custom theme defaults to dracula which is dark mode
			const url = buildMaestroUrl('https://runmaestro.ai');
			expect(url).toBe('https://runmaestro.ai/?theme=dark');
		});

		it('works with all 16 built-in theme IDs', () => {
			const themeIds = [
				'dracula',
				'monokai',
				'github-light',
				'solarized-light',
				'nord',
				'tokyo-night',
				'one-light',
				'gruvbox-light',
				'catppuccin-mocha',
				'gruvbox-dark',
				'catppuccin-latte',
				'ayu-light',
				'pedurple',
				'maestros-choice',
				'dre-synth',
				'winamp',
			];

			for (const id of themeIds) {
				useSettingsStore.setState({ activeThemeId: id });
				const url = buildMaestroUrl('https://runmaestro.ai');
				expect(url).toContain('theme=' + id);
			}
		});

		it('works with docs subdomain', () => {
			useSettingsStore.setState({ activeThemeId: 'catppuccin-latte' });
			const url = buildMaestroUrl('https://docs.runmaestro.ai/symphony');
			expect(url).toBe('https://docs.runmaestro.ai/symphony?theme=catppuccin-latte');
		});
	});
});
