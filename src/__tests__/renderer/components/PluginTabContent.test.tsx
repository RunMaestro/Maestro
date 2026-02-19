/**
 * Tests for PluginTabContent component
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PluginTabContent } from '../../../renderer/components/PluginTabContent';
import type { Theme } from '../../../renderer/types';
import type { LoadedPlugin } from '../../../shared/plugin-types';

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

const mockPlugins: LoadedPlugin[] = [
	{
		manifest: {
			id: 'ui-plugin',
			name: 'UI Plugin',
			version: '1.0.0',
			description: 'Plugin with UI',
			author: 'Test',
			main: 'index.js',
			renderer: 'renderer.html',
			permissions: [],
		},
		state: 'active',
		path: '/plugins/ui-plugin',
	},
	{
		manifest: {
			id: 'no-ui-plugin',
			name: 'No UI Plugin',
			version: '1.0.0',
			description: 'Plugin without UI',
			author: 'Test',
			main: 'index.js',
			permissions: [],
		},
		state: 'active',
		path: '/plugins/no-ui-plugin',
	},
];

describe('PluginTabContent', () => {
	it('renders iframe for plugin with renderer entry', () => {
		const { container } = render(
			<PluginTabContent
				pluginId="ui-plugin"
				tabId="main"
				theme={mockTheme}
				plugins={mockPlugins}
			/>
		);

		const iframe = container.querySelector('iframe');
		expect(iframe).toBeTruthy();
		expect(iframe?.getAttribute('src')).toBe('file:///plugins/ui-plugin/renderer.html');
		expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts');
		expect(iframe?.getAttribute('title')).toContain('UI Plugin');
	});

	it('shows "no UI" message for plugin without renderer', () => {
		render(
			<PluginTabContent
				pluginId="no-ui-plugin"
				tabId="main"
				theme={mockTheme}
				plugins={mockPlugins}
			/>
		);

		expect(screen.getByText('No UI Plugin')).toBeInTheDocument();
		expect(screen.getByText('This plugin has no UI')).toBeInTheDocument();
	});

	it('shows "not found" message for unknown plugin', () => {
		render(
			<PluginTabContent
				pluginId="unknown-plugin"
				tabId="main"
				theme={mockTheme}
				plugins={mockPlugins}
			/>
		);

		expect(screen.getByText('Plugin not found: unknown-plugin')).toBeInTheDocument();
	});

	it('sets data attributes on wrapper', () => {
		const { container } = render(
			<PluginTabContent
				pluginId="ui-plugin"
				tabId="dashboard"
				theme={mockTheme}
				plugins={mockPlugins}
			/>
		);

		const wrapper = container.querySelector('[data-plugin-id="ui-plugin"]');
		expect(wrapper).toBeTruthy();
		expect(wrapper?.getAttribute('data-tab-id')).toBe('dashboard');
	});

	it('iframe does not have allow-same-origin in sandbox', () => {
		const { container } = render(
			<PluginTabContent
				pluginId="ui-plugin"
				tabId="main"
				theme={mockTheme}
				plugins={mockPlugins}
			/>
		);

		const iframe = container.querySelector('iframe');
		expect(iframe?.getAttribute('sandbox')).not.toContain('allow-same-origin');
	});
});
