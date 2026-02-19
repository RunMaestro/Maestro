/**
 * PluginTabContent - Renders plugin UI within the Right Panel.
 *
 * Uses an iframe to load the plugin's renderer entry point, providing natural
 * sandboxing for untrusted UI code. The iframe uses sandbox="allow-scripts"
 * without allow-same-origin to prevent the plugin from accessing the parent
 * frame's DOM or IPC bridge.
 */

import type { Theme } from '../types';
import type { LoadedPlugin } from '../../shared/plugin-types';
import { Puzzle } from 'lucide-react';

interface PluginTabContentProps {
	pluginId: string;
	tabId: string;
	theme: Theme;
	plugins: LoadedPlugin[];
}

export function PluginTabContent({ pluginId, tabId, theme, plugins }: PluginTabContentProps) {
	const plugin = plugins.find((p) => p.manifest.id === pluginId);

	if (!plugin) {
		return (
			<div
				className="flex flex-col items-center justify-center h-full gap-2 text-center p-4"
				style={{ color: theme.colors.textDim }}
			>
				<Puzzle className="w-8 h-8 opacity-50" />
				<span className="text-sm">Plugin not found: {pluginId}</span>
			</div>
		);
	}

	const rendererEntry = plugin.manifest.renderer;

	if (!rendererEntry) {
		return (
			<div
				className="flex flex-col items-center justify-center h-full gap-2 text-center p-4"
				style={{ color: theme.colors.textDim }}
			>
				<Puzzle className="w-8 h-8 opacity-50" />
				<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					{plugin.manifest.name}
				</span>
				<span className="text-xs">This plugin has no UI</span>
			</div>
		);
	}

	const iframeSrc = `file://${plugin.path}/${rendererEntry}`;

	return (
		<div className="h-full w-full" data-plugin-id={pluginId} data-tab-id={tabId}>
			{/* iframe provides natural sandboxing for untrusted plugin UI code.
			    sandbox="allow-scripts" lets JS run but without allow-same-origin
			    the plugin cannot access the parent frame's DOM or IPC bridge. */}
			<iframe
				src={iframeSrc}
				sandbox="allow-scripts"
				className="w-full h-full border-0"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderTop: `1px solid ${theme.colors.border}`,
				}}
				title={`Plugin: ${plugin.manifest.name} - ${tabId}`}
			/>
		</div>
	);
}
