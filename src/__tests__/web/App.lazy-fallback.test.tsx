import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { MaestroConfig } from '../../web/utils/config';

const harness = vi.hoisted(() => ({
	config: {
		securityToken: 'token-fallback',
		sessionId: null,
		tabId: null,
		apiBase: '/token-fallback/api',
		wsUrl: '/token-fallback/ws',
	} as MaestroConfig,
	registerServiceWorker: vi.fn(),
	isOffline: vi.fn(() => false),
	loggerDebug: vi.fn(),
	loggerInfo: vi.fn(),
}));

vi.mock('../../web/utils/config', () => ({
	getMaestroConfig: () => harness.config,
}));

vi.mock('../../web/utils/serviceWorker', () => ({
	isOffline: harness.isOffline,
	registerServiceWorker: harness.registerServiceWorker,
}));

vi.mock('../../web/utils/logger', () => ({
	webLogger: {
		debug: harness.loggerDebug,
		info: harness.loggerInfo,
	},
}));

vi.mock('../../web/components/ThemeProvider', () => ({
	ThemeProvider: ({ children }: { children: React.ReactNode }) => (
		<section data-testid="theme-provider">{children}</section>
	),
}));

vi.mock('../../web/mobile', () => {
	throw new Error('mobile chunk unavailable');
});

import { App } from '../../web/App';

describe('web App lazy fallback', () => {
	beforeEach(() => {
		harness.registerServiceWorker.mockClear();
		harness.isOffline.mockClear();
		harness.loggerDebug.mockClear();
		harness.loggerInfo.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders the placeholder when the mobile module fails to load', async () => {
		render(<App />);

		expect(await screen.findByRole('heading', { name: 'Maestro Web' })).toBeInTheDocument();
		expect(screen.getByText('Remote control interface')).toBeInTheDocument();
		expect(
			screen.getByText('Connect to your Maestro desktop app to get started')
		).toBeInTheDocument();
		expect(harness.registerServiceWorker).toHaveBeenCalledTimes(1);
	});
});
