/**
 * Tests for AboutTab - the large-format informational About panel.
 *
 * Verifies the wordmark, tagline, version, origin caption, and that the
 * Texas flag (rendered via the shared MaestroFlags component) links to
 * the San Jac Saloon.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Theme } from '../../../../../renderer/types';
import { AboutTab } from '../../../../../renderer/components/Settings/tabs/AboutTab';

vi.mock('../../../../../renderer/utils/openUrl', () => ({
	openInSystemBrowser: vi.fn(),
}));

import { openInSystemBrowser } from '../../../../../renderer/utils/openUrl';

// __APP_VERSION__ / __COMMIT_HASH__ are injected by the bundler at build time.
(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '1.0.0';
(globalThis as unknown as { __COMMIT_HASH__: string }).__COMMIT_HASH__ = '';

const theme = {
	colors: {
		accent: '#a78bfa',
		textMain: '#ffffff',
		textDim: '#888888',
	},
} as unknown as Theme;

describe('AboutTab', () => {
	beforeEach(() => {
		vi.clearAllMocks();
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

	it('opens San Jac Saloon in the system browser when the Texas flag is clicked', () => {
		render(<AboutTab theme={theme} />);
		fireEvent.click(screen.getByLabelText('San Jac Saloon'));
		expect(openInSystemBrowser).toHaveBeenCalledWith('https://www.sanjacsaloon.com');
	});
});
