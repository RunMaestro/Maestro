import React, { useState } from 'react';
import { act, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ChatComposer,
	GROUP_CHAT_COMPOSER_CAPABILITIES,
	type ChatComposerProps,
} from '../../../../renderer/components/ChatComposer';
import { usePhoneLayout } from '../../../../renderer/hooks/ui/useViewportBreakpoint';
import { useQuitWhenIdleStore } from '../../../../renderer/stores/quitWhenIdleStore';
import { useImageAnnotatorStore } from '../../../../renderer/components/ImageAnnotator/imageAnnotatorStore';
import { createMockTheme } from '../../../helpers/mockTheme';
import { createMockSession } from '../../../helpers/mockSession';

vi.mock('../../../../renderer/hooks/ui/useViewportBreakpoint', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/hooks/ui/useViewportBreakpoint')>()),
	usePhoneLayout: vi.fn(() => false),
}));

const mockedUsePhoneLayout = vi.mocked(usePhoneLayout);
const theme = createMockTheme();

function createMinimalProps(overrides: Partial<ChatComposerProps> = {}): ChatComposerProps {
	return {
		theme,
		value: '',
		onChange: vi.fn(),
		capabilities: GROUP_CHAT_COMPOSER_CAPABILITIES,
		placeholder: 'Type a message...',
		phoneFoldStorageKey: 'test.composer.collapsed',
		...overrides,
	};
}

function ControlledComposer(props: Partial<ChatComposerProps>) {
	const [val, setVal] = useState(props.value ?? '');
	return (
		<ChatComposer
			{...createMinimalProps({
				...props,
				value: val,
				onChange: (next) => {
					setVal(next);
					props.onChange?.(next);
				},
			})}
		/>
	);
}

function StatefulImagesComposer({
	value: initialValue,
	images: initialImages,
}: {
	value: string;
	images: string[];
}) {
	const [value, setValue] = useState(initialValue);
	const [images, setImages] = useState(initialImages);
	return (
		<ChatComposer
			{...createMinimalProps({
				value,
				onChange: setValue,
				stagedImages: images,
				setStagedImages: setImages,
			})}
		/>
	);
}

function makeStagedImageDataTransfer() {
	const store: Record<string, string> = {};
	return {
		types: [] as string[],
		effectAllowed: '',
		dropEffect: '',
		setData(type: string, value: string) {
			store[type] = value;
			if (!this.types.includes(type)) this.types.push(type);
		},
		getData(type: string) {
			return store[type] ?? '';
		},
	};
}

function stubStagedTileLayout(tiles: HTMLElement[]) {
	const rects = new Map(tiles.map((tile, i) => [tile, { left: i * 100, width: 100 }]));
	vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
		const r = rects.get(this as HTMLElement) ?? { left: 0, width: 0 };
		return {
			...r,
			right: r.left + r.width,
			top: 0,
			bottom: 64,
			height: 64,
			x: r.left,
			y: 0,
			toJSON: () => ({}),
		} as DOMRect;
	});
}

function fireStagedDrag(
	kind: 'dragOver' | 'drop',
	target: HTMLElement,
	dataTransfer: unknown,
	clientX: number
) {
	const event = createEvent[kind](target, { dataTransfer });
	Object.defineProperty(event, 'clientX', { value: clientX });
	fireEvent(target, event);
}

describe('ChatComposer', () => {
	beforeEach(() => {
		mockedUsePhoneLayout.mockReturnValue(false);
		window.localStorage?.removeItem('test.composer.collapsed');
		useQuitWhenIdleStore.setState({ armed: false });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('desktop layout', () => {
		it('renders no phone fold handle on desktop', () => {
			render(<ChatComposer {...createMinimalProps()} />);
			expect(screen.queryByTestId('phone-composer-handle')).not.toBeInTheDocument();
			expect(screen.getByRole('textbox')).toBeInTheDocument();
		});

		it('renders the send column beside the composer on desktop', () => {
			render(<ChatComposer {...createMinimalProps()} />);
			expect(screen.getByTitle('Notification Settings')).toBeInTheDocument();
			expect(screen.getByTitle('Send message')).toBeInTheDocument();
		});

		it('renders aboveComposer and slots in the correct layout order', () => {
			const { container } = render(
				<ChatComposer
					{...createMinimalProps({
						aboveComposer: <div data-testid="test-above-composer">Above Content</div>,
						toolbarExtras: <button type="button">Extras Button</button>,
					})}
				/>
			);

			const aboveEl = screen.getByTestId('test-above-composer');
			expect(aboveEl).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Extras Button' })).toBeInTheDocument();

			// Layout check: container has aboveComposer followed by the composer flex row
			const root = container.firstChild as HTMLElement;
			expect(root).toBeInTheDocument();
			expect(aboveEl.compareDocumentPosition(screen.getByRole('textbox'))).toBe(
				Node.DOCUMENT_POSITION_FOLLOWING
			);
		});

		it('shows the quit-when-idle indicator when armed', () => {
			useQuitWhenIdleStore.setState({ armed: true });
			render(<ChatComposer {...createMinimalProps()} />);
			expect(screen.getByText('Quitting When All Operations Finish')).toBeInTheDocument();
		});
	});

	describe('phone layout', () => {
		beforeEach(() => {
			mockedUsePhoneLayout.mockReturnValue(true);
		});

		it('starts folded by default and displays only the handle', () => {
			render(
				<ChatComposer
					{...createMinimalProps({
						aboveComposer: <div data-testid="above-content" />,
					})}
				/>
			);

			const handle = screen.getByTestId('phone-composer-handle');
			expect(handle).toBeInTheDocument();
			expect(handle).toHaveAttribute('aria-expanded', 'false');
			expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
			expect(screen.queryByTestId('above-content')).not.toBeInTheDocument();
		});

		it('shows busy dot and draft indicator on the folded handle', () => {
			render(
				<ChatComposer
					{...createMinimalProps({
						isBusy: true,
						value: 'draft text',
					})}
				/>
			);

			expect(screen.getByTestId('phone-composer-handle-busy')).toBeInTheDocument();
			expect(screen.getByTestId('phone-composer-handle-draft')).toBeInTheDocument();
		});

		it('unfolds on handle click and renders unfolded order with inline send and no send column', () => {
			render(
				<ChatComposer
					{...createMinimalProps({
						aboveComposer: <div data-testid="above-content">Above</div>,
					})}
				/>
			);

			const handle = screen.getByTestId('phone-composer-handle');
			fireEvent.click(handle);

			// Unfolded state: handle is at the top with aria-expanded="true"
			expect(screen.getByTestId('phone-composer-handle')).toHaveAttribute('aria-expanded', 'true');
			expect(screen.getByTestId('above-content')).toBeInTheDocument();
			expect(screen.getByRole('textbox')).toBeInTheDocument();

			// On phone, the desktop send column with notification bell is not rendered
			expect(screen.queryByTitle('Notification Settings')).not.toBeInTheDocument();
		});

		it('measures a saved draft to its full height on first unfold when opened folded', () => {
			window.localStorage?.removeItem('test.composer.collapsed');
			const scrollHeightSpy = vi
				.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
				.mockReturnValue(140);
			try {
				render(
					<ChatComposer
						{...createMinimalProps({
							draftKey: 'test-session',
							value: 'line 1\nline 2\nline 3\nline 4',
						})}
					/>
				);

				// Initially folded: textbox is unmounted
				expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

				// Unfold
				fireEvent.click(screen.getByTestId('phone-composer-handle'));

				const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
				expect(textarea).toBeInTheDocument();
				expect(textarea.style.height).toBe('140px');
			} finally {
				scrollHeightSpy.mockRestore();
			}
		});

		it('re-measures a multi-line draft to its full height after folding and reopening', () => {
			window.localStorage?.setItem('test.composer.collapsed', 'false');
			const scrollHeightSpy = vi
				.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
				.mockReturnValue(140);
			try {
				render(
					<ChatComposer
						{...createMinimalProps({
							draftKey: 'test-session',
							value: 'line 1\nline 2\nline 3\nline 4',
						})}
					/>
				);

				const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
				expect(textarea.style.height).toBe('140px');

				// Fold the composer
				fireEvent.click(screen.getByTestId('phone-composer-handle'));
				expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

				// Reopen (unfold) the composer
				fireEvent.click(screen.getByTestId('phone-composer-handle'));
				const reopenedTextarea = screen.getByRole('textbox') as HTMLTextAreaElement;
				expect(reopenedTextarea.style.height).toBe('140px');
			} finally {
				scrollHeightSpy.mockRestore();
			}
		});
	});

	describe('text and submit', () => {
		it('forwards typing through onChange', () => {
			const onChange = vi.fn();
			render(<ChatComposer {...createMinimalProps({ onChange })} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			fireEvent.change(textarea, { target: { value: 'hello world' } });

			expect(onChange).toHaveBeenCalledWith('hello world');
		});

		it('submits on Send button click when text is present', () => {
			const onSubmit = vi.fn();
			render(<ChatComposer {...createMinimalProps({ value: 'send this', onSubmit })} />);

			const sendButton = screen.getByTitle('Send message');
			expect(sendButton).not.toBeDisabled();
			fireEvent.click(sendButton);

			expect(onSubmit).toHaveBeenCalledTimes(1);
		});

		it('disables submit when value is empty or whitespace', () => {
			const onSubmit = vi.fn();
			render(<ChatComposer {...createMinimalProps({ value: '   ', onSubmit })} />);

			const sendButton = screen.getByTitle('Send message');
			expect(sendButton).toBeDisabled();
			fireEvent.click(sendButton);

			expect(onSubmit).not.toHaveBeenCalled();
		});

		it('submits on Enter key when enterToSend is enabled', () => {
			const onSubmit = vi.fn();
			render(
				<ChatComposer
					{...createMinimalProps({
						value: 'enter message',
						enterToSend: true,
						onSubmit,
					})}
				/>
			);

			const textarea = screen.getByRole('textbox');
			fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

			expect(onSubmit).toHaveBeenCalledTimes(1);
		});

		it('submits on Cmd+Enter regardless of enterToSend', () => {
			const onSubmit = vi.fn();
			render(
				<ChatComposer
					{...createMinimalProps({
						value: 'cmd enter message',
						enterToSend: false,
						onSubmit,
					})}
				/>
			);

			const textarea = screen.getByRole('textbox');
			fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

			expect(onSubmit).toHaveBeenCalledTimes(1);
		});
	});

	describe('escape handling', () => {
		it('closes @ mention popover on Escape and keeps the key from bubbling', () => {
			const windowEscapeListener = vi.fn();
			window.addEventListener('keydown', windowEscapeListener);

			const sessions = [createMockSession({ id: 'agent-1', name: 'Coder' })];
			render(<ControlledComposer mentionRoster={{ sessions }} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			fireEvent.change(textarea, { target: { value: '@' } });

			expect(screen.getByText('Coder')).toBeInTheDocument();

			fireEvent.keyDown(textarea, { key: 'Escape' });

			expect(screen.queryByText('Coder')).not.toBeInTheDocument();
			expect(windowEscapeListener).not.toHaveBeenCalled();

			window.removeEventListener('keydown', windowEscapeListener);
		});

		it('lets Escape bubble to window when popover is closed', () => {
			const windowEscapeListener = vi.fn();
			window.addEventListener('keydown', windowEscapeListener);

			render(<ChatComposer {...createMinimalProps({ value: 'regular text' })} />);

			const textarea = screen.getByRole('textbox');
			fireEvent.keyDown(textarea, { key: 'Escape' });

			expect(windowEscapeListener).toHaveBeenCalledTimes(1);

			window.removeEventListener('keydown', windowEscapeListener);
		});
	});

	describe('mentions', () => {
		it('opens mention popover and inserts selected agent on Tab', () => {
			const onChange = vi.fn();
			const sessions = [createMockSession({ id: 'agent-1', name: 'Alice' })];

			render(<ControlledComposer onChange={onChange} mentionRoster={{ sessions }} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			fireEvent.change(textarea, { target: { value: '@' } });

			expect(screen.getByText('Alice')).toBeInTheDocument();

			fireEvent.keyDown(textarea, { key: 'Tab' });

			expect(onChange).toHaveBeenCalledWith('@Alice ');
		});

		it('accepts a mid-sentence mention with one space and keeps the caret after it', async () => {
			const onChange = vi.fn();
			const sessions = [createMockSession({ id: 'agent-1', name: 'Alice' })];

			render(<ControlledComposer onChange={onChange} mentionRoster={{ sessions }} />);

			const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
			fireEvent.change(textarea, {
				target: { value: 'ask @A to review', selectionStart: 6, selectionEnd: 6 },
			});
			expect(screen.getByText('Alice')).toBeInTheDocument();

			fireEvent.keyDown(textarea, { key: 'Enter' });
			// The accept places the caret in the frame after the controlled value commits.
			await act(async () => {
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			});

			expect(onChange).toHaveBeenLastCalledWith('ask @Alice to review');
			expect(textarea.value).toBe('ask @Alice to review');
			expect(textarea.selectionStart).toBe('ask @Alice '.length);
			expect(textarea.selectionEnd).toBe(textarea.selectionStart);
		});
	});

	describe('staged images', () => {
		it('renders staged images strip and delegates lightbox on thumbnail click', () => {
			const onOpenLightbox = vi.fn();
			const stagedImages = ['data:image/png;base64,mock1'];

			render(
				<ChatComposer
					{...createMinimalProps({
						stagedImages,
						onOpenLightbox,
					})}
				/>
			);

			const thumbnail = screen.getByRole('button', { name: 'Staged image 1' });
			expect(thumbnail).toBeInTheDocument();

			fireEvent.click(thumbnail);
			expect(onOpenLightbox).toHaveBeenCalledWith(
				'data:image/png;base64,mock1',
				stagedImages,
				'staged'
			);
		});

		it('opens image annotator for staged image', () => {
			const stagedImages = ['data:image/png;base64,mock1'];

			render(
				<ChatComposer
					{...createMinimalProps({
						stagedImages,
					})}
				/>
			);

			const annotateButton = screen.getByRole('button', { name: 'Annotate image' });
			fireEvent.click(annotateButton);

			const annotatorState = useImageAnnotatorStore.getState();
			expect(annotatorState.isOpen).toBe(true);
			expect(annotatorState.imageDataUrl).toBe(stagedImages[0]);
		});

		it('renumbers the room draft when a staged image moves', () => {
			render(
				<StatefulImagesComposer
					value="keep Screenshot 1, swap Screenshot 2, leave Screenshot 3 and Screenshot 9"
					images={['data:image/png;base64,a', 'data:image/png;base64,b', 'data:image/png;base64,c']}
				/>
			);

			const tiles = screen.getAllByRole('button', { name: /^Staged image/ });
			stubStagedTileLayout(tiles);
			const dataTransfer = makeStagedImageDataTransfer();

			fireEvent.dragStart(tiles[0], { dataTransfer });
			fireStagedDrag('dragOver', tiles[1], dataTransfer, 180);
			fireStagedDrag('drop', tiles[1], dataTransfer, 180);

			expect(screen.getByRole('textbox')).toHaveValue(
				'keep Screenshot 2, swap Screenshot 1, leave Screenshot 3 and Screenshot 9'
			);
		});
	});
});
