/**
 * Tests for resolveImageFromEvent - the filter that decides whether a
 * right-click landed on a real image.
 *
 * This is the whole reason one delegated listener can replace per-surface
 * wiring, so the cases that must NOT open a menu matter more than the ones that
 * must: the app is full of lucide `<svg>` icons and 16px favicons, and offering
 * "Copy Image" on those would make the menu useless everywhere.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
	ImageContextMenuHost,
	resolveImageFromEvent,
} from '../../../renderer/components/ImageContextMenuHost';
import { saveImageToProject } from '../../../renderer/utils/imageExport';
import { THEMES } from '../../../renderer/constants/themes';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';

let activeSession: { id: string; projectRoot: string; sshRemoteId?: string } | null = null;

vi.mock('../../../renderer/hooks/session/useActiveSession', () => ({
	useActiveSession: () => activeSession,
}));

vi.mock('../../../renderer/utils/imageExport', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/utils/imageExport')>()),
	saveImageToProject: vi.fn().mockResolvedValue({
		path: '/proj-a/.maestro/diagrams/d.svg',
		relativePath: '.maestro/diagrams/d.svg',
	}),
}));

/** Build an element with a stubbed layout box, since jsdom has no layout engine. */
function withSize<T extends Element>(el: T, width: number, height: number): T {
	el.getBoundingClientRect = () =>
		({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0 }) as DOMRect;
	return el;
}

function rightClickOn(target: Element): MouseEvent {
	const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'target', { value: target, configurable: true });
	return event;
}

describe('resolveImageFromEvent', () => {
	afterEach(() => {
		document.body.replaceChildren();
	});

	it('resolves a content-sized <img>', () => {
		const img = withSize(document.createElement('img'), 400, 300);
		document.body.appendChild(img);
		expect(resolveImageFromEvent(rightClickOn(img))).toBe(img);
	});

	it('resolves an inline <svg> diagram', () => {
		const svg = withSize(document.createElementNS('http://www.w3.org/2000/svg', 'svg'), 600, 400);
		document.body.appendChild(svg);
		expect(resolveImageFromEvent(rightClickOn(svg))).toBe(svg);
	});

	it('resolves the image from a click on a child node', () => {
		// Mermaid diagrams are a tree of <path>/<g> - the click lands on a leaf.
		const svg = withSize(document.createElementNS('http://www.w3.org/2000/svg', 'svg'), 600, 400);
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		svg.appendChild(path);
		document.body.appendChild(svg);
		expect(resolveImageFromEvent(rightClickOn(path))).toBe(svg);
	});

	it('ignores lucide icons, which are <svg> but not images', () => {
		const icon = withSize(document.createElementNS('http://www.w3.org/2000/svg', 'svg'), 200, 200);
		icon.setAttribute('class', 'lucide lucide-copy w-3.5 h-3.5');
		document.body.appendChild(icon);
		// Sized well above the floor on purpose: the class is what disqualifies it.
		expect(resolveImageFromEvent(rightClickOn(icon))).toBeNull();
	});

	it('ignores favicon-sized images', () => {
		const favicon = withSize(document.createElement('img'), 16, 16);
		document.body.appendChild(favicon);
		expect(resolveImageFromEvent(rightClickOn(favicon))).toBeNull();
	});

	it('ignores images inside a [data-no-image-menu] subtree', () => {
		const host = document.createElement('div');
		host.setAttribute('data-no-image-menu', '');
		const img = withSize(document.createElement('img'), 400, 300);
		host.appendChild(img);
		document.body.appendChild(host);
		expect(resolveImageFromEvent(rightClickOn(img))).toBeNull();
	});

	it('returns null for a right-click on ordinary text', () => {
		const p = document.createElement('p');
		p.textContent = 'no image here';
		document.body.appendChild(p);
		expect(resolveImageFromEvent(rightClickOn(p))).toBeNull();
	});
});

describe('ImageContextMenuHost save destination', () => {
	/** Images live in their own node so RTL's cleanup owns its container alone. */
	let imageHost: HTMLDivElement;

	beforeEach(() => {
		vi.mocked(saveImageToProject).mockClear();
		activeSession = { id: 'a', projectRoot: '/proj-a', sshRemoteId: 'host-a' };
		imageHost = document.createElement('div');
		document.body.appendChild(imageHost);
	});

	afterEach(() => {
		imageHost.remove();
	});

	const renderHost = () =>
		render(
			<LayerStackProvider>
				<ImageContextMenuHost theme={THEMES.dracula} />
			</LayerStackProvider>
		);

	it('saves into the project the image was right-clicked in, even after the agent switches', async () => {
		const { rerender } = renderHost();

		const img = withSize(document.createElement('img'), 400, 300);
		imageHost.appendChild(img);
		fireEvent.contextMenu(img);

		fireEvent.click(await screen.findByText('Save to Project...'));
		expect(await screen.findByText('Save image to project')).toBeInTheDocument();

		// The user switches agents while the destination modal is still open.
		activeSession = { id: 'b', projectRoot: '/proj-b', sshRemoteId: 'host-b' };
		rerender(
			<LayerStackProvider>
				<ImageContextMenuHost theme={THEMES.dracula} />
			</LayerStackProvider>
		);

		fireEvent.click(screen.getByText('Save'));

		await waitFor(() => expect(saveImageToProject).toHaveBeenCalled());
		// Project A, not the agent that happens to be active now.
		expect(vi.mocked(saveImageToProject).mock.calls[0][1]).toMatchObject({
			projectRoot: '/proj-a',
			sshRemoteId: 'host-a',
		});
	});

	it('offers no project save when there is no active project', async () => {
		activeSession = null;
		renderHost();

		const img = withSize(document.createElement('img'), 400, 300);
		imageHost.appendChild(img);
		fireEvent.contextMenu(img);

		expect(await screen.findByText('Copy Image')).toBeInTheDocument();
		expect(screen.queryByText('Save to Project...')).not.toBeInTheDocument();
	});
});
