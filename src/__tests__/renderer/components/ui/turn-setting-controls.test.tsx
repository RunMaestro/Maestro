// Source: src/__tests__/renderer/components/ui/TurnSettingPills.test.tsx
// Source: src/__tests__/renderer/components/InputArea/hooks/useAiSendMenu.test.tsx
// Source: src/__tests__/renderer/components/InputArea/hooks/useModelEffortMenus.test.tsx
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from '@testing-library/react';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { TurnSettingPills } from '../../../../renderer/components/ui/TurnSettingPills';
import { mockTheme } from '../../../helpers/mockTheme';
import { describe as describeSourceSuite } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { vi } from 'vitest';
import { ComposerSendColumn } from '../../../../renderer/components/ChatComposer';
import { useAiSendMenu } from '../../../../renderer/components/InputArea/hooks/useAiSendMenu';
import type { Theme } from '../../../../renderer/types';
import { inputAreaTheme } from '../InputArea/_fixtures';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useComposerInputStore } from '../../../../renderer/stores/composerInputStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { createMockAITab } from '../../../helpers';
import { createMockSession } from '../../../helpers';
import { useModelEffortMenus } from '../../../../renderer/components/InputArea/hooks/useModelEffortMenus';
describe('TurnSettingPills', () => {
	function renderPills(props: Partial<React.ComponentProps<typeof TurnSettingPills>> = {}) {
		return render(<TurnSettingPills theme={mockTheme} {...props} />);
	}

	describe('TurnSettingPills', () => {
		it('renders nothing when the turn ran on the agent defaults', () => {
			const { container } = renderPills();
			expect(container.firstElementChild).toBeNull();
		});

		it('omits the pill for whichever value is unset rather than guessing', () => {
			const { queryByTestId } = renderPills({ model: 'opus[1m]' });
			expect(queryByTestId('turn-model-pill')).not.toBeNull();
			expect(queryByTestId('turn-effort-pill')).toBeNull();
		});

		it('marks both pills as readouts the phone stylesheet can retire', () => {
			// They share a footer row with controls that cannot yield width (the
			// queued card's Force Send button and its icon cluster), so the phone
			// block in index.css hides everything carrying this attribute. Dropping
			// it here is invisible in jsdom and reappears as overlapping pills on a
			// 390px screen.
			const { getByTestId } = renderPills({ model: 'opus[1m]', effort: 'high' });
			expect(getByTestId('turn-model-pill').hasAttribute('data-turn-setting-pill')).toBe(true);
			expect(getByTestId('turn-effort-pill').hasAttribute('data-turn-setting-pill')).toBe(true);
		});
	});

	describe('TurnSettingPills phone rule', () => {
		// The attribute on the JSX and the rule in the stylesheet are the two
		// halves of one behaviour, and nothing in the type system ties them
		// together: jsdom has no layout engine and never applies index.css, so
		// deleting or renaming either side is silent here and reappears as three
		// overlapping groups in a queued card's footer at 390px.
		it('hides every element carrying the attribute at the phone breakpoint', () => {
			const css = readFileSync(resolve(process.cwd(), 'src/renderer/index.css'), 'utf8');
			expect(css).toMatch(
				/html\[data-runtime='web-desktop'\]\[data-bp='xs'\] \[data-turn-setting-pill\]\s*\{\s*display:\s*none;/
			);
		});
	});
});

vi.mock('../../../../renderer/components/InputArea/components/SendMenuPopover', () => ({
	SendMenuPopover: vi.fn(() => <div data-testid="send-menu-popover" />),
}));
vi.mock('../../../../renderer/components/NotificationPopover', () => ({
	NotificationPopover: vi.fn(({ onClose }) => (
		<div data-testid="notification-popover">
			<button onClick={onClose}>Close</button>
		</div>
	)),
}));
describeSourceSuite('useAiSendMenu', () => {
	/**
	 * The AI composer's send column as ChatComposerFrame builds it for InputArea:
	 * the shared column with the AI Send menu and the terminal-mode title.
	 */
	function NotificationSendControls({
		theme,
		isTerminalMode,
		processInput,
	}: {
		theme: Theme;
		isTerminalMode: boolean;
		processInput: () => void;
	}) {
		const sendMenu = useAiSendMenu(theme, isTerminalMode, processInput);
		return (
			<ComposerSendColumn
				theme={theme}
				onSend={processInput}
				sendTitle={isTerminalMode ? 'Run command (Enter)' : 'Send message'}
				sendMenu={sendMenu}
			/>
		);
	}

	function seedWorkingAgent(draft: string) {
		const session = createMockSession({
			state: 'busy',
			activeTabId: 'tab-1',
			aiTabs: [createMockAITab({ id: 'tab-1', state: 'busy' })],
		});
		useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
		useComposerInputStore.setState({ aiValue: draft, aiCommandMode: 'off' });
	}

	describe('useAiSendMenu in the send column', () => {
		afterEach(() => {
			useSessionStore.setState({ sessions: [], activeSessionId: '' });
			useComposerInputStore.setState({ aiValue: '' });
			useSettingsStore.setState({ sendButtonMenu: true });
		});

		it('toggles notification popover', () => {
			render(
				<NotificationSendControls
					theme={inputAreaTheme}
					isTerminalMode={false}
					processInput={vi.fn()}
				/>
			);

			fireEvent.click(screen.getByTitle('Notification Settings'));
			expect(screen.getByTestId('notification-popover')).toBeInTheDocument();

			fireEvent.click(screen.getByTitle('Notification Settings'));
			expect(screen.queryByTestId('notification-popover')).not.toBeInTheDocument();
		});

		it('sends input and uses terminal title in terminal mode', () => {
			const processInput = vi.fn();
			render(
				<NotificationSendControls
					theme={inputAreaTheme}
					isTerminalMode
					processInput={processInput}
				/>
			);

			fireEvent.click(screen.getByTitle('Run command (Enter)'));

			expect(processInput).toHaveBeenCalled();
		});

		it('opens the send menu instead of sending while the agent works', () => {
			seedWorkingAgent('also check the retry path');
			const processInput = vi.fn();
			render(
				<NotificationSendControls
					theme={inputAreaTheme}
					isTerminalMode={false}
					processInput={processInput}
				/>
			);

			fireEvent.click(screen.getByTitle('Send message'));

			expect(screen.getByTestId('send-menu-popover')).toBeInTheDocument();
			expect(processInput).not.toHaveBeenCalled();
		});

		it('sends at once when the menu is turned off', () => {
			seedWorkingAgent('also check the retry path');
			useSettingsStore.setState({ sendButtonMenu: false });
			const processInput = vi.fn();
			render(
				<NotificationSendControls
					theme={inputAreaTheme}
					isTerminalMode={false}
					processInput={processInput}
				/>
			);

			fireEvent.click(screen.getByTitle('Send message'));

			expect(processInput).toHaveBeenCalled();
			expect(screen.queryByTestId('send-menu-popover')).not.toBeInTheDocument();
		});

		it('sends at once when the draft is empty', () => {
			seedWorkingAgent('');
			const processInput = vi.fn();
			render(
				<NotificationSendControls
					theme={inputAreaTheme}
					isTerminalMode={false}
					processInput={processInput}
				/>
			);

			fireEvent.click(screen.getByTitle('Send message'));

			expect(processInput).toHaveBeenCalled();
		});
	});
});
describeSourceSuite('useModelEffortMenus', () => {
	function Harness() {
		const {
			modelMenuOpen,
			setModelMenuOpen,
			modelMenuRef,
			effortMenuOpen,
			setEffortMenuOpen,
			effortMenuRef,
		} = useModelEffortMenus();

		return (
			<div>
				<div ref={modelMenuRef} data-testid="model-menu">
					<button onClick={() => setModelMenuOpen(true)}>Open model</button>
					<span>{modelMenuOpen ? 'model-open' : 'model-closed'}</span>
				</div>
				<div ref={effortMenuRef} data-testid="effort-menu">
					<button onClick={() => setEffortMenuOpen(true)}>Open effort</button>
					<span>{effortMenuOpen ? 'effort-open' : 'effort-closed'}</span>
				</div>
				<button>Outside</button>
			</div>
		);
	}

	describe('useModelEffortMenus', () => {
		it('closes open menus on outside mousedown', () => {
			render(<Harness />);

			fireEvent.click(screen.getByText('Open model'));
			fireEvent.click(screen.getByText('Open effort'));
			expect(screen.getByText('model-open')).toBeInTheDocument();
			expect(screen.getByText('effort-open')).toBeInTheDocument();

			fireEvent.mouseDown(screen.getByText('Outside'));

			expect(screen.getByText('model-closed')).toBeInTheDocument();
			expect(screen.getByText('effort-closed')).toBeInTheDocument();
		});

		it('keeps menu open for inside mousedown', () => {
			render(<Harness />);

			fireEvent.click(screen.getByText('Open model'));
			fireEvent.mouseDown(screen.getByTestId('model-menu'));

			expect(screen.getByText('model-open')).toBeInTheDocument();
		});
	});
});
