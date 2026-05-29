import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { FilePreview } from '../../renderer/components/FilePreview';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import { getEncoder } from '../../renderer/utils/tokenCounter';

const visitMocks = vi.hoisted(() => ({
	visit: vi.fn((_tree: unknown, _type: string, visitor: any) => {
		visitor({ value: '==orphaned highlight==' }, undefined, undefined);
	}),
}));

vi.mock('unist-util-visit', () => visitMocks);

vi.mock('../../renderer/utils/tokenCounter', () => ({
	getEncoder: vi.fn(),
	formatTokenCount: vi.fn((count: number) => `${count} tokens`),
}));

vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => (
		<pre data-testid="syntax-highlighter">{children}</pre>
	),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
	vs: {},
}));

vi.mock('../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: ({ chart }: { chart: string }) => (
		<div data-testid="mermaid-renderer">{chart}</div>
	),
}));

const theme = {
	mode: 'dark',
	colors: {
		bgMain: '#101114',
		bgActivity: '#181b20',
		bgSidebar: '#20242b',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		border: '#3f3f46',
		accent: '#4f8cff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

describe('FilePreview remark highlight defensive integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(getEncoder).mockResolvedValue({
			encode: vi.fn(() => [1, 2, 3]),
		} as any);
		vi.mocked(window.maestro.fs.stat).mockResolvedValue({
			size: 128,
			createdAt: '2026-05-01T10:00:00.000Z',
			modifiedAt: '2026-05-02T11:30:00.000Z',
		});
		useSettingsStore.setState({
			bionifyReadingMode: false,
			bionifyIntensity: 1,
			bionifyAlgorithm: '- 0 1 1 2 0.4',
			spellCheck: false,
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('ignores highlighted text visitor callbacks that do not include a parent node', async () => {
		render(
			<LayerStackProvider>
				<FilePreview
					file={{
						name: 'defensive.md',
						path: '/repo/docs/defensive.md',
						content: '==visible highlight==',
					}}
					onClose={vi.fn()}
					theme={theme}
					markdownEditMode={false}
					setMarkdownEditMode={vi.fn()}
					shortcuts={{ toggleMarkdownMode: { keys: ['Meta', 'e'] } }}
					isTabMode
				/>
			</LayerStackProvider>
		);

		await waitFor(() => expect(visitMocks.visit).toHaveBeenCalled());
		expect(screen.getByText('defensive.md')).toBeInTheDocument();
	});
});
