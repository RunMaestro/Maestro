/**
 * Tests for ShellCommandCard - the transcript card for a command-mode
 * (`!command`) run.
 *
 * Driven entirely by the anchoring LogEntry, so the tests build entries in each
 * state (running, exit 0, non-zero exit, stopped, truncated) and assert what the
 * card shows.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Convert from 'ansi-to-html';
import { ShellCommandCard } from '../../../renderer/components/ShellCommandCard';
import { mockTheme } from '../../helpers/mockTheme';
import type { LogEntry } from '../../../renderer/types';

const safeClipboardWrite = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: (text: string) => safeClipboardWrite(text),
}));
vi.mock('../../../renderer/utils/flashCopiedToClipboard', () => ({
	flashCopiedToClipboard: vi.fn(),
}));

const cancelShellCommand = vi.fn().mockResolvedValue(true);
vi.mock('../../../renderer/services/shellCommand', () => ({
	cancelShellCommand: (id: string) => cancelShellCommand(id),
}));

const converter = new Convert();

function makeLog(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		id: 'log-1',
		timestamp: 0,
		source: 'stdout',
		text: '',
		shellCommand: {
			command: 'git status',
			cwd: '/repo',
			status: 'running',
			...(overrides.shellCommand ?? {}),
		},
		...overrides,
	};
}

function renderCard(log: LogEntry) {
	return render(
		<ShellCommandCard
			log={log}
			theme={mockTheme}
			fontFamily="monospace"
			ansiConverter={converter}
		/>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('ShellCommandCard', () => {
	it('renders nothing for an entry without a shellCommand record', () => {
		const { container } = renderCard({
			id: 'x',
			timestamp: 0,
			source: 'stdout',
			text: 'hi',
		});
		expect(container.firstChild).toBeNull();
	});

	it('shows the command and a Stop button while running', () => {
		renderCard(makeLog());

		expect(screen.getByText('git status')).toBeTruthy();
		expect(screen.getByText('Stop')).toBeTruthy();
		expect(screen.getByText('Running...')).toBeTruthy();
	});

	it('stops the run when Stop is clicked', () => {
		renderCard(makeLog());

		fireEvent.click(screen.getByText('Stop'));

		expect(cancelShellCommand).toHaveBeenCalledWith('log-1');
	});

	it('acknowledges the press immediately instead of looking inert', () => {
		// The kill is SIGTERM-then-SIGKILL, so a stubborn process can take up to
		// the escalation window to die. An unchanged button in that gap reads as
		// "my click did nothing" - which is exactly how the original bug felt.
		renderCard(makeLog());

		fireEvent.click(screen.getByText('Stop'));

		expect(screen.getByText('Stopping')).toBeTruthy();
		expect(screen.queryByText('Stop')).toBeNull();
	});

	it('does not fire a second kill while one is already in flight', () => {
		renderCard(makeLog());

		const button = screen.getByText('Stop').closest('button')!;
		fireEvent.click(button);
		fireEvent.click(button);

		expect(cancelShellCommand).toHaveBeenCalledTimes(1);
	});

	it('renders output as terminal text', () => {
		const { container } = renderCard(makeLog({ text: 'M  src/app.ts\n?? notes.md\n' }));

		expect(container.textContent).toContain('M  src/app.ts');
		expect(container.textContent).toContain('?? notes.md');
	});

	describe('ANSI colour', () => {
		const COLOURED = '\u001b[1m\u001b[36mnode_modules\u001b[0m tailwind.config.mjs\n';

		it('converts escape codes to colour instead of showing them literally', () => {
			const { container } = renderCard(makeLog({ text: COLOURED }));

			// The text survives...
			expect(container.textContent).toContain('node_modules');
			expect(container.textContent).toContain('tailwind.config.mjs');
			// ...but the codes do not leak through as visible junk, which is what
			// happened when this output was rendered as markdown instead.
			expect(container.textContent).not.toContain('[1m');
			expect(container.textContent).not.toContain('[36m');
			expect(container.textContent).not.toContain('[0m');
			// Colour is carried as real markup.
			expect(container.innerHTML).toContain('<span');
		});

		it('copies clean text, not escape codes', async () => {
			renderCard(makeLog({ text: COLOURED }));

			fireEvent.click(screen.getByTitle('Copy output'));
			await Promise.resolve();

			const copied = safeClipboardWrite.mock.calls[0]?.[0] as string;
			expect(copied).toContain('node_modules');
			expect(copied).not.toContain('\u001b');
			expect(copied).not.toContain('[36m');
		});
	});

	it('shows the exit code and duration once finished', () => {
		renderCard(
			makeLog({
				text: 'done\n',
				shellCommand: {
					command: 'git status',
					cwd: '/repo',
					status: 'finished',
					exitCode: 0,
					durationMs: 1500,
				},
			})
		);

		expect(screen.getByText(/exit 0/)).toBeTruthy();
		expect(screen.queryByText('Stop')).toBeNull();
	});

	it('shows a non-zero exit code', () => {
		renderCard(
			makeLog({
				text: 'command not found\n',
				shellCommand: {
					command: 'nope',
					cwd: '/repo',
					status: 'finished',
					exitCode: 127,
				},
			})
		);

		expect(screen.getByText(/exit 127/)).toBeTruthy();
	});

	it('shows a stopped run as stopped, not as an exit code', () => {
		renderCard(
			makeLog({
				text: 'partial\n',
				shellCommand: {
					command: 'tail -f log',
					cwd: '/repo',
					status: 'cancelled',
					exitCode: 143,
				},
			})
		);

		expect(screen.getByText('stopped')).toBeTruthy();
		expect(screen.queryByText(/exit 143/)).toBeNull();
	});

	it('notes truncated output', () => {
		renderCard(
			makeLog({
				text: 'lots of output',
				shellCommand: {
					command: 'yes',
					cwd: '/repo',
					status: 'finished',
					exitCode: 0,
					truncated: true,
				},
			})
		);

		expect(screen.getByText(/Output truncated/)).toBeTruthy();
	});

	it('shows the SSH remote name when the agent runs remotely', () => {
		renderCard(
			makeLog({
				shellCommand: {
					command: 'uname -a',
					cwd: '/srv/app',
					remoteName: 'builder',
					status: 'running',
				},
			})
		);

		expect(screen.getByText(/builder:/)).toBeTruthy();
	});

	it('reports no output for a command that printed nothing', () => {
		renderCard(
			makeLog({
				shellCommand: {
					command: 'true',
					cwd: '/repo',
					status: 'finished',
					exitCode: 0,
				},
			})
		);

		expect(screen.getByText('No output')).toBeTruthy();
	});
});
