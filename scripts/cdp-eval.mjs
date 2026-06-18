// Ad-hoc CDP eval helper. Usage: node scripts/cdp-eval.mjs '<js expression>'
// Connects to the dev Electron renderer on MAESTRO_CDP_PORT (default 12345),
// evaluates the expression (await-aware), and prints the JSON result.
import WebSocket from 'ws';

const PORT = process.env.MAESTRO_CDP_PORT || '12345';
const expr = process.argv[2];
if (!expr) {
	console.error('need an expression');
	process.exit(1);
}

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

ws.on('open', async () => {
	await send('Runtime.enable');
	const res = await send('Runtime.evaluate', {
		expression: `(async () => { ${expr} })()`,
		awaitPromise: true,
		returnByValue: true,
		allowUnsafeEvalBlockedByCSP: true,
	});
	if (res.result?.exceptionDetails) {
		console.error('EXCEPTION:', JSON.stringify(res.result.exceptionDetails, null, 2));
	} else if (res.result?.result?.value !== undefined) {
		const v = res.result.result.value;
		console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
	} else {
		console.log(JSON.stringify(res.result, null, 2));
	}
	ws.close();
	process.exit(0);
});

ws.on('error', (e) => {
	console.error('ws error', e.message);
	process.exit(1);
});
