/**
 * Design Mode - click an element in a browser tab and hand it to the agent.
 *
 * Three halves live here, all pure so they can be tested without a webview:
 *
 *  1. The guest picker script injected into the browser tab's page. It draws a
 *     hover outline, swallows the page's own pointer handling while armed, and
 *     reports the picked element over `console.log`, the same channel the
 *     scroll and shortcut injections in BrowserTabView already use.
 *  2. The host-side parser for those console messages. The page is untrusted,
 *     so every field is type-checked and length-capped before it is used.
 *  3. The payload assembler: the crop rect for the screenshot and the prompt
 *     text dropped into the agent's composer.
 *
 * The picker listens on `window` at capture and re-attaches its outline
 * whenever the page's own rendering removes it, which is what lets it survive
 * an SPA re-rendering the subtree under the cursor.
 */

/** Prefix every picker console message carries. */
export const DESIGN_MODE_MESSAGE_PREFIX = '__MAESTRO_DESIGN__';

/** Longest `outerHTML` the guest reports; anything past it is cut with a marker. */
export const DESIGN_MODE_MAX_HTML_CHARS = 6000;

/**
 * Computed style properties a developer usually cares about when restyling an
 * element. The guest reads exactly these; `filterDesignStyles` then drops the
 * ones still at an uninformative default.
 */
export const DESIGN_MODE_STYLE_PROPERTIES = [
	'display',
	'position',
	'top',
	'right',
	'bottom',
	'left',
	'z-index',
	'box-sizing',
	'width',
	'height',
	'margin',
	'padding',
	'border-width',
	'border-style',
	'border-color',
	'border-radius',
	'color',
	'background-color',
	'background-image',
	'font-family',
	'font-size',
	'font-weight',
	'line-height',
	'letter-spacing',
	'text-align',
	'text-transform',
	'text-decoration-line',
	'white-space',
	'opacity',
	'box-shadow',
	'overflow',
	'flex-direction',
	'flex-wrap',
	'justify-content',
	'align-items',
	'gap',
	'grid-template-columns',
	'cursor',
] as const;

const UNINFORMATIVE_STYLE_VALUES = new Set([
	'',
	'none',
	'normal',
	'auto',
	'0px',
	'rgba(0, 0, 0, 0)',
	'transparent',
]);

const OFFSET_PROPERTIES = new Set(['top', 'right', 'bottom', 'left', 'z-index']);
const BORDER_DETAIL_PROPERTIES = new Set(['border-width', 'border-color']);

/** One element the user picked, as reported by the guest. */
export interface DesignModePick {
	/** Page URL at the time of the pick. */
	url: string;
	/** Lowercase tag name, e.g. `button`. */
	tagName: string;
	/** A CSS selector path that should find this element again. */
	selector: string;
	/** `outerHTML`, already capped at {@link DESIGN_MODE_MAX_HTML_CHARS}. */
	html: string;
	/** Whether `html` was cut short. */
	htmlTruncated: boolean;
	/** The curated computed styles, unfiltered. */
	styles: Record<string, string>;
	/** Bounding box in the guest viewport, CSS pixels. */
	rect: { x: number; y: number; width: number; height: number };
	/** The guest viewport size, CSS pixels. */
	viewport: { width: number; height: number };
}

export type DesignModeEvent = { type: 'pick'; pick: DesignModePick } | { type: 'cancel' };

/**
 * Guest script that arms the picker. Idempotent: a second injection re-arms
 * the existing picker instead of stacking listeners.
 */
export const DESIGN_MODE_ARM_SCRIPT = `(function(){
	if(window.__maestroDesignPicker){window.__maestroDesignPicker.arm();return;}
	var PREFIX=${JSON.stringify(DESIGN_MODE_MESSAGE_PREFIX)};
	var MAX_HTML=${DESIGN_MODE_MAX_HTML_CHARS};
	var PROPS=${JSON.stringify(DESIGN_MODE_STYLE_PROPERTIES)};
	var armed=false,current=null,box=null,label=null;
	var raf=window.requestAnimationFrame?window.requestAnimationFrame.bind(window):function(f){return setTimeout(f,16);};
	function post(o){console.log(PREFIX+JSON.stringify(o));}
	function own(el){return !!(el&&el.closest&&el.closest('[data-maestro-design]'));}
	function make(css){var d=document.createElement('div');d.setAttribute('data-maestro-design','');d.style.cssText=css;return d;}
	function ensure(){
		var root=document.documentElement;if(!root)return;
		if(!box){box=make('position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:2px solid #4f8cff;background:rgba(79,140,255,0.15);border-radius:2px;display:none;');}
		if(!label){label=make('position:fixed;pointer-events:none;z-index:2147483647;padding:2px 6px;border-radius:3px;background:#1f2937;color:#fff;font:11px/16px ui-monospace,Menlo,monospace;white-space:nowrap;display:none;');}
		if(!box.isConnected)root.appendChild(box);
		if(!label.isConnected)root.appendChild(label);
	}
	function hide(){if(box)box.style.display='none';if(label)label.style.display='none';}
	function describe(el){
		var s=el.tagName.toLowerCase();
		if(el.id)s+='#'+el.id;
		var c=typeof el.className==='string'?el.className.trim().split(/\\s+/).filter(Boolean).slice(0,2):[];
		if(c.length)s+='.'+c.join('.');
		return s;
	}
	function place(el){
		if(!el||!el.getBoundingClientRect)return;
		ensure();if(!box)return;
		var r=el.getBoundingClientRect();
		box.style.left=r.left+'px';box.style.top=r.top+'px';
		box.style.width=r.width+'px';box.style.height=r.height+'px';
		box.style.display='block';
		label.textContent=describe(el)+'  '+Math.round(r.width)+' x '+Math.round(r.height);
		label.style.left=Math.max(0,r.left)+'px';
		label.style.top=(r.top>20?r.top-20:r.bottom+2)+'px';
		label.style.display='block';
	}
	function esc(v){return window.CSS&&CSS.escape?CSS.escape(v):String(v).replace(/[^a-zA-Z0-9_-]/g,'\\\\$&');}
	function selectorFor(el){
		var parts=[];var node=el;
		while(node&&node.nodeType===1&&parts.length<8){
			var tag=node.tagName.toLowerCase();
			if(node.id){parts.unshift(tag+'#'+esc(node.id));break;}
			if(tag==='html'||tag==='body'){parts.unshift(tag);break;}
			var part=tag;
			var c=typeof node.className==='string'?node.className.trim().split(/\\s+/).filter(Boolean).slice(0,2):[];
			if(c.length)part+='.'+c.map(esc).join('.');
			var parent=node.parentElement;
			if(parent){
				var same=0,index=0;
				for(var i=0;i<parent.children.length;i++){
					var sib=parent.children[i];
					if(sib.tagName===node.tagName){same++;if(sib===node)index=same;}
				}
				if(same>1)part+=':nth-of-type('+index+')';
			}
			parts.unshift(part);
			node=parent;
		}
		return parts.join(' > ');
	}
	function collect(el){
		var cs=window.getComputedStyle(el);var styles={};
		for(var i=0;i<PROPS.length;i++){styles[PROPS[i]]=cs.getPropertyValue(PROPS[i]);}
		var html=el.outerHTML||'';var cut=html.length>MAX_HTML;
		var r=el.getBoundingClientRect();
		return {url:location.href,tagName:el.tagName.toLowerCase(),selector:selectorFor(el),
			html:cut?html.slice(0,MAX_HTML):html,htmlTruncated:cut,styles:styles,
			rect:{x:r.left,y:r.top,width:r.width,height:r.height},
			viewport:{width:window.innerWidth,height:window.innerHeight}};
	}
	function swallow(e){e.preventDefault();e.stopImmediatePropagation();}
	function onMove(e){
		if(!armed)return;
		var el=e.target;
		if(!el||el.nodeType!==1||own(el))return;
		current=el;place(el);
	}
	function onScroll(){if(armed&&current)place(current);}
	function pick(el){
		if(!el)return;
		var payload=collect(el);
		disarm();
		raf(function(){raf(function(){post({type:'pick',pick:payload});});});
	}
	function onPointer(e){if(!armed)return;swallow(e);}
	function onClick(e){
		if(!armed)return;swallow(e);
		var el=current||(e.target&&e.target.nodeType===1&&!own(e.target)?e.target:null);
		pick(el);
	}
	function onKey(e){
		if(!armed)return;
		if(e.key==='Escape'){swallow(e);disarm();post({type:'cancel'});}
		else if(e.key==='Enter'&&current){swallow(e);pick(current);}
		else if(e.key==='ArrowUp'&&current&&current.parentElement&&current.parentElement!==document.documentElement){
			swallow(e);current=current.parentElement;place(current);
		}
	}
	function arm(){armed=true;ensure();if(current)place(current);}
	function disarm(){armed=false;current=null;hide();}
	window.addEventListener('mousemove',onMove,true);
	window.addEventListener('scroll',onScroll,true);
	['pointerdown','pointerup','mousedown','mouseup','dblclick','contextmenu'].forEach(function(t){window.addEventListener(t,onPointer,true);});
	window.addEventListener('click',onClick,true);
	window.addEventListener('keydown',onKey,true);
	window.__maestroDesignPicker={arm:arm,disarm:disarm};
	arm();
})();`;

/** Guest script that disarms the picker, if one was ever installed. */
export const DESIGN_MODE_DISARM_SCRIPT =
	'(function(){if(window.__maestroDesignPicker)window.__maestroDesignPicker.disarm();})();';

const MAX_SHORT_FIELD = 2048;

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value);
}

function readRect(value: unknown): DesignModePick['rect'] | null {
	if (!value || typeof value !== 'object') return null;
	const r = value as Record<string, unknown>;
	if (![r.x, r.y, r.width, r.height].every(isFiniteNumber)) return null;
	return {
		x: r.x as number,
		y: r.y as number,
		width: r.width as number,
		height: r.height as number,
	};
}

function readViewport(value: unknown): DesignModePick['viewport'] | null {
	if (!value || typeof value !== 'object') return null;
	const v = value as Record<string, unknown>;
	if (!isFiniteNumber(v.width) || !isFiniteNumber(v.height)) return null;
	return { width: v.width, height: v.height };
}

function readStyles(value: unknown): Record<string, string> {
	const styles: Record<string, string> = {};
	if (!value || typeof value !== 'object') return styles;
	const raw = value as Record<string, unknown>;
	for (const prop of DESIGN_MODE_STYLE_PROPERTIES) {
		const v = raw[prop];
		if (typeof v === 'string') styles[prop] = v.slice(0, MAX_SHORT_FIELD);
	}
	return styles;
}

/**
 * Parse a guest console message. Returns null for anything that is not a
 * well-formed picker message, including every ordinary page log line.
 */
export function parseDesignModeMessage(message: unknown): DesignModeEvent | null {
	if (typeof message !== 'string' || !message.startsWith(DESIGN_MODE_MESSAGE_PREFIX)) return null;
	let data: unknown;
	try {
		data = JSON.parse(message.slice(DESIGN_MODE_MESSAGE_PREFIX.length));
	} catch {
		return null;
	}
	if (!data || typeof data !== 'object') return null;
	const { type, pick } = data as { type?: unknown; pick?: unknown };
	if (type === 'cancel') return { type: 'cancel' };
	if (type !== 'pick' || !pick || typeof pick !== 'object') return null;

	const p = pick as Record<string, unknown>;
	const rect = readRect(p.rect);
	const viewport = readViewport(p.viewport);
	if (!rect || !viewport) return null;
	if (typeof p.tagName !== 'string' || typeof p.selector !== 'string') return null;
	if (typeof p.html !== 'string') return null;

	return {
		type: 'pick',
		pick: {
			url: typeof p.url === 'string' ? p.url.slice(0, MAX_SHORT_FIELD) : '',
			tagName: p.tagName.slice(0, 64),
			selector: p.selector.slice(0, MAX_SHORT_FIELD),
			html: p.html.slice(0, DESIGN_MODE_MAX_HTML_CHARS),
			htmlTruncated: p.htmlTruncated === true || p.html.length > DESIGN_MODE_MAX_HTML_CHARS,
			styles: readStyles(p.styles),
			rect,
			viewport,
		},
	};
}

/**
 * Drop computed styles that are still at an uninformative default, so the
 * prompt lists what makes this element look the way it does rather than forty
 * lines of `none` and `normal`. Offsets only matter for positioned elements,
 * and border detail only matters when there is a border.
 */
export function filterDesignStyles(styles: Record<string, string>): Array<[string, string]> {
	const positioned = !!styles.position && styles.position !== 'static';
	const bordered = !!styles['border-style'] && styles['border-style'] !== 'none';
	const result: Array<[string, string]> = [];
	for (const prop of DESIGN_MODE_STYLE_PROPERTIES) {
		const value = (styles[prop] ?? '').trim();
		if (UNINFORMATIVE_STYLE_VALUES.has(value)) continue;
		if (prop === 'position' && value === 'static') continue;
		if (OFFSET_PROPERTIES.has(prop) && !positioned) continue;
		if (BORDER_DETAIL_PROPERTIES.has(prop) && !bordered) continue;
		result.push([prop, value]);
	}
	return result;
}

/**
 * The window-space rect to screenshot for a pick, or null when no part of the
 * element is on screen.
 *
 * The guest reports its box in its own CSS pixels; the host converts by the
 * guest's zoom factor and offsets by where the webview sits in the window.
 * The box is clipped to the visible webview area, because a capture of the
 * window can only see what is painted there. Device pixel ratio needs no
 * handling here: the capture handler works in window DIPs and Electron returns
 * the bitmap at the display's scale.
 */
export function designPickCaptureRect(
	pick: Pick<DesignModePick, 'rect'>,
	webviewRect: { left: number; top: number; width: number; height: number },
	guestZoom = 1
): { x: number; y: number; width: number; height: number } | null {
	const zoom = isFiniteNumber(guestZoom) && guestZoom > 0 ? guestZoom : 1;
	const left = Math.max(webviewRect.left, webviewRect.left + pick.rect.x * zoom);
	const top = Math.max(webviewRect.top, webviewRect.top + pick.rect.y * zoom);
	const right = Math.min(
		webviewRect.left + webviewRect.width,
		webviewRect.left + (pick.rect.x + pick.rect.width) * zoom
	);
	const bottom = Math.min(
		webviewRect.top + webviewRect.height,
		webviewRect.top + (pick.rect.y + pick.rect.height) * zoom
	);
	if (right - left < 1 || bottom - top < 1) return null;
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/** A code fence longer than any backtick run inside `content`. */
function fenceFor(content: string): string {
	const longest = (content.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
	return '`'.repeat(Math.max(3, longest + 1));
}

/** Whether the pick is only partly on screen, so the screenshot is a crop. */
function isPartlyOffscreen(pick: DesignModePick): boolean {
	const { rect, viewport } = pick;
	return (
		rect.x < 0 ||
		rect.y < 0 ||
		rect.x + rect.width > viewport.width ||
		rect.y + rect.height > viewport.height
	);
}

/** The prompt text dropped into the composer for one pick. */
export function buildDesignModePrompt(
	pick: DesignModePick,
	options: { hasScreenshot: boolean }
): string {
	const lines: string[] = [];
	lines.push(`Design Mode: I picked this element${pick.url ? ` on ${pick.url}` : ''}.`);
	lines.push('');
	lines.push(`Selector: \`${pick.selector || pick.tagName}\``);
	lines.push(
		`Size: ${Math.round(pick.rect.width)} x ${Math.round(pick.rect.height)} px at (${Math.round(
			pick.rect.x
		)}, ${Math.round(pick.rect.y)}) in a ${Math.round(pick.viewport.width)} x ${Math.round(
			pick.viewport.height
		)} viewport`
	);

	const styles = filterDesignStyles(pick.styles);
	if (styles.length > 0) {
		lines.push('');
		lines.push('Computed styles:');
		for (const [prop, value] of styles) lines.push(`- ${prop}: ${value}`);
	}

	const html = pick.htmlTruncated ? `${pick.html}\n<!-- truncated -->` : pick.html;
	const fence = fenceFor(html);
	lines.push('');
	lines.push('HTML:');
	lines.push(`${fence}html`);
	lines.push(html);
	lines.push(fence);

	if (options.hasScreenshot) {
		lines.push('');
		lines.push(
			isPartlyOffscreen(pick)
				? 'A screenshot of the visible part of the element is attached.'
				: 'A screenshot of the element is attached.'
		);
	}
	return lines.join('\n');
}
