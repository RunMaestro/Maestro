import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

const { mockSafeClipboardWrite } = vi.hoisted(() => ({ mockSafeClipboardWrite: vi.fn() }));

vi.mock('../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: (...args: unknown[]) => mockSafeClipboardWrite(...args),
}));
vi.mock('../../../renderer/utils/openUrl', () => ({
	openInMaestroBrowser: vi.fn(),
	openInSystemBrowser: vi.fn(),
}));

import { LinkContextMenu } from '../../../renderer/components/LinkContextMenu';
import { openInMaestroBrowser, openInSystemBrowser } from '../../../renderer/utils/openUrl';
import type { Theme } from '../../../renderer/types';

const theme = {
	colors: { bgSidebar: '#111', border: '#222', textMain: '#eee' },
} as unknown as Theme;

function renderMenu(url: string) {
	const onDismiss = vi.fn();
	const utils = render(
		<LinkContextMenu menu={{ x: 10, y: 10, url }} theme={theme} onDismiss={onDismiss} />
	);
	return { ...utils, onDismiss };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('LinkContextMenu', () => {
	it('copies a routing-hinted link without its hint', () => {
		const { getByText } = renderMenu('maestro+http://localhost:5173/x');
		fireEvent.click(getByText('Copy Link'));
		expect(mockSafeClipboardWrite).toHaveBeenCalledWith('http://localhost:5173/x');
	});

	it('copies a plain link unchanged', () => {
		const { getByText } = renderMenu('https://example.com');
		fireEvent.click(getByText('Copy Link'));
		expect(mockSafeClipboardWrite).toHaveBeenCalledWith('https://example.com');
	});

	it('treats a hinted link as openable from either menu item', () => {
		const { getByText } = renderMenu('system+https://example.com');
		fireEvent.click(getByText('Open in Maestro Browser'));
		expect(openInMaestroBrowser).toHaveBeenCalledWith('system+https://example.com');
	});

	it('does not open a hint in front of a non-http scheme', () => {
		const { getByText } = renderMenu('maestro+file:///tmp/x');
		fireEvent.click(getByText('Open in System Browser'));
		expect(openInSystemBrowser).not.toHaveBeenCalled();
	});
});
