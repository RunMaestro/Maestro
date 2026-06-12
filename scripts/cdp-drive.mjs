// Faithful UI driver over CDP. Usage: node scripts/cdp-drive.mjs '<json actions>'
// Actions (array, run in order):
//   {a:"eval", expr:"...returns JSON"}              -> Runtime.evaluate, returns value
//   {a:"clickSel", sel:"...", index:0, all:false}   -> real mouse click at element center
//   {a:"focusSel", sel:"...", index:0}              -> focus element (returns rect)
//   {a:"type", text:"..."}                           -> Input.insertText into focused node
//   {a:"key", key:"Enter", mods:0}                   -> dispatch keyDown+keyUp via Input domain
//   {a:"sleep", ms:500}
// Prints a JSON array of per-action results.
import WebSocket from 'ws';

const PORT = process.env.MAESTRO_CDP_PORT || '12345';
const actions = JSON.parse(process.argv[2] || '[]');

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) {
	console.error('no page target');
	process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl, {
	perMessageDeflate: false,
	maxPayload: 200 * 1024 * 1024,
});
let id = 0;
const pending = new Map();
function send(method, params) {
	return new Promise((resolve) => {
		const msgId = ++id;
		pending.set(msgId, resolve);
		ws.send(JSON.stringify({ id: msgId, method, params }));
	});
}
ws.on('message', (data) => {
	const msg = JSON.parse(data.toString());
	if (msg.id && pending.has(msg.id)) {
		pending.get(msg.id)(msg);
		pending.delete(msg.id);
	}
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalExpr(expr) {
	const res = await send('Runtime.evaluate', {
		expression: `(async () => { ${expr} })()`,
		awaitPromise: true,
		returnByValue: true,
		allowUnsafeEvalBlockedByCSP: true,
	});
	if (res.result?.exceptionDetails)
		return { error: res.result.exceptionDetails.exception?.description || 'exception' };
	return res.result?.result?.value;
}

// Get element center via a selector + optional index/all flag
async function rectOf(sel, index = 0, all = false) {
	const expr = all
		? `const els=[...document.querySelectorAll(${JSON.stringify(sel)})]; const e=els[${index}]; if(!e) return null; e.scrollIntoView({block:"center"}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};`
		: `const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return null; e.scrollIntoView({block:"center"}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};`;
	return await evalExpr(expr);
}

ws.on('open', async () => {
	await send('Runtime.enable');
	await send('DOM.enable');
	const results = [];
	for (const act of actions) {
		try {
			if (act.a === 'eval') {
				results.push({ a: 'eval', value: await evalExpr(act.expr) });
			} else if (act.a === 'sleep') {
				await sleep(act.ms || 100);
				results.push({ a: 'sleep', ms: act.ms });
			} else if (act.a === 'focusSel') {
				const r = await rectOf(act.sel, act.index || 0, act.all);
				if (r)
					await evalExpr(
						`const els=[...document.querySelectorAll(${JSON.stringify(act.sel)})]; (els[${act.index || 0}]||document.querySelector(${JSON.stringify(act.sel)}))?.focus(); return true;`
					);
				results.push({ a: 'focusSel', rect: r });
			} else if (act.a === 'clickSel') {
				const r = await rectOf(act.sel, act.index || 0, act.all);
				if (!r) {
					results.push({ a: 'clickSel', sel: act.sel, error: 'not found' });
					continue;
				}
				await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y });
				await send('Input.dispatchMouseEvent', {
					type: 'mousePressed',
					x: r.x,
					y: r.y,
					button: 'left',
					clickCount: 1,
				});
				await send('Input.dispatchMouseEvent', {
					type: 'mouseReleased',
					x: r.x,
					y: r.y,
					button: 'left',
					clickCount: 1,
				});
				results.push({ a: 'clickSel', sel: act.sel, at: r });
			} else if (act.a === 'type') {
				await send('Input.insertText', { text: act.text });
				results.push({ a: 'type', len: act.text.length });
			} else if (act.a === 'key') {
				const keyMap = { Enter: { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13 } };
				const k = keyMap[act.key] || { code: act.key, key: act.key };
				const mods = act.mods || 0;
				await send('Input.dispatchKeyEvent', {
					type: 'keyDown',
					modifiers: mods,
					...k,
					text: act.key === 'Enter' ? '\r' : undefined,
				});
				await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: mods, ...k });
				results.push({ a: 'key', key: act.key });
			}
		} catch (e) {
			results.push({ a: act.a, error: String(e?.message || e) });
		}
	}
	console.log(JSON.stringify(results, null, 2));
	ws.close();
	process.exit(0);
});
ws.on('error', (e) => {
	console.error('ws error', e.message);
	process.exit(1);
});
