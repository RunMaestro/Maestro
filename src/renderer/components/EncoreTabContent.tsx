/**
 * EncoreTabContent - Renders encore UI within the Right Panel.
 *
 * Uses an iframe to load the encore's renderer entry point, providing natural
 * sandboxing for untrusted UI code. The iframe uses sandbox="allow-scripts"
 * without allow-same-origin to prevent the encore from accessing the parent
 * frame's DOM or IPC bridge.
 */

import type { Theme } from '../types';
import type { LoadedEncore } from '../../shared/encore-types';
import { Puzzle } from 'lucide-react';

interface EncoreTabContentProps {
	encoreId: string;
	tabId: string;
	theme: Theme;
	encores: LoadedEncore[];
}

export function EncoreTabContent({ encoreId, tabId, theme, encores }: EncoreTabContentProps) {
	const encore = encores.find((p) => p.manifest.id === encoreId);

	if (!encore) {
		return (
			<div
				className="flex flex-col items-center justify-center h-full gap-2 text-center p-4"
				style={{ color: theme.colors.textDim }}
			>
				<Puzzle className="w-8 h-8 opacity-50" />
				<span className="text-sm">Encore not found: {encoreId}</span>
			</div>
		);
	}

	const rendererEntry = encore.manifest.renderer;

	if (!rendererEntry) {
		return (
			<div
				className="flex flex-col items-center justify-center h-full gap-2 text-center p-4"
				style={{ color: theme.colors.textDim }}
			>
				<Puzzle className="w-8 h-8 opacity-50" />
				<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
					{encore.manifest.name}
				</span>
				<span className="text-xs">This encore has no UI</span>
			</div>
		);
	}

	const iframeSrc = `file://${encore.path}/${rendererEntry}`;

	return (
		<div className="h-full w-full" data-encore-id={encoreId} data-tab-id={tabId}>
			{/* iframe provides natural sandboxing for untrusted encore UI code.
			    sandbox="allow-scripts" lets JS run but without allow-same-origin
			    the encore cannot access the parent frame's DOM or IPC bridge. */}
			<iframe
				src={iframeSrc}
				sandbox="allow-scripts"
				className="w-full h-full border-0"
				style={{
					backgroundColor: theme.colors.bgMain,
					borderTop: `1px solid ${theme.colors.border}`,
				}}
				title={`Encore: ${encore.manifest.name} - ${tabId}`}
			/>
		</div>
	);
}
