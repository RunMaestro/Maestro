import { gzipSync } from 'zlib';
import { describe, expect, it } from 'vitest';
import { extractVerifiedTarball } from '../safe-extract';

function tarEntry(name: string, content: string, type = '0'): Buffer {
	const header = Buffer.alloc(512);
	header.write(name, 0, 'utf8');
	header.write('0000777\0', 100, 'ascii');
	header.write('0000000\0', 108, 'ascii');
	header.write('0000000\0', 116, 'ascii');
	header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
	header.write('00000000000\0', 136, 'ascii');
	header.write('        ', 148, 'ascii');
	header.write(type, 156, 'ascii');
	header.write('ustar\0', 257, 'ascii');
	header.write('00', 263, 'ascii');
	let checksum = 0;
	for (const byte of header) checksum += byte;
	header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
	const body = Buffer.from(content);
	return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

function tar(...entries: Buffer[]): Buffer {
	return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

describe('safe npm tarball extraction', () => {
	it('extracts only regular package files without package directory traversal', () => {
		const files = extractVerifiedTarball(tar(tarEntry('package/dist/cli.js', 'console.log(1)')));

		expect(files).toEqual([{ path: 'dist/cli.js', content: Buffer.from('console.log(1)') }]);
	});

	it('refuses traversal, absolute paths, links, duplicate files and malformed archives', () => {
		expect(() => extractVerifiedTarball(tar(tarEntry('package/../../evil', 'x')))).toThrow(
			'unsafe tar path'
		);
		expect(() => extractVerifiedTarball(tar(tarEntry('package/link', '', '2')))).toThrow(
			'tar link'
		);
		expect(() =>
			extractVerifiedTarball(tar(tarEntry('package/a', 'x'), tarEntry('package/a', 'y')))
		).toThrow('duplicate tar path');
		expect(() => extractVerifiedTarball(Buffer.from('not-a-gzip'))).toThrow('invalid gzip tarball');
	});
});
