// Ad-hoc CDP eval helper. Usage: node scripts/cdp-eval.mjs '<js expression>'
// Connects to the dev Electron renderer on MAESTRO_CDP_PORT (default 12345),
// evaluates the expression (await-aware), and prints the JSON result.
import { connectCdp, getCdpTargets, resolveCdpPort } from './lib/cdp.mjs';

const PORT = resolveCdpPort();
const expr = process.argv[2];
if (!expr) {
	console.error('need an expression');
	process.exit(1);
}

const targets = await getCdpTargets({ port: PORT });
const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
if (!page) {
	console.error('no page target');
	process.exit(1);
}

const { ws, send, close } = connectCdp(page.webSocketDebuggerUrl);

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
	close();
	process.exit(0);
});

ws.on('error', (e) => {
	console.error('ws error', e.message);
	process.exit(1);
});
