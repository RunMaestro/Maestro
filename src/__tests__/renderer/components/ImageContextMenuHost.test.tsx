/**
 * Tests for resolveImageFromEvent - the filter that decides whether a
 * right-click landed on a real image.
 *
 * This is the whole reason one delegated listener can replace per-surface
 * wiring, so the cases that must NOT open a menu matter more than the ones that
 * must: the app is full of lucide `<svg>` icons and 16px favicons, and offering
 * "Copy Image" on those would make the menu useless everywhere.
 */

import { resolveImageFromEvent } from '../../../renderer/components/ImageContextMenuHost';

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
