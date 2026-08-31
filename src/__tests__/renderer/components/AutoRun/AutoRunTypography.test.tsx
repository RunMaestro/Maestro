import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { AutoRun } from '../../../../renderer/components/AutoRun';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { mockTheme } from '../../../helpers/mockTheme';

/**
 * Auto Run is a markdown document viewer and editor, so its two panes ride the
 * File Preview and File Editor surfaces rather than carrying fonts of their own.
 *
 * The bug this covers: the preview pinned `fontSize: '13px'` and inherited
 * whatever family happened to reach it. Once the interface could be
 * proportional, 13px of a proportional face read visibly smaller than the 13px
 * of monospace the number was chosen for, so the panel looked shrunken next to
 * everything around it.
 */
vi.mock('../../../../renderer/components/MermaidRenderer', () => ({
	MermaidRenderer: () => <div data-testid="mermaid" />,
}));

const baseProps = (overrides: Record<string, unknown> = {}) => ({
	theme: mockTheme,
	sessionId: 'session-1',
	folderPath: '/test/folder',
	selectedFile: 'doc',
	documentList: ['doc'],
	content: '# Heading\n\nSome prose.',
	onContentChange: vi.fn(),
	mode: 'preview' as const,
	onModeChange: vi.fn(),
	onOpenSetup: vi.fn(),
	onRefresh: vi.fn(),
	onSelectDocument: vi.fn(),
	onCreateDocument: vi.fn().mockResolvedValue(true),
	...overrides,
});

const renderAutoRun = (overrides: Record<string, unknown> = {}) =>
	render(
		<LayerStackProvider>
			<AutoRun {...(baseProps(overrides) as any)} />
		</LayerStackProvider>
	);

beforeEach(() => {
	(window as any).maestro = {
		fs: { readFile: vi.fn().mockResolvedValue(''), readDir: vi.fn().mockResolvedValue([]) },
		autorun: {
			listImages: vi.fn().mockResolvedValue({ success: true, images: [] }),
			writeDoc: vi.fn().mockResolvedValue(undefined),
		},
		settings: { get: vi.fn().mockResolvedValue(null), set: vi.fn().mockResolvedValue(undefined) },
	};
	useSettingsStore.setState({
		fontFamily: 'Inter',
		filePreviewFontFamily: '',
		fileEditorFontFamily: '',
		filePreviewFontSize: 0,
		fileEditorFontSize: 0,
		fontSize: 15,
		fontZoom: 1,
	});
});

describe('Auto Run preview typography', () => {
	function previewPane(container: HTMLElement): HTMLElement {
		return container.querySelector('.prose') as HTMLElement;
	}

	it('follows the File Preview font', () => {
		useSettingsStore.setState({ filePreviewFontFamily: 'Georgia' });
		const { container } = renderAutoRun();

		expect(previewPane(container).style.fontFamily).toContain('Georgia');
	});

	it('follows the File Preview size instead of a hard-coded 13px', () => {
		useSettingsStore.setState({ filePreviewFontSize: 18 });
		const { container } = renderAutoRun();

		expect(previewPane(container).style.fontSize).toBe('18px');
	});

	it('inherits the interface font when File Preview is unset', () => {
		const { container } = renderAutoRun();

		const pane = previewPane(container);
		expect(pane.style.fontFamily).toContain('Inter');
		expect(pane.style.fontSize).toBe('15px');
	});

	it('scales with the global zoom', () => {
		// The pane sets an explicit size, so it would otherwise ignore zoom
		// entirely while everything around it grew.
		useSettingsStore.setState({ filePreviewFontSize: 16, fontZoom: 1.5 });
		const { container } = renderAutoRun();

		expect(previewPane(container).style.fontSize).toBe('24px');
	});
});

describe('Auto Run editor typography', () => {
	function editorTextarea(container: HTMLElement): HTMLTextAreaElement {
		return container.querySelector('textarea') as HTMLTextAreaElement;
	}

	it('follows the File Editor font', () => {
		useSettingsStore.setState({ fileEditorFontFamily: 'Fira Code' });
		const { container } = renderAutoRun({ mode: 'edit' });

		expect(editorTextarea(container).style.fontFamily).toContain('Fira Code');
	});

	it('follows the File Editor size', () => {
		useSettingsStore.setState({ fileEditorFontSize: 12 });
		const { container } = renderAutoRun({ mode: 'edit' });

		expect(editorTextarea(container).style.fontSize).toBe('12px');
	});

	it('is independent of the preview surface', () => {
		// Reading and editing are different jobs and different settings; a shared
		// value here would silently re-couple them.
		useSettingsStore.setState({
			filePreviewFontFamily: 'Georgia',
			fileEditorFontFamily: 'Fira Code',
		});
		const { container } = renderAutoRun({ mode: 'edit' });

		expect(editorTextarea(container).style.fontFamily).toContain('Fira Code');
		expect(editorTextarea(container).style.fontFamily).not.toContain('Georgia');
	});
});
