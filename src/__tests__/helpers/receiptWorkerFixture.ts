import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

/** Real worker/SQLite transport with an isolated credential-store fixture.
 * The checkpoint stays outside the database snapshot and can terminate its worker
 * at the native prepared/stable boundaries. Never touches the OS credential store. */
export async function receiptWorkerFixture(dir: string, entry: string): Promise<string> {
	const script = path.join(dir, 'worker.cjs');
	const anchor = path.join(dir, 'fixture-anchor.cjs');
	fs.writeFileSync(
		anchor,
		`const fs=require('fs'),path=require('path'); const root=${JSON.stringify(dir)}; exports.createKeyringAnchor=(service,account)=>{const file=path.join(root,service+'-'+account+'.json');return {available:()=>true,read:()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null,write:(v)=>{const mode=fs.existsSync(path.join(root,'kill-mode'))?fs.readFileSync(path.join(root,'kill-mode'),'utf8'):''; const pending=!!JSON.parse(v.installSecret).pending;if(mode==='stable-before'&&!pending)process.exit(71);fs.writeFileSync(file,JSON.stringify(v));const cut=path.join(root,'kill-at');if(fs.existsSync(cut)){const counter=path.join(root,'kill-count');const n=(fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0)+1;fs.writeFileSync(counter,String(n));if(n===Number(fs.readFileSync(cut,'utf8')))process.exit(73);}if(pending&&fs.existsSync(path.join(root,'pause-prepared'))){fs.writeFileSync(path.join(root,'prepared-marker'),'1');let n=0;while(fs.existsSync(path.join(root,'pause-prepared'))){if(n++>500)throw Error('fixture pause timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}if((mode==='prepared-after'&&pending)||(mode==='stable-after'&&!pending))process.exit(72);}};};`
	);
	await build({
		entryPoints: [entry],
		outfile: script,
		bundle: true,
		platform: 'node',
		format: 'cjs',
		plugins: [
			{
				name: 'isolated-receipt-checkpoint',
				setup(b) {
					b.onResolve({ filter: /^better-sqlite3$/ }, () => ({
						path: 'node-sqlite-adapter',
						namespace: 'test-sqlite',
					}));
					b.onLoad({ filter: /.*/, namespace: 'test-sqlite' }, () => ({
						contents: `import { nodeSqliteBetterSqlite3Mock } from ${JSON.stringify(path.resolve('src/__tests__/helpers/nodeSqlite.ts'))}; export default nodeSqliteBetterSqlite3Mock().default;`,
						resolveDir: process.cwd(),
					}));
					b.onResolve({ filter: /keyring-anchor$/ }, () => ({ path: anchor }));
				},
			},
		],
	});
	return script;
}
