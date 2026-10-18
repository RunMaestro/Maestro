import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../../../renderer/types';
import { SendMenuPopover } from '../../../../../renderer/components/InputArea/components/SendMenuPopover';
import { inputAreaTheme } from '../_fixtures';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { useComposerInputStore } from '../../../../../renderer/stores/composerInputStore';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { useModalStore } from '../../../../../renderer/stores/modalStore';
import {
	FORCED_PARALLEL_SEND_EVENT,
	HOLD_SEND_EVENT,
} from '../../../../../renderer/hooks/input/useInputKeyDown';
import { STEER_SEND_EVENT } from '../../../../../renderer/services/chatSteering';
import { createMockAITab, createMockSession } from '../../../../helpers';

const openUrlMock = vi.fn();
vi.mock('../../../../../renderer/utils/openUrl', () => ({
	openUrl: (url: string) => openUrlMock(url),
}));

function seed(overrides: Partial<Session> = {}, tabs = [createMockAITab({ state: 'busy' })]) {
	const session = createMockSession({
		state: 'busy',
		activeTabId: 'tab-1',
		aiTabs: tabs,
		enableMaestroP: true,
		maestroPMode: 'interactive',
		claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		...overrides,
	});
	useSessionStore.setState({ sessions: [session], activeSessionId: session.id });
	useComposerInputStore.setState({ aiValue: 'also check the retry path', aiCommandMode: 'off' });
}

const anchors: HTMLElement[] = [];

function renderMenu(processInput = vi.fn(), onClose = vi.fn()) {
	const anchor = document.createElement('button');
	document.body.appendChild(anchor);
	anchors.push(anchor);
	const anchorRef = createRef<HTMLElement>();
	(anchorRef as { current: HTMLElement | null }).current = anchor;
	render(
		<SendMenuPopover
			theme={inputAreaTheme}
			anchorRef={anchorRef}
			onClose={onClose}
			processInput={processInput}
		/>
	);
	return { processInput, onClose };
}

const row = (action: string) =>
	document.querySelector(`[data-send-menu-row="${action}"]`) as HTMLButtonElement;

describe('SendMenuPopover', () => {
	beforeEach(() => {
		useSettingsStore.setState({ forcedParallelExecution: false, sendButtonMenu: true });
	});
	afterEach(() => {
		useSessionStore.setState({ sessions: [], activeSessionId: '' });
		useComposerInputStore.setState({ aiValue: '' });
		openUrlMock.mockReset();
		anchors.splice(0).forEach((anchor) => anchor.remove());
	});

	it('queues through the plain send', () => {
		seed();
		const { processInput, onClose } = renderMenu();
		fireEvent.click(row('queue'));
		expect(onClose).toHaveBeenCalled();
		expect(processInput).toHaveBeenCalledTimes(1);
	});

	it('raises the composer events for Queue Held and Steer', () => {
		seed();
		const hold = vi.fn();
		const steer = vi.fn();
		window.addEventListener(HOLD_SEND_EVENT, hold);
		window.addEventListener(STEER_SEND_EVENT, steer);
		renderMenu();
		fireEvent.click(row('hold'));
		fireEvent.click(row('steer'));
		expect(hold).toHaveBeenCalledTimes(1);
		expect(steer).toHaveBeenCalledTimes(1);
		window.removeEventListener(HOLD_SEND_EVENT, hold);
		window.removeEventListener(STEER_SEND_EVENT, steer);
	});

	it('does nothing on a dead Force Send while this tab works', () => {
		seed();
		const force = vi.fn();
		window.addEventListener(FORCED_PARALLEL_SEND_EVENT, force);
		const { onClose } = renderMenu();
		fireEvent.click(row('force'));
		expect(force).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
		window.removeEventListener(FORCED_PARALLEL_SEND_EVENT, force);
	});

	it('opens the Forced Parallel setting from a dead Force Send', () => {
		seed({}, [
			createMockAITab({ id: 'tab-1', state: 'idle' }),
			createMockAITab({ id: 'tab-2', state: 'busy' }),
		]);
		renderMenu();
		fireEvent.click(row('force'));
		const settings = useModalStore.getState().modals.get('settings');
		expect(settings?.open).toBe(true);
		expect(settings?.data).toEqual({ tab: 'general', settingId: 'general-forced-parallel' });
	});

	it('force-sends when only another tab works and Forced Parallel is on', () => {
		useSettingsStore.setState({ forcedParallelExecution: true });
		seed({}, [
			createMockAITab({ id: 'tab-1', state: 'idle' }),
			createMockAITab({ id: 'tab-2', state: 'busy' }),
		]);
		const force = vi.fn();
		window.addEventListener(FORCED_PARALLEL_SEND_EVENT, force);
		renderMenu();
		fireEvent.click(row('force'));
		expect(force).toHaveBeenCalledTimes(1);
		window.removeEventListener(FORCED_PARALLEL_SEND_EVENT, force);
	});

	it('offers a feature request in the Steer help for a harness that cannot steer', () => {
		seed({ toolType: 'opencode' });
		renderMenu();
		expect(row('steer').getAttribute('aria-disabled')).toBe('true');
		fireEvent.click(screen.getByLabelText('How steering works on this agent'));
		expect(screen.getByTestId('steer-help')).toHaveTextContent('unavailable for OpenCode');
		fireEvent.click(screen.getByText('Open a feature request'));
		expect(openUrlMock).toHaveBeenCalledWith(expect.stringContaining('issues/new'));
	});

	it('offers agent settings in the Steer help for Codex on exec', () => {
		seed({ toolType: 'codex' });
		renderMenu();
		fireEvent.click(screen.getByLabelText('How steering works on this agent'));
		expect(screen.getByTestId('steer-help')).toHaveTextContent('exec transport');
		expect(screen.getByText('Open agent settings')).toBeInTheDocument();
		expect(screen.queryByText('Open a feature request')).not.toBeInTheDocument();
	});

	it('orders the rows Queue, Force Send, Steer, Queue Held', () => {
		seed();
		renderMenu();
		const order = Array.from(document.querySelectorAll('[data-send-menu-row]')).map((el) =>
			el.getAttribute('data-send-menu-row')
		);
		expect(order).toEqual(['queue', 'force', 'steer', 'hold']);
	});

	it('puts the Steer help button left of the Steer hotkey', () => {
		seed();
		renderMenu();
		const rowEl = row('steer').parentElement!;
		const help = screen.getByLabelText('How steering works on this agent');
		const hint = rowEl.querySelector('[data-shortcut-hint]')!;
		expect(help.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('turns the menu off from its own toggle', () => {
		seed();
		renderMenu();
		fireEvent.click(screen.getByLabelText('Show this menu on click'));
		expect(useSettingsStore.getState().sendButtonMenu).toBe(false);
	});
});
