/**
 * Maestro's controls inside the Sketch Book canvas (SketchCanvasChrome):
 * Collaborate at the top right, with the agent working pill beside it while
 * an agent works on the sketch; the screening badge at the footer center and
 * Library in the footer beside Help.
 */

import type { ComponentProps, ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
	SketchFooter,
	SketchTopRightUI,
	type SketchCanvasChrome,
} from '../../../../renderer/components/SketchBook/SketchCanvasChrome';

const FakeFooter = (({ children }: { children?: ReactNode }) => (
	<footer data-testid="excalidraw-footer">{children}</footer>
)) as unknown as ComponentProps<typeof SketchFooter>['Footer'];

const FakeSidebar = {
	Trigger: ({
		name,
		tab,
		title,
		className,
		children,
	}: {
		name: string;
		tab?: string;
		title?: string;
		className?: string;
		children?: ReactNode;
	}) => (
		<label
			data-testid="sidebar-trigger"
			data-name={name}
			data-tab={tab}
			title={title}
			className={className}
		>
			{children}
		</label>
	),
} as unknown as ComponentProps<typeof SketchFooter>['Sidebar'];

function chromeWith(overrides: Partial<SketchCanvasChrome> = {}): SketchCanvasChrome {
	return {
		collaborate: { open: false, live: false, shortcut: '⌘ ⇧ C', onToggle: vi.fn() },
		working: null,
		...overrides,
	};
}

describe('SketchTopRightUI', () => {
	it('shows Collaborate with its chord in the title', () => {
		const chrome = chromeWith();
		render(<SketchTopRightUI chrome={chrome} />);

		const collaborate = screen.getByTestId('sketch-collaborate-button');
		expect(collaborate.textContent).toBe('Collaborate');
		expect(collaborate.getAttribute('title')).toBe('Collaborate (⌘ ⇧ C)');
		expect(collaborate.getAttribute('aria-pressed')).toBe('false');
		expect(collaborate.className).not.toMatch(/\bactive\b/);
		expect(collaborate.className).not.toMatch(/\bsketch-chrome-button--live\b/);
		expect(screen.getAllByRole('button')).toHaveLength(1);

		fireEvent.click(collaborate);
		expect(chrome.collaborate.onToggle).toHaveBeenCalledTimes(1);
	});

	it('titles Collaborate without a chord when it is unbound', () => {
		render(
			<SketchTopRightUI
				chrome={chromeWith({
					collaborate: { open: false, live: false, shortcut: '', onToggle: vi.fn() },
				})}
			/>
		);

		expect(screen.getByTestId('sketch-collaborate-button').getAttribute('title')).toBe(
			'Collaborate'
		);
	});

	it('marks a live room green without pressing Collaborate while its panel is shut', () => {
		render(
			<SketchTopRightUI
				chrome={chromeWith({
					collaborate: { open: false, live: true, shortcut: '', onToggle: vi.fn() },
				})}
			/>
		);

		const collaborate = screen.getByTestId('sketch-collaborate-button');
		expect(collaborate.className).toMatch(/\bsketch-chrome-button--live\b/);
		expect(collaborate.className).not.toMatch(/\bactive\b/);
		expect(collaborate.getAttribute('aria-pressed')).toBe('false');
	});

	it('marks Collaborate active while its panel is open', () => {
		render(
			<SketchTopRightUI
				chrome={chromeWith({
					collaborate: { open: true, live: true, shortcut: '⌘ ⇧ C', onToggle: vi.fn() },
				})}
			/>
		);

		const collaborate = screen.getByTestId('sketch-collaborate-button');
		expect(collaborate.className).toMatch(/\bactive\b/);
		expect(collaborate.getAttribute('aria-pressed')).toBe('true');
	});

	it('shows no working pill while no agent works on the sketch', () => {
		render(<SketchTopRightUI chrome={chromeWith()} />);
		expect(screen.queryByTestId('sketch-agent-working')).toBeNull();
	});

	it('shows the working pill before Collaborate as a status, not a control', () => {
		render(<SketchTopRightUI chrome={chromeWith({ working: 'Ada is drawing' })} />);

		const pill = screen.getByTestId('sketch-agent-working');
		expect(pill.getAttribute('role')).toBe('status');
		expect(pill.textContent).toBe('Ada is drawing');
		expect(pill.nextElementSibling).toBe(screen.getByTestId('sketch-collaborate-button'));
		expect(screen.getAllByRole('button')).toHaveLength(1);
	});
});

describe('SketchFooter', () => {
	it('puts a Library trigger for the default sidebar into the footer', () => {
		render(<SketchFooter Footer={FakeFooter} Sidebar={FakeSidebar} badge={null} />);

		const trigger = screen.getByTestId('sidebar-trigger');
		expect(screen.getByTestId('excalidraw-footer').contains(trigger)).toBe(true);
		expect(trigger.dataset.name).toBe('default');
		expect(trigger.dataset.tab).toBe('library');
		expect(trigger.textContent).toBe('Library');
	});

	it('puts the screening badge in the footer center, before Library', () => {
		render(
			<SketchFooter
				Footer={FakeFooter}
				Sidebar={FakeSidebar}
				badge={<span data-testid="screening-badge">Local screening</span>}
			/>
		);

		const badge = screen.getByTestId('screening-badge');
		const center = badge.closest('.sketch-chrome-badge');
		expect(center).toBeTruthy();
		expect(center?.parentElement?.className).toBe('sketch-chrome-footer');
		expect(center?.nextElementSibling).toBe(screen.getByTestId('sidebar-trigger'));
	});
});
