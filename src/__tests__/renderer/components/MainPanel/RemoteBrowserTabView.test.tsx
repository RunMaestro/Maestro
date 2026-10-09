import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RemoteBrowserTabView } from '../../../../renderer/components/MainPanel/RemoteBrowserTabView';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { BrowserTab } from '../../../../shared/browserPage';
import type { BrowserRelayInput } from '../../../../shared/browserRelay';
import { createMockSession } from '../../../helpers/mockSession';
import { mockTheme } from '../../../helpers/mockTheme';

const tab: BrowserTab = {
	id: 'browser-1',
	url: 'https://example.test',
	title: 'Example',
	createdAt: 0,
	canGoBack: false,
	canGoForward: false,
	isLoading: false,
};

describe('remote browser text input', () => {
	let originalApi: typeof window.maestro.browserSession;
	const relayInput = vi.fn<(id: string, input: BrowserRelayInput) => Promise<void>>();

	beforeEach(() => {
		vi.useFakeTimers();
		relayInput.mockReset().mockResolvedValue(undefined);
		vi.stubGlobal(
			'Image',
			class {
				src = '';
				decode = () => Promise.resolve();
			}
		);
		vi.stubGlobal(
			'ResizeObserver',
			class {
				observe() {}
				disconnect() {}
			}
		);
		originalApi = window.maestro.browserSession;
		window.maestro.browserSession = {
			...originalApi,
			relayOpen: vi.fn().mockResolvedValue('lease-1'),
			relayClose: vi.fn().mockResolvedValue(undefined),
			relayInput,
			relayFrame: vi.fn().mockResolvedValue({
				...tab,
				dataUrl: 'data:image/png;base64,dGVzdA==',
				width: 1024,
				height: 768,
			}),
		};
		useSessionStore.setState({
			sessions: [createMockSession({ id: 'session-1', browserTabs: [tab] })],
		});
	});

	afterEach(() => {
		cleanup();
		window.maestro.browserSession = originalApi;
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it('sends complete Unicode pastes in ordered bounded chunks before subsequent typing', async () => {
		let finishFirst!: () => void;
		relayInput.mockReturnValueOnce(
			new Promise((resolve) => {
				finishFirst = resolve;
			})
		);
		render(<RemoteBrowserTabView tab={tab} theme={mockTheme} onUpdateTab={vi.fn()} />);
		await act(() => vi.advanceTimersByTimeAsync(0));
		const keyboard = screen.getByLabelText('Host browser keyboard input');
		const text = 'a'.repeat(16_383) + '\u{1f600}' + 'b'.repeat(16_384);
		fireEvent.paste(keyboard, { clipboardData: { getData: () => text } });
		fireEvent.change(keyboard, { target: { value: 'next' } });
		await act(() => vi.advanceTimersByTimeAsync(0));
		expect(relayInput).toHaveBeenCalledTimes(1);
		const first = relayInput.mock.calls[0][1];
		expect(first.type === 'text' && first.text.length).toBe(16_383);
		finishFirst();
		await act(() => vi.advanceTimersByTimeAsync(0));
		const texts = relayInput.mock.calls.map(([, input]) =>
			input.type === 'text' ? input.text : ''
		);
		expect(texts.map((value) => value.length)).toEqual([16_383, 16_384, 2, 4]);
		expect(texts.slice(0, -1).join('') === text).toBe(true);
		expect(texts[1].startsWith('\u{1f600}')).toBe(true);
		expect(texts[texts.length - 1]).toBe('next');
	});

	it('stops an in-flight paste when its presentation is unmounted', async () => {
		let finishFirst!: () => void;
		relayInput.mockReturnValueOnce(
			new Promise((resolve) => {
				finishFirst = resolve;
			})
		);
		const { unmount } = render(
			<RemoteBrowserTabView tab={tab} theme={mockTheme} onUpdateTab={vi.fn()} />
		);
		await act(() => vi.advanceTimersByTimeAsync(0));
		fireEvent.paste(screen.getByLabelText('Host browser keyboard input'), {
			clipboardData: { getData: () => 'a'.repeat(32_768) },
		});
		await act(() => vi.advanceTimersByTimeAsync(0));
		expect(relayInput).toHaveBeenCalledTimes(1);
		unmount();
		finishFirst();
		await act(() => vi.advanceTimersByTimeAsync(0));
		expect(relayInput).toHaveBeenCalledTimes(1);
	});
});
