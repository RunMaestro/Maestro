import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

vi.mock('../../../renderer/utils/openUrl', () => ({
	openUrl: vi.fn(),
}));

import { openUrl } from '../../../renderer/utils/openUrl';
import { linkifyNode } from '../../../renderer/utils/linkify';
import type { Theme } from '../../../renderer/types';

const theme = { colors: { accentText: '#88aaff' } } as unknown as Theme;

function renderText(text: string) {
	return render(<div>{linkifyNode(text, theme)}</div>);
}

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = { ...(window as any).maestro, shell: { openExternal: vi.fn() } };
});

describe('linkifyNode', () => {
	it('opens a clicked URL through openUrl, not straight to the shell', () => {
		const { getByText } = renderText('see https://example.com/a.');
		fireEvent.click(getByText('https://example.com/a'));
		expect(openUrl).toHaveBeenCalledWith('https://example.com/a', { ctrlKey: false });
		expect((window as any).maestro.shell.openExternal).not.toHaveBeenCalled();
	});

	it('passes Cmd-click through as the inversion modifier', () => {
		const { getByText } = renderText('https://example.com');
		fireEvent.click(getByText('https://example.com'), { metaKey: true });
		expect(openUrl).toHaveBeenCalledWith('https://example.com', { ctrlKey: true });
	});

	it('links a routing-hinted URL as one link, hint included', () => {
		const { getByText } = renderText('preview at maestro+http://localhost:5173 now');
		fireEvent.click(getByText('maestro+http://localhost:5173'));
		expect(openUrl).toHaveBeenCalledWith('maestro+http://localhost:5173', { ctrlKey: false });
	});
});
