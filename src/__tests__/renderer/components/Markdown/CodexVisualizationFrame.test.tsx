/**
 * The frame runs agent-authored HTML, so the cases that matter are the ones
 * where it could do more than draw itself: it must stay sandboxed, it must
 * fall back to the file chip whenever main could not build it, and its bridge
 * may only resize the frame, never send a prompt on its own.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { CodexVisualizationFrame } from '../../../../renderer/components/Markdown/components/CodexVisualizationFrame';
import { createMarkdownLink } from '../../../../renderer/components/Markdown/components/MarkdownLink';
import { CODEX_FOLLOWUP_EVENT } from '../../../../renderer/services/codexFollowup';
import { mockTheme } from '../../../helpers/mockTheme';
import type { CodexVisualizationLoadResult } from '../../../../shared/codexVisualization';

const PATH = '/Users/p/designs/dropdown-hints.html';
const load = vi.fn<(request: unknown) => Promise<CodexVisualizationLoadResult>>();

function renderFrame() {
	const Link = createMarkdownLink({
		theme: mockTheme,
		linkColor: 'accentText',
		onFileClick: vi.fn(),
		behavior: { directExternal: true },
	});
	return render(
		<CodexVisualizationFrame
			path={PATH}
			theme={mockTheme}
			LinkComponent={Link}
			conversation={{ sessionId: 'agent-1', tabId: 'tab-1' }}
		/>
	);
}

beforeEach(() => {
	load.mockReset();
	(window as unknown as { maestro: Record<string, unknown> }).maestro = {
		...(window as unknown as { maestro?: Record<string, unknown> }).maestro,
		codexVisualization: { load },
	};
});

describe('CodexVisualizationFrame', () => {
	it('falls back to the file chip when main cannot build the frame', async () => {
		load.mockResolvedValue({ ok: false, reason: 'remote', message: 'SSH agent' });
		renderFrame();
		await waitFor(() =>
			expect(screen.getByTestId('codex-visualization')).toHaveAttribute(
				'data-visualization-state',
				'unavailable'
			)
		);
		expect(screen.getByTestId('codex-visualization')).toHaveAttribute('title', 'SSH agent');
		expect(screen.getByTestId('codex-file-citation')).toBeInTheDocument();
		expect(document.querySelector('iframe')).toBeNull();
		expect(load).toHaveBeenCalledWith({ sessionId: 'agent-1', path: PATH, title: undefined });
	});

	it('frames the registered document sandboxed, under the visualization surface', async () => {
		load.mockResolvedValue({ ok: true, id: 'abc', revision: 7 });
		renderFrame();
		const frame = await waitFor(() => {
			const el = document.querySelector('iframe');
			expect(el).not.toBeNull();
			return el!;
		});
		expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
		expect(frame.getAttribute('src')).toContain('surface=visualization');
		expect(frame.getAttribute('src')).toContain('id=abc');
		expect(screen.getByTestId('codex-file-citation')).toBeInTheDocument();
	});

	it('resizes on a height message and never sends a follow-up without a click', async () => {
		load.mockResolvedValue({ ok: true, id: 'abc', revision: 1 });
		renderFrame();
		const frame = await waitFor(() => {
			const el = document.querySelector('iframe');
			expect(el).not.toBeNull();
			return el!;
		});

		const posted: MessagePort[] = [];
		Object.defineProperty(frame, 'contentWindow', {
			value: {
				postMessage: (_m: unknown, _o: string, ports: MessagePort[]) => posted.push(...ports),
			},
		});
		fireEvent.load(frame);
		expect(posted).toHaveLength(1);

		const followups = vi.fn();
		window.addEventListener(CODEX_FOLLOWUP_EVENT, followups);
		posted[0].postMessage({ type: 'follow-up', prompt: 'rm -rf' });
		posted[0].postMessage({ type: 'height', height: 512 });
		posted[0].start();
		await waitFor(() => expect(frame.style.height).toBe('512px'));
		expect(followups).not.toHaveBeenCalled();
		window.removeEventListener(CODEX_FOLLOWUP_EVENT, followups);
	});
});
