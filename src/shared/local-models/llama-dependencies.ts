/**
 * The JavaScript half of `node-llama-cpp`, pinned and hashed for the `llama`
 * runtime download.
 *
 * The `@node-llama-cpp/<platform>` payload in `runtime-artifacts.ts` is the
 * native binary and nothing else: its entry point exports `getBinsDir()` and no
 * more. `getLlama()` and `LlamaChatSession` live in the main `node-llama-cpp`
 * package, which brings its own production dependency tree. Every package below
 * is that tree, exactly as `npm install node-llama-cpp@3.20.0 --omit=dev
 * --omit=optional` lays it out, so the runtime directory resolves the same
 * modules a contributor's `npm install` does.
 *
 * **How this table was produced.** In a scratch directory outside the repo:
 * `npm install node-llama-cpp@3.20.0 --ignore-scripts --omit=dev
 * --omit=optional`, then every non-optional entry of `package-lock.json` was
 * downloaded from its `resolved` URL, checked against the lockfile's SHA-512
 * `integrity`, and hashed with SHA-256 (spot-checked against `npm pack`). 116
 * packages, ~36.9 MB compressed, of which 34.8 MB is `node-llama-cpp` itself.
 * Regenerate it the same way when `LLAMA_VERSION` moves; never edit one row by
 * hand.
 *
 * **What was deliberately left out, and why it is safe.**
 *   - The `@node-llama-cpp/*` optional dependencies: the runtime payload IS the
 *     one for this platform, installed where `node-llama-cpp` imports it from.
 *   - `@reflink/reflink` (optional, native): only `ipull`'s file downloader
 *     imports it, inside a try/catch, and Maestro never downloads through
 *     node-llama-cpp.
 *   - `node-llama-cpp`'s `postinstall` script, the only install script in the
 *     closure that would run on a registry install. It calls `getLlama()` once
 *     to prove the prebuilt binary loads and falls back to building llama.cpp
 *     from source when it does not. With the prebuilt binary present it does no
 *     work the runtime needs; the runtime self-test is what proves the load.
 *   - `node-addon-api`, `node-api-headers` and `cmake-js` are in the closure
 *     because node-llama-cpp lists them as dependencies for its from-source
 *     build. They are headers and pure JavaScript, carry no native binary, and
 *     are installed rather than pruned because guessing which modules a package
 *     imports lazily is how one goes missing months later.
 */

import type { NativeRuntimeDependency } from './runtime-artifacts';

/** `https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz`, scoped or not. */
export function npmTarballUrl(name: string, version: string): string {
	const basename = name.slice(name.lastIndexOf('/') + 1);
	return `https://registry.npmjs.org/${name}/-/${basename}-${version}.tgz`;
}

/**
 * One row. `parent` is the package this one is nested under, for the two dozen
 * packages npm could not hoist because a sibling needs a different version.
 */
function dep(
	name: string,
	version: string,
	sha256: string,
	bytes: number,
	parent?: string
): NativeRuntimeDependency {
	return Object.freeze({
		name,
		url: npmTarballUrl(name, version),
		sha256,
		bytes,
		installPath: parent ? `node_modules/${parent}/node_modules/${name}` : `node_modules/${name}`,
	});
}

/** Must match `versionPin` for the `llama` runtime and the platform payload. */
export const NODE_LLAMA_CPP_VERSION = '3.20.0';

/**
 * `node-llama-cpp` itself.
 *
 * `keep` drops `llama/gitRelease.bundle` (33 MB of llama.cpp source, read only
 * by a from-source build) and the `templates/` used by its project scaffolding
 * CLI. The download still pays for them, because the tarball is immutable; the
 * disk does not.
 */
const NODE_LLAMA_CPP: NativeRuntimeDependency = Object.freeze({
	name: 'node-llama-cpp',
	url: npmTarballUrl('node-llama-cpp', NODE_LLAMA_CPP_VERSION),
	sha256: '69e17d87f4d4fedde99cc03599b995a032fb67680e7da2d4f082dfdac4f904c9',
	bytes: 34_827_560,
	installPath: 'node_modules/node-llama-cpp',
	keep: Object.freeze([
		'dist',
		'bins',
		'package.json',
		'llama/addon',
		'llama/cmake',
		'llama/gpuInfo',
		'llama/grammars',
		'llama/patches',
		'llama/profiles',
		'llama/toolchains',
		'llama/xpack',
		'llama/CMakeLists.txt',
		'llama/binariesGithubRelease.json',
		'llama/llama.cpp.info.json',
		'llama/package.json',
	]),
});

/** The package itself, then everything it imports, in lockfile path order. */
export const NODE_LLAMA_CPP_DEPENDENCIES: readonly NativeRuntimeDependency[] = Object.freeze([
	NODE_LLAMA_CPP,
	dep(
		'@huggingface/jinja',
		'0.5.10',
		'6ab468e6aa58f591c174657fe6bbc055da3e81655209f86a72f1a3493d6c575b',
		81_977
	),
	dep(
		'@isaacs/fs-minipass',
		'4.0.1',
		'7ac286e3cccc1ea8980e79e2039def6bb97d3182e17951cd9094f0400ed98236',
		12_383
	),
	dep(
		'@kwsites/file-exists',
		'1.1.1',
		'8655395f8d52ae761817db9eb0c9f82e6ed8b7345125efb09afff02a25198556',
		4_969
	),
	dep(
		'@kwsites/promise-deferred',
		'1.1.1',
		'd144362b62db89171b7efb4518685cb7afeaad27fb3e287717d688e8d9a40fb9',
		2_563
	),
	dep(
		'@simple-git/args-pathspec',
		'1.0.4',
		'110eb1365a8135dc098b872a7ad1752220d6ae4661eeae974279310700d895f2',
		2_478
	),
	dep(
		'@simple-git/argv-parser',
		'1.1.1',
		'8ed7b81dbdcbc17b0655d308b85a0e395fc27afa5d5203a1f22b425538913220',
		28_927
	),
	dep(
		'@tinyhttp/content-disposition',
		'2.2.4',
		'089e63a1562ec2d36ccbf38b8ff4f8bf37a33f42e00554cac7a115b9a8816a33',
		6_667
	),
	dep(
		'ansi-escapes',
		'6.2.1',
		'7e6bca2d223e0c5a349e231f68a3ee1ea297038177cd28f90a97aaf46bef1026',
		5_500
	),
	dep(
		'ansi-regex',
		'6.4.0',
		'4cc0f907dd4cb056ff929ee28c031f4084c702ee4969973025a418a5e3fffca7',
		3_025
	),
	dep(
		'ansi-styles',
		'6.2.3',
		'e939cf5138d7a5d4e34100acd0153577b2953305931157a1cfe9faa56383911b',
		5_836
	),
	dep(
		'async-retry',
		'1.3.3',
		'acfa9c2b717f057397f2f3e1c6c40a159355aaba3985a288282025135d2a9f4d',
		2_595
	),
	dep('bytes', '3.1.2', '835e37ad5a40da45eaed6e32d99847627a15b2a4671741182521fe48dee3c581', 4_496),
	dep('chalk', '5.6.2', '94957715a483aa3b9db60c8f22d5498227d8025c407f982eef81e34f37574ffd', 13_831),
	dep(
		'chmodrp',
		'1.0.2',
		'01acae50248a7e1bc816b58cdec9875195592f7b577c7b2c5bca2bb4b1dd9bde',
		2_942
	),
	dep('chownr', '3.0.0', '4c24f5daa630142252da89de655f7df090ea479450a8825897751d78321b1360', 4_405),
	dep(
		'ci-info',
		'4.4.0',
		'90dc91404af2f0354fc8af1e6195eddc3df4a216b94aed7da602226b4cda591f',
		8_185
	),
	dep(
		'cli-cursor',
		'5.0.0',
		'2576ff84cb30035603c4319a25f310427b11bcba9ca3b51e19d3837bc4488fd5',
		1_927
	),
	dep(
		'cli-spinners',
		'2.9.2',
		'46c24c4edebc7b1297c6e9bb92b2f53f0be5c59037bbe1a695ffc953da02b48c',
		6_598
	),
	dep('cliui', '8.0.1', 'defad1e25e8a349ea9cdd1066abf5e1e762f7f909de72bdca67bb35f77468c8d', 7_907),
	dep(
		'ansi-regex',
		'5.0.1',
		'0e0eadcdaada805db5d85b53ad5cdca0760b996ee199ec9658e7b34aa6c8e0d9',
		2_768,
		'cliui'
	),
	dep(
		'is-fullwidth-code-point',
		'3.0.0',
		'6f415dae5dc6070f1b42daee6165eab941a97101982305facc8bafdaf300bc4a',
		2_169,
		'cliui'
	),
	dep(
		'string-width',
		'4.2.3',
		'adbb4fb1b26e8069af99adff0079369c93f17cf887b91086691d671ddbd52934',
		2_383,
		'cliui'
	),
	dep(
		'strip-ansi',
		'6.0.1',
		'9bdb75d0bff49f156dd8c3bcb0e06b3fa96c3d88ddd4c342a4345866a40c08ca',
		2_041,
		'cliui'
	),
	dep(
		'cmake-js',
		'8.0.0',
		'243a68c0bb9ffea2ce63b8d68165ca63778ebe7d180406125c071134ad13dae6',
		30_752
	),
	dep(
		'color-convert',
		'2.0.1',
		'920fa43538c019a085dbbf04cb6f72cc337624e5f5217519f0e7b2ef784e7ce1',
		8_996
	),
	dep(
		'color-name',
		'1.1.4',
		'507b7c4461e8eb941355af9a59e9a7e02cd0e7c6176b48d1809766344f3f1708',
		2_868
	),
	dep(
		'commander',
		'10.0.1',
		'ea1f4642cf8b38ab798a87915022d00f81bc1d108811a4b635b3926f5a1ff7d2',
		44_918
	),
	dep(
		'cross-spawn',
		'7.0.6',
		'188c320cdc413adfec03098fda72af7a9b02152ba13d3a8f87f172d93ced38ea',
		6_255
	),
	dep(
		'isexe',
		'2.0.0',
		'47cfe872e088e28c53b736fef305324b57cc1cfc9f72a9b0f769f92731cb8359',
		3_756,
		'cross-spawn'
	),
	dep(
		'which',
		'2.0.2',
		'a13adf5fddeb769655edce551e81fbb11904b9c9be76d95e41da8c4c499d4edc',
		4_496,
		'cross-spawn'
	),
	dep('debug', '4.4.3', '89c1ac9c946ee8905a875837114528e97eeae35e03be3190584b2216af43e4a7', 13_449),
	dep(
		'deep-extend',
		'0.6.0',
		'0dcc5f34920c23f5da2916d1d42e53ae5574913dfb78c406902b7189cf0b1386',
		3_627
	),
	dep(
		'emoji-regex',
		'8.0.0',
		'b5ccd9fbfb08098eefbeb6b6b4b40db6db3acf9243e327e039925aa8661cb107',
		6_664
	),
	dep(
		'env-var',
		'7.5.0',
		'3f0ff56f4cb61f870cf40df19b2f65ec0a0142dff9e435bb3de80b0e2ee987a9',
		13_426
	),
	dep(
		'escalade',
		'3.2.0',
		'ba2755afc0e6c6705326711fd218ebe107a527eccbd6485155fde98ed000bee7',
		4_483
	),
	dep(
		'eventemitter3',
		'5.0.4',
		'21d4a36175672b9e6640c39a68613af73f9a4c47a4a4da39993e8cd085564eb6',
		12_133
	),
	dep(
		'filename-reserved-regex',
		'3.0.0',
		'c96c2fa4a124c14ef5e93512f0421927e93ea8bca593fcc3cb5e83dc3e48256c',
		1_721
	),
	dep(
		'filenamify',
		'6.0.0',
		'3888616d9aeec9081fa56e919d15ae69eff861e7f9c6c6f188c0b85f3cdd0a3a',
		3_248
	),
	dep(
		'fs-extra',
		'11.4.1',
		'6eee04ab29b3f37ce2fa75014fb3fd4836d8a24a2945edfae11e571409ffcbfa',
		16_504
	),
	dep(
		'get-caller-file',
		'2.0.5',
		'7b13e1c81949ff4c1baae4ac4e34990492d5e8a86dab7e3b90027b1f5126935f',
		2_383
	),
	dep(
		'get-east-asian-width',
		'1.7.0',
		'371c7b094731ec5848025a7139eb05facc23cf18bd56ed8f755364e4b90ebd35',
		5_431
	),
	dep(
		'graceful-fs',
		'4.2.11',
		'3961374aa161e6fed80d6f4b6aaf2fb7eafd2c9e5be34e865b375f0114dd099c',
		9_804
	),
	dep(
		'ignore',
		'7.0.12',
		'c7d39ab0c0a3161b3b199508044d385cc88d2ba4b417a34b8ded50e27f306e2f',
		39_663
	),
	dep('ini', '1.3.8', 'fd9e1145104d8594ba4ee70596feecb2fe2957f998dc18a2a643e858ee12695a', 3_998),
	dep('ipull', '3.9.5', '45188b708fb499d60e570ef317e1a8cbc40952df0a1aecb0b4ddb493ce1fb690', 72_275),
	dep(
		'lifecycle-utils',
		'2.1.0',
		'adeda086fd03d0390687b7c4f9dc25290e33d81ab384cf162c53dfb365343e0b',
		21_130,
		'ipull'
	),
	dep(
		'parse-ms',
		'3.0.0',
		'b4e28073c2b013716226a9bfe87bd312ebf753707efba59cb1014a8bb6c6cac8',
		1_766,
		'ipull'
	),
	dep(
		'pretty-ms',
		'8.0.0',
		'0435f5796f79cab8cb2104176fde651d4c9ea280b90a3521a56126374dbf82a7',
		3_743,
		'ipull'
	),
	dep(
		'slice-ansi',
		'7.1.2',
		'44ad6f9f0132626f69d17325f2dbf0cbd3d6abfe3cf36d809b66318fbca58fba',
		3_180,
		'ipull'
	),
	dep(
		'is-fullwidth-code-point',
		'5.1.0',
		'f1a651594c2860a0a007dba521bafb7cb42fc199110df57e4b3eb0d336d523c3',
		1_679
	),
	dep(
		'is-interactive',
		'2.0.0',
		'3c3b25822ea4ea6ec5337ae23463f5f4638fdbae0c6d3934185300b1ed923af0',
		2_391
	),
	dep(
		'is-unicode-supported',
		'2.1.0',
		'5926c0400ee62ff9cb7b4658e73217028aa6070799ddf5a14249e53e21fdd362',
		2_048
	),
	dep('isexe', '4.0.0', 'c33d5be3c3ae9b9932eb3192f00f754673341b0fd427be653834192620bb28a2', 10_590),
	dep(
		'jsonfile',
		'6.2.1',
		'6c1ae1dbfc6c518b10858d2e37c31d31e1fb39eaf32d77c10f1d84c573540d36',
		3_519
	),
	dep(
		'lifecycle-utils',
		'4.5.2',
		'79cc16a4d5b1e180e258e2af6b9329a00183bae2c085052120efff23ba4cdb3f',
		84_057
	),
	dep(
		'lodash.debounce',
		'4.0.8',
		'a518384c6f5694f12c752ff708869ce5790c32dbf01a47acdd53546be0980ba0',
		5_209
	),
	dep(
		'log-symbols',
		'7.0.1',
		'2855a94b5c49f0727cbd290d9914b095c56b3893229332958172cdefb80e0205',
		2_148
	),
	dep('lowdb', '7.0.1', '6879702dc266d039edd79256d4e96292e2762aab63409838e116bf4e537c0da5', 7_272),
	dep(
		'mimic-function',
		'5.0.1',
		'6cc0001f0fda816530db192ca9438ecaa892f7a4b579e4595a1dc8ab3bb0ac65',
		3_203
	),
	dep(
		'minimist',
		'1.2.8',
		'350a76c115b393c19d24654834261e5dc9f0e8cc5e08f3937fa80140f3e4ce83',
		15_520
	),
	dep(
		'minipass',
		'7.1.3',
		'52ac61be743755e3fdc98e560086d0d4a1e2c7fd3643387792db38e322d27d12',
		83_605
	),
	dep(
		'minizlib',
		'3.1.0',
		'99bf2e29618172dd71f0654737490c68f71bc7e2379d473e38f9fef2dbece2e3',
		18_461
	),
	dep('ms', '2.1.3', 'f6616e15e530ed552f9daa2d3ce71963947c6bc7c98c9b64fd3e673fd02622c6', 2_967),
	dep(
		'nanoid',
		'5.1.16',
		'd3fd9cbdc9e6c8f9617a92e6b06a308c56a62c744f748e393d10203866c1b3f8',
		4_839
	),
	dep(
		'node-addon-api',
		'8.9.2',
		'4cd65698541b19a33f798f1dc25c02c6ed1c9d7749b8824b1a1ccecdd197c8ea',
		62_490
	),
	dep(
		'node-api-headers',
		'1.9.0',
		'6cbfac49542194ae2c8f1dee5fa2dc00d66bec9cbf3b59e3a4e5f16d14eb0d19',
		16_974
	),
	dep(
		'onetime',
		'7.0.0',
		'e3356974342456a61d909af33b4da6bdba46cfb83f1ba8a039eeb1fba945cdc4',
		2_366
	),
	dep('ora', '9.4.1', '6c29a82c18fc7aa83e838c5091e0b3a468846fb6f7866a6814301f6db341661b', 11_145),
	dep(
		'cli-spinners',
		'3.4.0',
		'1db1193e1f304c2a0b180e96f2724fa6cf69dc795c5c51989feaf0eaff6fc0c2',
		6_905,
		'ora'
	),
	dep(
		'parse-ms',
		'4.0.0',
		'abbc7e193f7bcd9d26f9fe994f846ee3fb442b0ec215e7f61fa1080a29b7fb68',
		1_985
	),
	dep(
		'path-key',
		'3.1.1',
		'4b8999acb914830edcd3c5b8fec632b32c6bc759ac3edc86336f5a9e08ba7b92',
		2_258
	),
	dep(
		'pretty-bytes',
		'6.1.1',
		'60130b603601c10ec72b9e6f4486703ef9ab18afc7628316c7c53052e9a540e5',
		3_617
	),
	dep(
		'pretty-ms',
		'9.3.1',
		'c0063cf4e8865ef0e944b3853b046b01571036b62be5c72e6e86215fc9f4475b',
		4_863
	),
	dep(
		'proper-lockfile',
		'4.1.2',
		'fd78914ba57caecbedbb928fb369510b01fa32e1c0fbca7b63ca16623a7a8968',
		8_728
	),
	dep(
		'retry',
		'0.12.0',
		'df61c6d197aadc6ab17b489103533bbb0223413558d4222411c162155c30b428',
		10_431,
		'proper-lockfile'
	),
	dep('rc', '1.2.8', '03a5fae485203eb424dd3e9b1c4cf9ce3d04c03b154cb4fb6604497815cae93b', 7_148),
	dep(
		'require-directory',
		'2.1.1',
		'703bee0844360383fe4a8792d4a5a562647426a053e7597a1d272ac554f386c8',
		4_372
	),
	dep(
		'restore-cursor',
		'5.1.0',
		'fae40995655da80643db6bcb512977240e68cad98054e4f9f3851844884b48fd',
		1_684
	),
	dep(
		'signal-exit',
		'4.1.0',
		'9d3b58a811ecf6a641537387289274cd14f5bb912a27e4f1f2a74182bca8b795',
		13_369,
		'restore-cursor'
	),
	dep('retry', '0.13.1', '7521d8445e845475e888ccb7af473c4afb17aabafefe35a23371a8a8c79b8084', 6_547),
	dep(
		'semver',
		'7.8.5',
		'd85045d4300d7d57c891336b95df532e73f34c22ffcd222452b6d08b9d127d5d',
		29_399
	),
	dep(
		'shebang-command',
		'2.0.0',
		'9acba5bd18a51e9cdf5898380e4df63f803e1844def64ae1a46f88cff86d556e',
		1_506
	),
	dep(
		'shebang-regex',
		'3.0.0',
		'fedbabaa6db26c6be0183f82777dfa852d59a62f8885de93bd32ebc28758958f',
		1_503
	),
	dep(
		'signal-exit',
		'3.0.7',
		'439623fa6aab91600615ec757eaa137fcab40d3b35dda38df7444c15678f20a8',
		3_851
	),
	dep(
		'simple-git',
		'3.36.0',
		'e694b2f1b5a9e362ba2592d707d13c0a579d37ccaed6c9d6fca5c50d9553bf8c',
		218_752
	),
	dep(
		'sleep-promise',
		'9.1.0',
		'f148403b61b6cdc3ea086d99d2fadf6d3d45ea1c407a585fc9d8c6055f93d27f',
		148_221
	),
	dep(
		'slice-ansi',
		'8.0.0',
		'827033959832ab8428f2703ee324baa6fa8e940ac6dfaaed4afa1891fecc70be',
		7_016
	),
	dep(
		'stdin-discarder',
		'0.3.2',
		'cb97f9dde8b47e6a096c217459406f38ceb3b2c657f1db5115224fbaccffa18d',
		2_267
	),
	dep(
		'stdout-update',
		'4.0.1',
		'e98d3181e687f39d49af400e137db919e3db8fe1009bf203f69ee3a87a7e52ab',
		7_374
	),
	dep(
		'emoji-regex',
		'10.6.0',
		'9f40e54c0586f30882ece0ee0d22654394b89321e89cb55e8faf12ed8ccff981',
		5_610,
		'stdout-update'
	),
	dep(
		'string-width',
		'7.2.0',
		'3e90901a98cadef6986fe2953e6d181f49730d81c7855776a6337fef93bbf1f3',
		2_989,
		'stdout-update'
	),
	dep('steno', '4.0.2', 'd7d111ae4d79f4c164a0fc71347c5b46cb7e89ef43f7aef27de6d629e8321d94', 3_139),
	dep(
		'string-width',
		'8.3.0',
		'b9332abee5a45017221999b9133d77f092b81d0b1d747fc030abe1119a148339',
		4_510
	),
	dep(
		'strip-ansi',
		'7.2.0',
		'2fa01de86a5022ef32773abbc4e84a53a1c5d31f5a5cbf03ed2575f10408543f',
		2_156
	),
	dep(
		'strip-json-comments',
		'2.0.1',
		'dbe45febaf1bf7265c25733242bc0e7ac38b632db6a8e19f0341af4770425899',
		2_270
	),
	dep('tar', '7.5.22', 'b792c2d1c7fc770910522ca1ffc29eee02ee38de4fa3a01e7832eb705879c6c6', 471_090),
	dep(
		'universalify',
		'2.0.1',
		'7d07313bb61836a12f0ba5485e67673334a3ee955e7aefb3c4b3fc5a1b7b7865',
		2_068
	),
	dep(
		'url-join',
		'4.0.1',
		'e2453174df4af3f616ed65361154f019a33a351e52f15e2058f8ca4fdd3a24c9',
		5_774
	),
	dep(
		'validate-npm-package-name',
		'7.0.2',
		'aaa404bc76612e97e6251a5e35e96450fdbdbb6f0a81b6135cf3d72dbfbf9c6b',
		3_763
	),
	dep('which', '6.0.1', '306cae87dc682e93c16f0ec27893f8d6c4b798bd8a3b078c53fea88115f4bfb6', 3_349),
	dep(
		'wrap-ansi',
		'7.0.0',
		'0795b3510bd2e938f6a415396de3d4f58fd76ef1f8249a07196444eaf85ca42f',
		4_317
	),
	dep(
		'ansi-regex',
		'5.0.1',
		'0e0eadcdaada805db5d85b53ad5cdca0760b996ee199ec9658e7b34aa6c8e0d9',
		2_768,
		'wrap-ansi'
	),
	dep(
		'ansi-styles',
		'4.3.0',
		'2c539a46d85ab6033183997434d2d9a5ca2ceefc12b4db9022f564784cd7987f',
		5_849,
		'wrap-ansi'
	),
	dep(
		'is-fullwidth-code-point',
		'3.0.0',
		'6f415dae5dc6070f1b42daee6165eab941a97101982305facc8bafdaf300bc4a',
		2_169,
		'wrap-ansi'
	),
	dep(
		'string-width',
		'4.2.3',
		'adbb4fb1b26e8069af99adff0079369c93f17cf887b91086691d671ddbd52934',
		2_383,
		'wrap-ansi'
	),
	dep(
		'strip-ansi',
		'6.0.1',
		'9bdb75d0bff49f156dd8c3bcb0e06b3fa96c3d88ddd4c342a4345866a40c08ca',
		2_041,
		'wrap-ansi'
	),
	dep('y18n', '5.0.8', 'd43743bad3a7cb3af5d3b6bf70fd32fe3923ea86e4148109c6dd0126deada769', 6_157),
	dep(
		'yallist',
		'5.0.0',
		'7c9d43dbab7cab3b3133b0e6a5af14014482285316b39ec9f508efadd9ebce95',
		9_821
	),
	dep(
		'yargs',
		'17.7.3',
		'76ac30834674f0d8da9c7bfedb175f6ada260420e6475edfdcc551c601f8717e',
		73_972
	),
	dep(
		'yargs-parser',
		'21.1.1',
		'342b7d527d4a72265b64f27711517349c3c05ee302ab3b8c7452f0bfbe709151',
		28_613
	),
	dep(
		'ansi-regex',
		'5.0.1',
		'0e0eadcdaada805db5d85b53ad5cdca0760b996ee199ec9658e7b34aa6c8e0d9',
		2_768,
		'yargs'
	),
	dep(
		'is-fullwidth-code-point',
		'3.0.0',
		'6f415dae5dc6070f1b42daee6165eab941a97101982305facc8bafdaf300bc4a',
		2_169,
		'yargs'
	),
	dep(
		'string-width',
		'4.2.3',
		'adbb4fb1b26e8069af99adff0079369c93f17cf887b91086691d671ddbd52934',
		2_383,
		'yargs'
	),
	dep(
		'strip-ansi',
		'6.0.1',
		'9bdb75d0bff49f156dd8c3bcb0e06b3fa96c3d88ddd4c342a4345866a40c08ca',
		2_041,
		'yargs'
	),
	dep(
		'yoctocolors',
		'2.2.0',
		'abb3214409bcd4a48b1c49384f7441563368c54fa6251c6fb5ab8081907f7f5c',
		4_538
	),
]);
