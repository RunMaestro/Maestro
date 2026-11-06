/**
 * ChatComposerFrame: the shell both composers render. Pins the two layouts
 * (the AI composer's raised box with `belowInput`, the room's flat box with a
 * bottom-aligned send column), where each slot lands, the toast zone opt-out,
 * and the toolbar passthrough.
 */

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ChatComposerFrame,
	GROUP_CHAT_COMPOSER_CAPABILITIES,
	type ChatComposerFrameProps,
} from '../../../../renderer/components/ChatComposer';
import { usePhoneLayout } from '../../../../renderer/hooks/ui/useViewportBreakpoint';
import { useToastAvoidZoneStore } from '../../../../renderer/hooks/ui/useToastAvoidZone';
import { createMockTheme } from '../../../helpers/mockTheme';

vi.mock('../../../../renderer/hooks/ui/useViewportBreakpoint', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/hooks/ui/useViewportBreakpoint')>()),
	usePhoneLayout: vi.fn(() => false),
}));

const mockedUsePhoneLayout = vi.mocked(usePhoneLayout);
const theme = createMockTheme();
const UNFOLDED = { isFolded: false, toggle: () => {} };
const FOLDED = { isFolded: true, toggle: () => {} };

function frame(overrides: Partial<ChatComposerFrameProps> = {}) {
	return (
		<ChatComposerFrame
			theme={theme}
			capabilities={GROUP_CHAT_COMPOSER_CAPABILITIES}
			fold={UNFOLDED}
			textarea={<textarea aria-label="draft" />}
			onSend={() => {}}
			{...overrides}
		/>
	);
}

function zoneCount() {
	return Object.keys(useToastAvoidZoneStore.getState().zones).length;
}

describe('ChatComposerFrame', () => {
	beforeEach(() => {
		mockedUsePhoneLayout.mockReturnValue(false);
		useToastAvoidZoneStore.setState({ zones: {} });
	});

	afterEach(() => {
		useToastAvoidZoneStore.setState({ zones: {} });
	});

	describe('layout', () => {
		it("keeps the room's flat box and bottom-aligned send column", () => {
			render(frame({ sendColumnClassName: 'self-end' }));
			const box = screen.getByLabelText('draft').parentElement!;

			expect(box).toHaveClass('flex-1', 'relative', 'border', 'rounded-lg', 'flex', 'flex-col');
			expect(box).not.toHaveClass('chrome-raised');
			expect(box.parentElement).toHaveClass('flex', 'gap-3');
			expect(screen.getByTitle('Send message').parentElement).toHaveClass('self-end');
		});

		it("draws the AI composer's raised box in a column with belowInput", () => {
			render(frame({ raised: true, belowInput: <div data-testid="below" /> }));
			const box = screen.getByLabelText('draft').parentElement!;

			expect(box).toHaveClass('chrome-raised', 'min-w-0', 'flex-1', 'flex-col');
			expect(box.nextElementSibling).toBe(screen.getByTestId('below'));
			expect(box.parentElement).toHaveClass('flex', 'min-w-0', 'flex-1', 'flex-col');
		});

		it('does not draw belowInput without the raised box', () => {
			render(frame({ belowInput: <div data-testid="below" /> }));

			expect(screen.queryByTestId('below')).not.toBeInTheDocument();
		});

		it('puts inputHeader inside the box above the textarea', () => {
			render(frame({ inputHeader: <div data-testid="header" /> }));
			const header = screen.getByTestId('header');

			expect(header.nextElementSibling).toBe(screen.getByLabelText('draft'));
		});

		it('renders aboveComposer and overlays outside the box', () => {
			render(
				frame({
					aboveComposer: <div data-testid="above" />,
					overlays: <div data-testid="overlay" />,
				})
			);
			const box = screen.getByLabelText('draft').parentElement!;

			expect(box).not.toContainElement(screen.getByTestId('above'));
			expect(box).not.toContainElement(screen.getByTestId('overlay'));
		});
	});

	describe('send column', () => {
		it("titles the column from columnSendTitle while the phone toolbar keeps sendTitle's fallback", () => {
			render(frame({ columnSendTitle: 'Run command (Enter)' }));

			expect(screen.getByTitle('Run command (Enter)')).toBeInTheDocument();
		});

		it('is not drawn on a phone', () => {
			mockedUsePhoneLayout.mockReturnValue(true);
			render(frame({ columnSendTitle: 'Column send' }));

			expect(screen.queryByTitle('Column send')).not.toBeInTheDocument();
			expect(screen.queryByTitle('Notification Settings')).not.toBeInTheDocument();
		});
	});

	describe('toast avoid zone', () => {
		it('registers a zone by default, folded or not', () => {
			mockedUsePhoneLayout.mockReturnValue(true);
			const { rerender } = render(frame());
			expect(zoneCount()).toBe(1);

			rerender(frame({ fold: FOLDED }));
			expect(zoneCount()).toBe(1);
		});

		it('registers none with avoidToasts off, and the folded handle has no wrapper', () => {
			mockedUsePhoneLayout.mockReturnValue(true);
			const { container } = render(frame({ avoidToasts: false, fold: FOLDED }));

			expect(zoneCount()).toBe(0);
			expect(container.firstElementChild).toBe(screen.getByTestId('phone-composer-handle'));
		});
	});

	describe('staged images', () => {
		const staged = {
			stagedImages: ['data:image/png;base64,AAAA'],
			setStagedImages: vi.fn(),
			setLightboxImage: vi.fn(),
			openAnnotator: vi.fn(),
			onReorderStagedImages: vi.fn(),
		};

		it('shows the strip when the surface wires its actions', () => {
			render(frame(staged));

			expect(screen.getByLabelText('Staged image 1')).toBeInTheDocument();
		});

		it('hides the strip with stagedImagesVisible off', () => {
			render(frame({ ...staged, stagedImagesVisible: false }));

			expect(screen.queryByLabelText('Staged image 1')).not.toBeInTheDocument();
		});
	});

	describe('toolbar passthrough', () => {
		it('hands toolbarProps to the toolbar (terminal mode shows the shell cwd)', () => {
			render(frame({ toolbarProps: { isTerminalMode: true, terminalCwd: '~/project' } }));

			expect(screen.getByText('~/project')).toBeInTheDocument();
		});
	});
});
