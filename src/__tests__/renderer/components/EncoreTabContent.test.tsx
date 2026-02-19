/**
 * Tests for EncoreTabContent component
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EncoreTabContent } from '../../../renderer/components/EncoreTabContent';
import type { Theme } from '../../../renderer/types';
import type { LoadedEncore } from '../../../shared/encore-types';

const mockTheme: Theme = {
	id: 'dark',
	name: 'Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		border: '#333',
		textMain: '#e4e4e7',
		textDim: '#a1a1aa',
		accent: '#6366f1',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const mockEncores: LoadedEncore[] = [
	{
		manifest: {
			id: 'ui-encore',
			name: 'UI Encore',
			version: '1.0.0',
			description: 'Encore with UI',
			author: 'Test',
			main: 'index.js',
			renderer: 'renderer.html',
			permissions: [],
		},
		state: 'active',
		path: '/encores/ui-encore',
	},
	{
		manifest: {
			id: 'no-ui-encore',
			name: 'No UI Encore',
			version: '1.0.0',
			description: 'Encore without UI',
			author: 'Test',
			main: 'index.js',
			permissions: [],
		},
		state: 'active',
		path: '/encores/no-ui-encore',
	},
];

describe('EncoreTabContent', () => {
	it('renders iframe for encore with renderer entry', () => {
		const { container } = render(
			<EncoreTabContent
				encoreId="ui-encore"
				tabId="main"
				theme={mockTheme}
				encores={mockEncores}
			/>
		);

		const iframe = container.querySelector('iframe');
		expect(iframe).toBeTruthy();
		expect(iframe?.getAttribute('src')).toBe('file:///encores/ui-encore/renderer.html');
		expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts');
		expect(iframe?.getAttribute('title')).toContain('UI Encore');
	});

	it('shows "no UI" message for encore without renderer', () => {
		render(
			<EncoreTabContent
				encoreId="no-ui-encore"
				tabId="main"
				theme={mockTheme}
				encores={mockEncores}
			/>
		);

		expect(screen.getByText('No UI Encore')).toBeInTheDocument();
		expect(screen.getByText('This encore has no UI')).toBeInTheDocument();
	});

	it('shows "not found" message for unknown encore', () => {
		render(
			<EncoreTabContent
				encoreId="unknown-encore"
				tabId="main"
				theme={mockTheme}
				encores={mockEncores}
			/>
		);

		expect(screen.getByText('Encore not found: unknown-encore')).toBeInTheDocument();
	});

	it('sets data attributes on wrapper', () => {
		const { container } = render(
			<EncoreTabContent
				encoreId="ui-encore"
				tabId="dashboard"
				theme={mockTheme}
				encores={mockEncores}
			/>
		);

		const wrapper = container.querySelector('[data-encore-id="ui-encore"]');
		expect(wrapper).toBeTruthy();
		expect(wrapper?.getAttribute('data-tab-id')).toBe('dashboard');
	});

	it('iframe does not have allow-same-origin in sandbox', () => {
		const { container } = render(
			<EncoreTabContent
				encoreId="ui-encore"
				tabId="main"
				theme={mockTheme}
				encores={mockEncores}
			/>
		);

		const iframe = container.querySelector('iframe');
		expect(iframe?.getAttribute('sandbox')).not.toContain('allow-same-origin');
	});
});
