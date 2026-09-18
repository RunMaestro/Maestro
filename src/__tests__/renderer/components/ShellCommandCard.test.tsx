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

// Resolves `true` like the real one: CopyIconButton bails out of its
// copied-checkmark feedback on a falsy result, so a mock returning undefined
// would silently skip that half of the button's behavior.
const safeClipboardWrite = vi.fn().mockResolvedValue(true);
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

function renderCard(log: LogEntry, props: Record<string, unknown> = {}) {
	return render(
		<ShellCommandCard
			log={log}
			theme={mockTheme}
			fontFamily="monospace"
			ansiConverter={converter}
			{...props}
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

	describe('expanding the command line', () => {
		const longCommand =
			"find src -type f \\( -name '*.ts' -o -name '*.tsx' \\) ! -path '*__tests__*' -print0 | xargs -0 wc -l | sort -rn";

		function longCard() {
			return makeLog({
				shellCommand: { command: longCommand, cwd: '/repo', status: 'finished', exitCode: 0 },
			} as never);
		}

		it('truncates the command until the header is clicked', () => {
			// Collapsed by default: the header's job is status at a glance, and a
			// wrapped 100-char find would push the exit code out of view.
			renderCard(longCard());

			expect(screen.getByTestId('shell-command-text').className).toContain('truncate');
			expect(screen.getByTestId('shell-command-toggle').getAttribute('aria-expanded')).toBe(
				'false'
			);
		});

		it('wraps the whole command once expanded', () => {
			renderCard(longCard());

			fireEvent.click(screen.getByTestId('shell-command-toggle'));

			const text = screen.getByTestId('shell-command-text');
			expect(text.className).not.toContain('truncate');
			expect(text.className).toContain('whitespace-pre-wrap');
			expect(text.textContent).toContain(longCommand.slice(0, 40));
		});

		it('collapses again on a second click', () => {
			renderCard(longCard());
			const toggle = screen.getByTestId('shell-command-toggle');

			fireEvent.click(toggle);
			expect(toggle.getAttribute('aria-expanded')).toBe('true');

			fireEvent.click(toggle);
			expect(toggle.getAttribute('aria-expanded')).toBe('false');
			expect(screen.getByTestId('shell-command-text').className).toContain('truncate');
		});

		it('is a real button, so the keyboard can reach it', () => {
			// role="button" on a div announces as a button and then does nothing from
			// the keyboard - a hard failure in a keyboard-first app.
			renderCard(longCard());

			expect(screen.getByTestId('shell-command-toggle').tagName).toBe('BUTTON');
		});

		it('offers a copy-command button only while expanded', () => {
			renderCard(longCard());
			expect(screen.queryByTestId('shell-command-copy-command')).toBeNull();

			fireEvent.click(screen.getByTestId('shell-command-toggle'));

			expect(screen.getByTestId('shell-command-copy-command')).toBeTruthy();
		});

		it('copies the command, not the output', () => {
			renderCard(
				makeLog({
					text: 'the output',
					shellCommand: { command: longCommand, cwd: '/repo', status: 'finished', exitCode: 0 },
				} as never)
			);

			fireEvent.click(screen.getByTestId('shell-command-toggle'));
			fireEvent.click(screen.getByTestId('shell-command-copy-command'));

			expect(safeClipboardWrite).toHaveBeenCalledWith(longCommand);
		});

		it('keeps the output copy button independent of the command one', () => {
			// Two buttons, two payloads. Conflating them is the obvious bug here.
			renderCard(
				makeLog({
					text: 'the output',
					shellCommand: { command: longCommand, cwd: '/repo', status: 'finished', exitCode: 0 },
				} as never)
			);

			fireEvent.click(screen.getByTestId('shell-command-copy-output'));

			expect(safeClipboardWrite).toHaveBeenCalledWith('the output');
		});

		it('copying the command does not collapse it', () => {
			// The copy button sits inside the clickable header; without
			// stopPropagation the click would also toggle the disclosure shut.
			renderCard(longCard());
			fireEvent.click(screen.getByTestId('shell-command-toggle'));

			fireEvent.click(screen.getByTestId('shell-command-copy-command'));

			expect(screen.getByTestId('shell-command-toggle').getAttribute('aria-expanded')).toBe('true');
		});
	});

	describe('the request that generated the command', () => {
		it('shows the plain-English ask above the command', () => {
			// A transcript read weeks later needs the intent to make sense of the
			// flags; the command line alone does not carry it.
			renderCard(
				makeLog({
					shellCommand: {
						command: "find . -newermt '2 days ago' -type f",
						request: 'what files were edited in the past two days',
						status: 'finished',
						exitCode: 0,
					} as never,
				})
			);

			expect(screen.getByTestId('shell-command-request')).toHaveTextContent(
				'what files were edited in the past two days'
			);
		});

		it('shows nothing extra for a command the user typed', () => {
			renderCard(makeLog());

			expect(screen.queryByTestId('shell-command-request')).toBeNull();
		});
	});

	describe('deleting the card', () => {
		const finished = () =>
			makeLog({ text: 'out', shellCommand: { status: 'finished', exitCode: 0 } as never });

		it('offers a delete button once the command has finished', () => {
			renderCard(finished(), { onDelete: vi.fn(), onSetDeleteConfirmLogId: vi.fn() });

			expect(screen.getByTestId('shell-command-delete')).toBeTruthy();
		});

		it('hides delete while the command is still running', () => {
			// Deleting a live card would orphan the process: output would keep
			// streaming into an entry that no longer exists, with no Stop left.
			renderCard(makeLog(), { onDelete: vi.fn(), onSetDeleteConfirmLogId: vi.fn() });

			expect(screen.queryByTestId('shell-command-delete')).toBeNull();
			expect(screen.getByText('Stop')).toBeTruthy();
		});

		it('hides delete entirely when the transcript is not editable', () => {
			renderCard(finished());

			expect(screen.queryByTestId('shell-command-delete')).toBeNull();
		});

		it('arms a confirmation rather than deleting on the first click', () => {
			const onDelete = vi.fn();
			const onSetDeleteConfirmLogId = vi.fn();
			renderCard(finished(), { onDelete, onSetDeleteConfirmLogId });

			fireEvent.click(screen.getByTestId('shell-command-delete'));

			expect(onDelete).not.toHaveBeenCalled();
			expect(onSetDeleteConfirmLogId).toHaveBeenCalledWith('log-1');
		});

		it('deletes on Yes and disarms the confirmation', () => {
			const onDelete = vi.fn();
			const onSetDeleteConfirmLogId = vi.fn();
			renderCard(finished(), {
				onDelete,
				onSetDeleteConfirmLogId,
				deleteConfirmLogId: 'log-1',
			});

			fireEvent.click(screen.getByTestId('shell-command-delete-yes'));

			expect(onDelete).toHaveBeenCalledWith('log-1');
			expect(onSetDeleteConfirmLogId).toHaveBeenCalledWith(null);
		});

		it('backs out on No without deleting', () => {
			const onDelete = vi.fn();
			const onSetDeleteConfirmLogId = vi.fn();
			renderCard(finished(), {
				onDelete,
				onSetDeleteConfirmLogId,
				deleteConfirmLogId: 'log-1',
			});

			fireEvent.click(screen.getByTestId('shell-command-delete-no'));

			expect(onDelete).not.toHaveBeenCalled();
			expect(onSetDeleteConfirmLogId).toHaveBeenCalledWith(null);
		});

		it('only shows the confirmation on the card it was armed for', () => {
			renderCard(finished(), {
				onDelete: vi.fn(),
				onSetDeleteConfirmLogId: vi.fn(),
				deleteConfirmLogId: 'a-different-card',
			});

			expect(screen.queryByTestId('shell-command-delete-confirm')).toBeNull();
			expect(screen.getByTestId('shell-command-delete')).toBeTruthy();
		});
	});

	describe('font', () => {
		it('renders the command and its output in a fixed-pitch stack', () => {
			renderCard(
				makeLog({
					text: 'total 0\n',
					shellCommand: { command: 'ls -l', cwd: '/repo', status: 'exited', exitCode: 0 },
				}),
				{ fontFamily: 'Avenir Next' }
			);

			// The card is a terminal: whatever the user picked for the app chrome,
			// the stack it renders with has to end in a fixed-pitch guarantee or
			// columns of output stop lining up.
			expect(screen.getByTestId('shell-command-text').style.fontFamily).toMatch(/monospace/);
			expect(screen.getByTestId('shell-command-output').style.fontFamily).toMatch(/monospace/);
		});
	});
});
