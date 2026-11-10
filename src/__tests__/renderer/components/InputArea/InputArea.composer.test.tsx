/**
 * The AI composer through the shared composer shell (step 8, AI chat half).
 *
 * Two contracts pinned against InputArea as a whole, so they hold whatever
 * InputArea renders its composer through:
 *
 * 1. Render budget (CLAUDE-PERFORMANCE.md). A keystroke re-renders InputArea,
 *    the draft store's sole subscriber, and the textarea under it exactly once.
 *    The memoized toolbar and the send column do not re-render at all.
 * 2. Behaviour. Enter and Cmd+Enter reach the AI key handler, Send sends and
 *    opens the Send menu, the `@` picker opens with its category bar, images
 *    stage, and `!` on an empty composer enters command mode.
 *
 * Renders are counted at the leaf modules (not the ChatComposer barrel), so
 * the wrappers see every render whichever file imports the component. Each
 * counter is wrapped in `memo`, as the real component is, so it counts the
 * renders the real component would do rather than every parent render.
 */

import { memo, type ComponentProps, type RefObject } from 'react';
import { act, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InputArea } from '../../../../renderer/components/InputArea';
import { useComposerInputStore } from '../../../../renderer/stores/composerInputStore';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { createMockAITab } from '../../../helpers';
import { createInputAreaSession, inputAreaTheme } from './_fixtures';

const counts = vi.hoisted(() => ({ toolbar: 0, sendColumn: 0, textarea: 0 }));

vi.mock(
	'../../../../renderer/components/InputArea/components/ToolbarControls',
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import('../../../../renderer/components/InputArea/components/ToolbarControls')
			>();
		const Real = actual.ToolbarControls;
		return {
			...actual,
			ToolbarControls: memo((props: ComponentProps<typeof Real>) => {
				counts.toolbar += 1;
				return <Real {...props} />;
			}),
		};
	}
);

vi.mock(
	'../../../../renderer/components/ChatComposer/ComposerSendColumn',
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import('../../../../renderer/components/ChatComposer/ComposerSendColumn')
			>();
		const Real = actual.ComposerSendColumn;
		return {
			...actual,
			ComposerSendColumn: memo((props: ComponentProps<typeof Real>) => {
				counts.sendColumn += 1;
				return <Real {...props} />;
			}),
		};
	}
);

vi.mock('../../../../renderer/components/ChatComposer/ComposerTextarea', async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import('../../../../renderer/components/ChatComposer/ComposerTextarea')
		>();
	const Real = actual.ComposerTextarea;
	return {
		...actual,
		ComposerTextarea: memo((props: ComponentProps<typeof Real>) => {
			counts.textarea += 1;
			return <Real {...props} />;
		}),
	};
});

vi.mock('../../../../renderer/components/InputArea/components/SendMenuPopover', () => ({
	SendMenuPopover: vi.fn(() => <div data-testid="send-menu-popover" />),
}));

vi.mock('../../../../renderer/hooks/agent/useAgentCapabilities', () => {
	const hasCapability = (cap: string) =>
		cap === 'supportsImageInput' ||
		cap === 'supportsImageInputOnResume' ||
		cap === 'supportsReadOnlyMode';
	const result = {
		capabilities: {},
		loading: false,
		error: null,
		refresh: () => {},
		hasCapability,
	};
	return { useAgentCapabilities: () => result };
});

// MainPanel always passes the pill lists, memoized; a test that left them out
// would hand the toolbar a fresh default array on every render.
const MODELS = ['opus', 'sonnet'];
const EFFORTS = ['low', 'high'];

function resetCounts() {
	counts.toolbar = 0;
	counts.sendColumn = 0;
	counts.textarea = 0;
}

function seedDraft(draft: string) {
	useComposerInputStore.setState({ aiValue: draft, terminalValue: '', aiCommandMode: 'off' });
}

/** What a keystroke does: the composer writes the store, and only InputArea subscribes. */
function typeDraft(draft: string) {
	act(() => {
		useComposerInputStore.setState({ aiValue: draft });
	});
}

function createProps(overrides: Partial<ComponentProps<typeof InputArea>> = {}) {
	const inputRef: RefObject<HTMLTextAreaElement> = { current: null };
	const setInputValue = vi.fn((value: string) => {
		useComposerInputStore.setState({ aiValue: value });
	});
	return {
		session: createInputAreaSession(),
		theme: inputAreaTheme,
		setInputValue,
		enterToSend: true,
		setEnterToSend: vi.fn(),
		stagedImages: [] as string[],
		setStagedImages: vi.fn(),
		setLightboxImage: vi.fn(),
		commandHistoryOpen: false,
		setCommandHistoryOpen: vi.fn(),
		commandHistoryFilter: '',
		setCommandHistoryFilter: vi.fn(),
		commandHistorySelectedIndex: 0,
		setCommandHistorySelectedIndex: vi.fn(),
		slashCommandOpen: false,
		setSlashCommandOpen: vi.fn(),
		slashCommands: [],
		selectedSlashCommandIndex: 0,
		setSelectedSlashCommandIndex: vi.fn(),
		inputRef,
		handleInputKeyDown: vi.fn(),
		handlePaste: vi.fn(),
		handleDrop: vi.fn(),
		toggleInputMode: vi.fn(),
		processInput: vi.fn(),
		handleInterrupt: vi.fn(),
		onInputFocus: vi.fn(),
		onInputBlur: vi.fn(),
		setAtMentionOpen: vi.fn(),
		setAtMentionFilter: vi.fn(),
		setAtMentionStartIndex: vi.fn(),
		setSelectedAtMentionIndex: vi.fn(),
		setAtMentionCategory: vi.fn(),
		availableModels: MODELS,
		availableEfforts: EFFORTS,
		...overrides,
	} as ComponentProps<typeof InputArea>;
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

describe('AI composer through the shared shell', () => {
	beforeEach(() => {
		seedDraft('');
		useSessionStore.setState({ sessions: [], groups: [] } as never);
		useSettingsStore.setState({ sendButtonMenu: true });
		resetCounts();
	});

	afterEach(() => {
		seedDraft('');
		useSessionStore.setState({ sessions: [], groups: [], activeSessionId: '' } as never);
		vi.restoreAllMocks();
	});

	describe('render budget', () => {
		it('renders the textarea once per keystroke and never the toolbar or send column', () => {
			seedDraft('hel');
			render(<InputArea {...createProps()} />);
			resetCounts();

			typeDraft('hell');
			typeDraft('hello');
			typeDraft('hello there');

			expect(counts.textarea).toBe(3);
			expect(counts.toolbar).toBe(0);
			expect(counts.sendColumn).toBe(0);
		});

		it('does not re-render the toolbar or send column when the draft empties or fills', () => {
			render(<InputArea {...createProps()} />);
			resetCounts();

			typeDraft('a');
			typeDraft('');
			typeDraft('b');

			expect(counts.toolbar).toBe(0);
			expect(counts.sendColumn).toBe(0);
		});
	});

	describe('staged image reorder', () => {
		it('renumbers the AI draft when a staged image moves', () => {
			seedDraft('keep Screenshot 1, swap Screenshot 2, leave Screenshot 3 and Screenshot 9');
			render(
				<InputArea
					{...createProps({
						stagedImages: [
							'data:image/png;base64,a',
							'data:image/png;base64,b',
							'data:image/png;base64,c',
						],
					})}
				/>
			);

			const tiles = screen.getAllByRole('button', { name: /^Staged image/ });
			stubStagedTileLayout(tiles);
			const dataTransfer = makeStagedImageDataTransfer();

			fireEvent.dragStart(tiles[0], { dataTransfer });
			fireStagedDrag('dragOver', tiles[1], dataTransfer, 180);
			fireStagedDrag('drop', tiles[1], dataTransfer, 180);

			expect(useComposerInputStore.getState().aiValue).toBe(
				'keep Screenshot 2, swap Screenshot 1, leave Screenshot 3 and Screenshot 9'
			);
		});
	});

	describe('keys', () => {
		it('hands Enter and Cmd+Enter to the AI key handler', () => {
			const props = createProps();
			render(<InputArea {...props} />);
			const textbox = screen.getByRole('textbox');

			fireEvent.keyDown(textbox, { key: 'Enter' });
			fireEvent.keyDown(textbox, { key: 'Enter', metaKey: true });

			const handler = vi.mocked(props.handleInputKeyDown);
			expect(handler).toHaveBeenCalledTimes(2);
			expect(handler.mock.calls[0][0].key).toBe('Enter');
			expect(handler.mock.calls[1][0].metaKey).toBe(true);
		});
	});

	describe('Send', () => {
		it('sends on click while the agent is idle', () => {
			seedDraft('hello');
			const props = createProps();
			render(<InputArea {...props} />);

			fireEvent.click(screen.getByTitle('Send message'));

			expect(props.processInput).toHaveBeenCalledTimes(1);
			expect(screen.queryByTestId('send-menu-popover')).not.toBeInTheDocument();
		});

		it('opens the Send menu instead of sending while the agent works and a draft waits', () => {
			const session = createInputAreaSession({
				state: 'busy',
				aiTabs: [createMockAITab({ id: 'tab-1', state: 'busy' })],
				activeTabId: 'tab-1',
			});
			useSessionStore.setState({ sessions: [session], activeSessionId: session.id } as never);
			seedDraft('also check the retry path');
			const props = createProps({ session });
			render(<InputArea {...props} />);

			fireEvent.click(screen.getByTitle('Send message'));

			expect(screen.getByTestId('send-menu-popover')).toBeInTheDocument();
			expect(props.processInput).not.toHaveBeenCalled();
		});

		it('opens the Send menu on right-click', () => {
			render(<InputArea {...createProps()} />);

			fireEvent.contextMenu(screen.getByTitle('Send message'));

			expect(screen.getByTestId('send-menu-popover')).toBeInTheDocument();
		});

		it('titles Send for the shell in terminal mode', () => {
			const props = createProps({ session: createInputAreaSession({ inputMode: 'terminal' }) });
			render(<InputArea {...props} />);

			fireEvent.click(screen.getByTitle('Run command (Enter)'));

			expect(props.processInput).toHaveBeenCalledTimes(1);
		});
	});

	describe('@ picker', () => {
		it('opens through the text change handler when the draft gains an @', () => {
			const props = createProps();
			render(<InputArea {...props} />);

			fireEvent.change(screen.getByRole('textbox'), {
				target: { value: '@', selectionStart: 1 },
			});

			expect(props.setAtMentionOpen).toHaveBeenCalledWith(true);
		});

		it('renders the open picker with its category bar and items', () => {
			render(
				<InputArea
					{...createProps({
						atMentionOpen: true,
						atMentionFilter: 'src',
						atMentionItems: [
							{
								kind: 'file' as const,
								value: '@src/index.ts ',
								displayText: 'index.ts',
								fullPath: 'src/index.ts',
								score: 0,
							},
						],
						atMentionCounts: { all: 1, files: 1, directories: 0, agents: 0 },
					})}
				/>
			);

			expect(screen.getByText('Files')).toBeInTheDocument();
			expect(screen.getByText('src/index.ts')).toBeInTheDocument();
		});
	});

	describe('images', () => {
		it('stages a picked image', async () => {
			const props = createProps();
			const { container } = render(<InputArea {...props} />);
			const input = container.querySelector<HTMLInputElement>('#image-file-input')!;
			const file = new File(['png'], 'shot.png', { type: 'image/png' });

			fireEvent.change(input, { target: { files: [file] } });

			await waitFor(() => expect(props.setStagedImages).toHaveBeenCalled());
		});

		it('shows staged images in the strip', () => {
			render(
				<InputArea
					{...createProps({
						stagedImages: ['data:image/png;base64,AAAA', 'data:image/png;base64,BBBB'],
					})}
				/>
			);

			expect(screen.getByLabelText('Staged image 1')).toBeInTheDocument();
			expect(screen.getByLabelText('Staged image 2')).toBeInTheDocument();
		});
	});

	describe('command mode', () => {
		it('enters command mode on ! in an empty composer and shows the mode bar', () => {
			render(<InputArea {...createProps()} />);

			fireEvent.change(screen.getByRole('textbox'), {
				target: { value: '!', selectionStart: 1 },
			});

			expect(useComposerInputStore.getState().aiCommandMode).toBe('shell');
			expect(screen.getByTestId('command-mode-bar')).toBeInTheDocument();
		});
	});
});
