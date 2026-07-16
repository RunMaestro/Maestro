/**
 * Tests for SymphonyModal/components/SymphonyHeader - title, help popover,
 * refresh button + spinner, close button, register-link, cache age label.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

const openUrlSpy = vi.fn();
vi.mock('../../../../../renderer/utils/openUrl', () => ({
	openUrl: (...args: unknown[]) => openUrlSpy(...args),
}));
vi.mock('../../../../../renderer/utils/buildMaestroUrl', () => ({
	buildMaestroUrl: (u: string) => `https://m/${u}`,
}));

vi.mock('../../../../../renderer/components/ui/GhostIconButton', () => ({
	GhostIconButton: ({
		onClick,
		children,
		title,
	}: {
		onClick?: () => void;
		children: React.ReactNode;
		title?: string;
	}) => (
		<button onClick={onClick} title={title} data-testid="ghost-icon-button">
			{children}
		</button>
	),
}));

vi.mock('lucide-react', () => {
	const icon = (name: string) => {
		const C = ({ className }: { className?: string }) => (
			<svg data-testid={`icon-${name}`} className={className} />
		);
		C.displayName = name;
		return C;
	};
	return {
		Music: icon('Music'),
		HelpCircle: icon('HelpCircle'),
		Github: icon('Github'),
		RefreshCw: icon('RefreshCw'),
		X: icon('X'),
	};
});

import { SymphonyHeader } from '../../../../../renderer/components/SymphonyModal/components/SymphonyHeader';
import { mockTheme } from '../_fixtures';

const base = (overrides: Partial<React.ComponentProps<typeof SymphonyHeader>> = {}) => ({
	theme: mockTheme,
	showCacheStatus: true,
	fromCache: true,
	cacheAge: 90_000,
	isRefreshing: false,
	onRefresh: vi.fn(),
	onClose: vi.fn(),
	showHelp: false,
	onToggleHelp: vi.fn(),
	onCloseHelp: vi.fn(),
	...overrides,
});

beforeEach(() => openUrlSpy.mockReset());

describe('SymphonyHeader', () => {
	it('toggles the help popover via onToggleHelp', () => {
		const onToggleHelp = vi.fn();
		const { getByTitle } = render(<SymphonyHeader {...base({ onToggleHelp })} />);
		fireEvent.click(getByTitle('About Maestro Symphony'));
		expect(onToggleHelp).toHaveBeenCalledTimes(1);
	});

	it('renders the help popover content when showHelp is true and closes via onCloseHelp', () => {
		const onCloseHelp = vi.fn();
		const { getByText } = render(<SymphonyHeader {...base({ showHelp: true, onCloseHelp })} />);
		expect(getByText('About Maestro Symphony')).toBeTruthy();
		fireEvent.click(getByText('Close'));
		expect(onCloseHelp).toHaveBeenCalledTimes(1);
	});

	it('opens the docs URL when the register-link button is clicked', () => {
		const { getByTitle } = render(<SymphonyHeader {...base()} />);
		fireEvent.click(getByTitle('Register your project for Symphony contributions'));
		expect(openUrlSpy).toHaveBeenCalledWith('https://m/https://docs.runmaestro.ai/symphony');
	});

	it('refresh button triggers onRefresh and spins while isRefreshing', () => {
		const onRefresh = vi.fn();
		const { getByTitle, getByTestId, rerender } = render(
			<SymphonyHeader {...base({ onRefresh })} />
		);
		fireEvent.click(getByTitle('Refresh'));
		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(getByTestId('icon-RefreshCw').getAttribute('class')).not.toMatch(/animate-spin/);

		rerender(<SymphonyHeader {...base({ isRefreshing: true })} />);
		expect(getByTestId('icon-RefreshCw').getAttribute('class')).toMatch(/animate-spin/);
	});

	it('close button triggers onClose', () => {
		const onClose = vi.fn();
		const { getByTitle } = render(<SymphonyHeader {...base({ onClose })} />);
		fireEvent.click(getByTitle('Close (Esc)'));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('renders "Cached Xm ago" when fromCache and cacheAge are set; "Live" otherwise', () => {
		const { getByText, rerender, queryByText } = render(
			<SymphonyHeader {...base({ fromCache: true, cacheAge: 5 * 60_000 })} />
		);
		expect(getByText('Cached 5m ago')).toBeTruthy();
		rerender(<SymphonyHeader {...base({ fromCache: false, cacheAge: null })} />);
		expect(getByText('Live')).toBeTruthy();
		rerender(<SymphonyHeader {...base({ showCacheStatus: false })} />);
		expect(queryByText(/Cached/)).toBeNull();
		expect(queryByText('Live')).toBeNull();
	});

	it('clicking "docs.runmaestro.ai/symphony" inside the popover opens URL and closes help', () => {
		const onCloseHelp = vi.fn();
		const { getByText } = render(<SymphonyHeader {...base({ showHelp: true, onCloseHelp })} />);
		fireEvent.click(getByText('docs.runmaestro.ai/symphony'));
		expect(openUrlSpy).toHaveBeenCalledWith('https://m/https://docs.runmaestro.ai/symphony');
		expect(onCloseHelp).toHaveBeenCalledTimes(1);
	});
});
