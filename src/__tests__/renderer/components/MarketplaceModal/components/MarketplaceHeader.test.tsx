import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { MarketplaceHeader } from '../../../../../renderer/components/MarketplaceModal/components';
import { mockTheme } from '../_fixtures';

const openUrlMock = vi.fn();

vi.mock('../../../../../renderer/utils/openUrl', () => ({
	openUrl: (...args: unknown[]) => openUrlMock(...args),
}));

vi.mock('../../../../../renderer/utils/buildMaestroUrl', () => ({
	buildMaestroUrl: (url: string) => `maestro:${url}`,
}));

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
	beforeEach(() => {
		openUrlMock.mockReset();
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
			<MarketplaceHeader {...baseProps({ fromCache: false, cacheAge: null, isRefreshing: true })} />
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
