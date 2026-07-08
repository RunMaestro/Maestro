import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ResponseViewer, { type ResponseItem } from '../../web/mobile/ResponseViewer';
import { ThemeProvider } from '../../web/components/ThemeProvider';
import type { LastResponsePreview } from '../../web/hooks/useSessions';

function response(overrides: Partial<LastResponsePreview> = {}): LastResponsePreview {
	return {
		text: 'First response preview',
		timestamp: Date.UTC(2026, 0, 2, 15, 30),
		source: 'stdout',
		fullLength: 200,
		...overrides,
	};
}

function responseItem(overrides: Partial<ResponseItem> = {}): ResponseItem {
	return {
		response: response(),
		sessionId: 'session-1',
		sessionName: 'Session One',
		...overrides,
	};
}

function renderViewer(props: React.ComponentProps<typeof ResponseViewer>) {
	return render(
		<ThemeProvider>
			<ResponseViewer {...props} />
		</ThemeProvider>
	);
}

function touch(clientX: number, clientY: number) {
	return { clientX, clientY };
}

describe('ResponseViewer integration', () => {
	let originalOverflow: string;
	let originalClipboard: Clipboard | undefined;
	let originalVibrate: PropertyDescriptor | undefined;
	let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect;
	let vibrateSpy: ReturnType<typeof vi.fn>;
	let writeTextSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		originalOverflow = document.body.style.overflow;
		originalClipboard = navigator.clipboard;
		originalVibrate = Object.getOwnPropertyDescriptor(navigator, 'vibrate');
		originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
		vibrateSpy = vi.fn();
		writeTextSpy = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText: writeTextSpy },
		});
		Object.defineProperty(navigator, 'vibrate', {
			configurable: true,
			value: vibrateSpy,
		});
		Element.prototype.getBoundingClientRect = vi.fn(() => ({
			x: 0,
			y: 0,
			top: 0,
			left: 0,
			right: 300,
			bottom: 400,
			width: 300,
			height: 400,
			toJSON: () => ({}),
		})) as typeof Element.prototype.getBoundingClientRect;
	});

	afterEach(() => {
		document.body.style.overflow = originalOverflow;
		Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
		if (originalClipboard) {
			Object.defineProperty(navigator, 'clipboard', {
				configurable: true,
				value: originalClipboard,
			});
		} else {
			delete (navigator as Partial<Navigator>).clipboard;
		}
		if (originalVibrate) {
			Object.defineProperty(navigator, 'vibrate', originalVibrate);
		} else {
			delete (navigator as Partial<Navigator>).vibrate;
		}
	});

	it('renders null when closed and locks body scroll while open', () => {
		const { container, rerender } = renderViewer({
			isOpen: false,
			response: response(),
			onClose: vi.fn(),
		});
		expect(container.firstChild).toBeNull();

		rerender(
			<ThemeProvider>
				<ResponseViewer isOpen response={response()} onClose={vi.fn()} />
			</ThemeProvider>
		);
		expect(screen.getByRole('dialog', { name: 'Full response viewer' })).toBeInTheDocument();
		expect(document.body.style.overflow).toBe('hidden');

		rerender(
			<ThemeProvider>
				<ResponseViewer isOpen={false} response={response()} onClose={vi.fn()} />
			</ThemeProvider>
		);
		expect(document.body.style.overflow).toBe('');
	});

	it('displays full text, strips ANSI codes, renders code blocks, and copies code', async () => {
		renderViewer({
			isOpen: true,
			response: response({ text: '\u001b[31mpreview\u001b[0m', fullLength: 500 }),
			fullText: 'Plain full text\n\n```ts\nconst value = 1;\n```',
			sessionName: 'Build Session',
			onClose: vi.fn(),
			enableBionifyReadingMode: true,
		});

		expect(screen.getByText('Response')).toBeInTheDocument();
		expect(screen.getByText('Build Session')).toBeInTheDocument();
		expect(screen.getByRole('dialog', { name: 'Full response viewer' })).toHaveTextContent(
			'Plain full text'
		);
		expect(screen.queryByText(/preview/)).not.toBeInTheDocument();
		expect(screen.getByText('typescript')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
		await waitFor(() => expect(writeTextSpy).toHaveBeenCalledWith('const value = 1;'));
		expect(vibrateSpy).toHaveBeenCalled();
	});

	it('shows loading and preview truncation states', () => {
		const { rerender } = renderViewer({
			isOpen: true,
			response: response(),
			isLoading: true,
			onClose: vi.fn(),
		});
		expect(screen.getByText('Loading full response...')).toBeInTheDocument();
		expect(screen.queryByText('First response preview')).not.toBeInTheDocument();

		rerender(
			<ThemeProvider>
				<ResponseViewer isOpen response={response()} onClose={vi.fn()} />
			</ThemeProvider>
		);
		expect(screen.getByText('First response preview')).toBeInTheDocument();
		expect(screen.getByText(/Showing preview/)).toBeInTheDocument();
	});

	it('navigates responses with pagination and keyboard shortcuts, then closes with Escape', () => {
		const onNavigate = vi.fn();
		const onClose = vi.fn();
		renderViewer({
			isOpen: true,
			response: null,
			allResponses: [
				responseItem({ response: response({ text: 'First response', fullLength: 14 }) }),
				responseItem({
					response: response({ text: 'Second response', fullLength: 15 }),
					sessionName: 'Session Two',
				}),
			],
			currentIndex: 0,
			onNavigate,
			onClose,
		});

		expect(screen.getByLabelText('Response 1 of 2')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Go to response 2' }));
		expect(onNavigate).toHaveBeenCalledWith(1);

		fireEvent.keyDown(document, { key: 'ArrowRight' });
		expect(onNavigate).toHaveBeenCalledWith(1);
		fireEvent.keyDown(document, { key: 'ArrowLeft' });
		expect(onNavigate).not.toHaveBeenCalledWith(-1);
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClose).toHaveBeenCalled();
	});

	it('navigates to previous responses with keyboard and swipe gestures', () => {
		const onNavigate = vi.fn();
		renderViewer({
			isOpen: true,
			response: null,
			allResponses: [
				responseItem({ response: response({ text: 'First response', fullLength: 14 }) }),
				responseItem({ response: response({ text: 'Second response', fullLength: 15 }) }),
			],
			currentIndex: 1,
			onNavigate,
			onClose: vi.fn(),
		});
		const dialog = screen.getByRole('dialog', { name: 'Full response viewer' });

		fireEvent.keyDown(document, { key: 'ArrowLeft' });
		expect(onNavigate).toHaveBeenCalledWith(0);

		fireEvent.touchStart(dialog, { touches: [touch(80, 30)] });
		fireEvent.touchMove(dialog, { touches: [touch(110, 30)], preventDefault: vi.fn() });
		fireEvent.touchMove(dialog, { touches: [touch(180, 30)], preventDefault: vi.fn() });
		fireEvent.touchEnd(dialog);

		expect(onNavigate).toHaveBeenCalledWith(0);
		expect(vibrateSpy).toHaveBeenCalled();
	});

	it('applies edge resistance for blocked horizontal swipes', () => {
		const onNavigate = vi.fn();
		const { rerender } = renderViewer({
			isOpen: true,
			response: null,
			allResponses: [
				responseItem({ response: response({ text: 'First response', fullLength: 14 }) }),
				responseItem({ response: response({ text: 'Second response', fullLength: 15 }) }),
			],
			currentIndex: 0,
			onNavigate,
			onClose: vi.fn(),
		});
		const dialog = screen.getByRole('dialog', { name: 'Full response viewer' });

		fireEvent.touchStart(dialog, { touches: [touch(80, 30)] });
		fireEvent.touchMove(dialog, { touches: [touch(110, 30)], preventDefault: vi.fn() });
		fireEvent.touchMove(dialog, { touches: [touch(190, 30)], preventDefault: vi.fn() });
		expect(dialog).toHaveStyle({ transform: 'translate(50px, 0px)' });
		fireEvent.touchEnd(dialog);
		expect(onNavigate).not.toHaveBeenCalledWith(-1);

		rerender(
			<ThemeProvider>
				<ResponseViewer
					isOpen
					response={null}
					allResponses={[
						responseItem({ response: response({ text: 'First response', fullLength: 14 }) }),
						responseItem({ response: response({ text: 'Second response', fullLength: 15 }) }),
					]}
					currentIndex={1}
					onNavigate={onNavigate}
					onClose={vi.fn()}
				/>
			</ThemeProvider>
		);

		fireEvent.touchStart(dialog, { touches: [touch(220, 30)] });
		fireEvent.touchMove(dialog, { touches: [touch(190, 30)], preventDefault: vi.fn() });
		fireEvent.touchMove(dialog, { touches: [touch(90, 30)], preventDefault: vi.fn() });
		expect(dialog).toHaveStyle({ transform: 'translate(-50px, 0px)' });
		fireEvent.touchEnd(dialog);
		expect(onNavigate).not.toHaveBeenCalledWith(2);
	});

	it('responds to swipe navigation, swipe dismiss, pinch zoom, and reset zoom', async () => {
		const onNavigate = vi.fn();
		const onClose = vi.fn();
		renderViewer({
			isOpen: true,
			response: null,
			allResponses: [
				responseItem({ response: response({ text: 'First response', fullLength: 14 }) }),
				responseItem({ response: response({ text: 'Second response', fullLength: 15 }) }),
			],
			currentIndex: 0,
			onNavigate,
			onClose,
		});
		const dialog = screen.getByRole('dialog', { name: 'Full response viewer' });

		fireEvent.touchStart(dialog, { touches: [touch(220, 30)] });
		fireEvent.touchMove(dialog, { touches: [touch(190, 30)], preventDefault: vi.fn() });
		fireEvent.touchMove(dialog, { touches: [touch(90, 30)], preventDefault: vi.fn() });
		fireEvent.touchEnd(dialog);
		expect(onNavigate).toHaveBeenCalledWith(1);

		fireEvent.touchStart(dialog, { touches: [touch(30, 20)] });
		fireEvent.touchMove(dialog, { touches: [touch(30, 60)], preventDefault: vi.fn() });
		fireEvent.touchMove(dialog, { touches: [touch(30, 160)], preventDefault: vi.fn() });
		fireEvent.touchEnd(dialog);
		expect(onClose).toHaveBeenCalled();

		fireEvent.touchStart(dialog, { touches: [touch(0, 0), touch(100, 0)] });
		fireEvent.touchMove(dialog, {
			touches: [touch(0, 0), touch(240, 0)],
			preventDefault: vi.fn(),
		});
		fireEvent.touchEnd(dialog);

		const reset = await screen.findByRole('button', { name: 'Reset zoom' });
		expect(reset).toHaveTextContent('240%');
		fireEvent.click(reset);
		await waitFor(() => expect(screen.queryByRole('button', { name: 'Reset zoom' })).toBeNull());
	});

	it('ignores touch moves without a start and one-finger moves during pinch', async () => {
		renderViewer({
			isOpen: true,
			response: response(),
			onClose: vi.fn(),
		});
		const dialog = screen.getByRole('dialog', { name: 'Full response viewer' });

		fireEvent.touchMove(dialog, { touches: [touch(20, 20)], preventDefault: vi.fn() });
		expect(dialog).toHaveStyle({ transform: 'translate(0px, 0px)' });

		fireEvent.touchStart(dialog, { touches: [touch(0, 0), touch(100, 0)] });
		fireEvent.touchMove(dialog, { touches: [touch(80, 0)], preventDefault: vi.fn() });
		fireEvent.touchEnd(dialog);

		expect(screen.queryByRole('button', { name: 'Reset zoom' })).toBeNull();
	});

	it('ignores tiny movement and vertical swipes while zoomed', async () => {
		const dateNow = vi.spyOn(Date, 'now');
		renderViewer({
			isOpen: true,
			response: response(),
			onClose: vi.fn(),
		});
		const dialog = screen.getByRole('dialog', { name: 'Full response viewer' });
		const content = screen.getByText('First response preview');

		fireEvent.touchStart(dialog, { touches: [touch(50, 50)] });
		fireEvent.touchMove(dialog, { touches: [touch(55, 55)], preventDefault: vi.fn() });
		fireEvent.touchEnd(dialog);
		expect(dialog).toHaveStyle({ transform: 'translate(0px, 0px)' });

		const contentArea = Array.from(dialog.querySelectorAll('div')).find(
			(element) => element.style.overflow === 'auto'
		) as HTMLDivElement;
		Object.defineProperty(contentArea, 'scrollTop', {
			configurable: true,
			value: 24,
		});
		fireEvent.touchStart(dialog, { touches: [touch(50, 50)] });
		fireEvent.touchMove(dialog, { touches: [touch(50, 140)], preventDefault: vi.fn() });
		fireEvent.touchEnd(dialog);
		expect(dialog).toHaveStyle({ transform: 'translate(0px, 0px)' });

		dateNow.mockReturnValue(1_000);
		fireEvent.touchStart(content, { touches: [touch(150, 200)] });
		dateNow.mockReturnValue(1_200);
		fireEvent.touchStart(content, { touches: [touch(150, 200)] });
		await screen.findByRole('button', { name: 'Reset zoom' });

		fireEvent.touchStart(dialog, { touches: [touch(50, 50)] });
		fireEvent.touchMove(dialog, { touches: [touch(50, 140)], preventDefault: vi.fn() });
		fireEvent.touchEnd(dialog);
		expect(screen.getByRole('button', { name: 'Reset zoom' })).toBeInTheDocument();
	});

	it('ignores pinch starts while loading before zoomable content is mounted', () => {
		renderViewer({
			isOpen: true,
			response: response(),
			isLoading: true,
			onClose: vi.fn(),
		});
		const dialog = screen.getByRole('dialog', { name: 'Full response viewer' });

		fireEvent.touchStart(dialog, { touches: [touch(0, 0), touch(100, 0)] });
		fireEvent.touchMove(dialog, {
			touches: [touch(0, 0), touch(240, 0)],
			preventDefault: vi.fn(),
		});
		fireEvent.touchEnd(dialog);

		expect(screen.queryByRole('button', { name: 'Reset zoom' })).toBeNull();
	});

	it('double taps content to zoom in and reset zoom', async () => {
		const dateNow = vi.spyOn(Date, 'now');
		renderViewer({
			isOpen: true,
			response: response(),
			onClose: vi.fn(),
		});
		const content = screen.getByText('First response preview');

		dateNow.mockReturnValue(1_000);
		fireEvent.touchStart(content, { touches: [touch(150, 200)] });
		dateNow.mockReturnValue(1_200);
		fireEvent.touchStart(content, { touches: [touch(150, 200)] });

		const reset = await screen.findByRole('button', { name: 'Reset zoom' });
		expect(reset).toHaveTextContent('200%');

		dateNow.mockReturnValue(2_000);
		fireEvent.touchStart(content, { touches: [touch(150, 200)] });
		dateNow.mockReturnValue(2_200);
		fireEvent.touchStart(content, { touches: [touch(150, 200)] });

		await waitFor(() => expect(screen.queryByRole('button', { name: 'Reset zoom' })).toBeNull());
		expect(vibrateSpy).toHaveBeenCalled();
	});

	it('ignores multi-touch starts for double-tap detection', () => {
		const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000);
		renderViewer({
			isOpen: true,
			response: response(),
			onClose: vi.fn(),
		});
		const content = screen.getByText('First response preview');

		fireEvent.touchStart(content, { touches: [touch(10, 10), touch(20, 20)] });
		dateNow.mockReturnValue(1_100);
		fireEvent.touchStart(content, { touches: [touch(10, 10), touch(20, 20)] });

		expect(screen.queryByRole('button', { name: 'Reset zoom' })).toBeNull();
	});

	it('falls back to the response prop when the active response item is empty', () => {
		renderViewer({
			isOpen: true,
			response: response({ text: 'Fallback response text', fullLength: 22 }),
			allResponses: [responseItem({ response: null as unknown as LastResponsePreview })],
			currentIndex: 0,
			onClose: vi.fn(),
		});

		expect(screen.getByText('Fallback response text')).toBeInTheDocument();
	});

	it('closes from the header close button with haptic feedback', () => {
		const onClose = vi.fn();
		renderViewer({
			isOpen: true,
			response: response(),
			onClose,
		});

		fireEvent.click(screen.getByRole('button', { name: 'Close response viewer' }));

		expect(vibrateSpy).toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});
});
