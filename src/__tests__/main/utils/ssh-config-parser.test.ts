/**
 * Tests for SSH Config Parser
 *
 * Tests the parsing of ~/.ssh/config files to extract host configurations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	parseSshConfig,
	parseConfigContent,
	findSshConfigHost,
	getSshConfigHostSummary,
	SshConfigHost,
	SshConfigParserDeps,
} from '../../../main/utils/ssh-config-parser';

describe('ssh-config-parser', () => {
	describe('parseConfigContent', () => {
		it('should parse a simple host entry', () => {
			const content = `
Host dev-server
    HostName 192.168.1.100
    User admin
    Port 2222
    IdentityFile ~/.ssh/id_ed25519
`;
			const hosts = parseConfigContent(content, '/home/user');

			expect(hosts).toHaveLength(1);
			expect(hosts[0]).toEqual({
				host: 'dev-server',
				hostName: '192.168.1.100',
				user: 'admin',
				port: 2222,
				identityFile: '/home/user/.ssh/id_ed25519',
			});
		});

		it('should parse multiple host entries', () => {
			const content = `
Host server1
    HostName 10.0.0.1
    User alice

Host server2
    HostName 10.0.0.2
    User bob
    Port 22
`;
			const hosts = parseConfigContent(content, '/home/user');

			expect(hosts).toHaveLength(2);
			expect(hosts[0].host).toBe('server1');
			expect(hosts[0].hostName).toBe('10.0.0.1');
			expect(hosts[0].user).toBe('alice');
			expect(hosts[1].host).toBe('server2');
			expect(hosts[1].hostName).toBe('10.0.0.2');
			expect(hosts[1].user).toBe('bob');
		});

		it('should ignore wildcard-only hosts', () => {
			const content = `
Host *
    ServerAliveInterval 60

Host dev-*
    User developer

Host production
    HostName prod.example.com
    User admin
`;
			const hosts = parseConfigContent(content, '/home/user');

			// Should only include 'production', not '*' or 'dev-*'
			expect(hosts).toHaveLength(1);
			expect(hosts[0].host).toBe('production');
		});

		it('should handle comments', () => {
			const content = `
# This is a comment
Host myserver # inline comment
    HostName server.example.com # host address
    User myuser
    # This line is also a comment
    Port 22
`;
			const hosts = parseConfigContent(content, '/home/user');

			expect(hosts).toHaveLength(1);
			expect(hosts[0].host).toBe('myserver');
			expect(hosts[0].hostName).toBe('server.example.com');
			expect(hosts[0].user).toBe('myuser');
			expect(hosts[0].port).toBe(22);
		});

		it('should handle equals sign as separator', () => {
			const content = `
Host myserver
    HostName=192.168.1.1
    User=admin
    Port=2222
`;
			const hosts = parseConfigContent(content, '/home/user');

			expect(hosts).toHaveLength(1);
			expect(hosts[0].hostName).toBe('192.168.1.1');
			expect(hosts[0].user).toBe('admin');
			expect(hosts[0].port).toBe(2222);
		});

		it('should expand tilde in IdentityFile paths', () => {
			const content = `
Host myserver
    HostName server.example.com
    IdentityFile ~/my-keys/custom_key
`;
			const hosts = parseConfigContent(content, '/home/testuser');

			expect(hosts).toHaveLength(1);
			expect(hosts[0].identityFile).toBe('/home/testuser/my-keys/custom_key');
		});

		it('should parse ProxyJump directive', () => {
			const content = `
Host internal-server
    HostName 10.0.0.50
    User admin
    ProxyJump bastion.example.com
`;
			const hosts = parseConfigContent(content, '/home/user');

			expect(hosts).toHaveLength(1);
			expect(hosts[0].proxyJump).toBe('bastion.example.com');
		});

		it('should handle empty content', () => {
			const hosts = parseConfigContent('', '/home/user');
			expect(hosts).toHaveLength(0);
		});

		it('should handle content with only comments', () => {
			const content = `
# Comment 1
# Comment 2

# Comment 3
`;
			const hosts = parseConfigContent(content, '/home/user');
			expect(hosts).toHaveLength(0);
		});

		it('should handle host with no additional directives', () => {
			const content = `
Host simple-host

Host another-host
    HostName 192.168.1.1
`;
			const hosts = parseConfigContent(content, '/home/user');

			expect(hosts).toHaveLength(2);
			expect(hosts[0].host).toBe('simple-host');
			expect(hosts[0].hostName).toBeUndefined();
			expect(hosts[1].host).toBe('another-host');
			expect(hosts[1].hostName).toBe('192.168.1.1');
		});

		it('should validate port numbers', () => {
			const content = `
Host valid-port
    HostName server1.example.com
    Port 8022

Host invalid-port
    HostName server2.example.com
    Port 99999

Host zero-port
    HostName server3.example.com
    Port 0

Host non-numeric-port
    HostName server4.example.com
    Port abc
`;
			const hosts = parseConfigContent(content, '/home/user');

			expect(hosts).toHaveLength(4);
			expect(hosts[0].port).toBe(8022); // Valid
			expect(hosts[1].port).toBeUndefined(); // Invalid: > 65535
			expect(hosts[2].port).toBeUndefined(); // Invalid: 0
			expect(hosts[3].port).toBeUndefined(); // Invalid: not a number
		});

		it('should handle case-insensitive directives', () => {
			const content = `
Host myserver
    HOSTNAME Server.Example.Com
    USER admin
    PORT 22
    IDENTITYFILE ~/.ssh/id_rsa
`;
			const hosts = parseConfigContent(content, '/home/user');

			expect(hosts).toHaveLength(1);
			expect(hosts[0].hostName).toBe('Server.Example.Com');
			expect(hosts[0].user).toBe('admin');
			expect(hosts[0].port).toBe(22);
			expect(hosts[0].identityFile).toBe('/home/user/.ssh/id_rsa');
		});

		it('should handle Windows-style line endings', () => {
			const content = 'Host myserver\r\n    HostName 192.168.1.1\r\n    User admin\r\n';
			const hosts = parseConfigContent(content, '/home/user');

			expect(hosts).toHaveLength(1);
			expect(hosts[0].host).toBe('myserver');
			expect(hosts[0].hostName).toBe('192.168.1.1');
		});

		it('should pick first non-wildcard from multi-pattern Host lines', () => {
			const content = `
Host server1 server2 server3
    HostName 192.168.1.1
    User admin
`;
			const hosts = parseConfigContent(content, '/home/user');

			expect(hosts).toHaveLength(1);
			expect(hosts[0].host).toBe('server1');
			expect(hosts[0].hostName).toBe('192.168.1.1');
		});
	});

	describe('parseSshConfig', () => {
		it('should return empty hosts when config file does not exist', () => {
			const deps: Partial<SshConfigParserDeps> = {
				fileExists: () => false,
				homeDir: '/home/user',
			};

			const result = parseSshConfig(deps);

			expect(result.success).toBe(true);
			expect(result.hosts).toHaveLength(0);
			expect(result.configPath).toBe('/home/user/.ssh/config');
		});

		it('should parse config file when it exists', () => {
			const mockContent = `
Host dev
    HostName dev.example.com
    User developer
`;
			const deps: Partial<SshConfigParserDeps> = {
				fileExists: () => true,
				readFile: () => mockContent,
				homeDir: '/home/user',
			};

			const result = parseSshConfig(deps);

			expect(result.success).toBe(true);
			expect(result.hosts).toHaveLength(1);
			expect(result.hosts[0].host).toBe('dev');
		});

		it('should return error on parse failure', () => {
			const deps: Partial<SshConfigParserDeps> = {
				fileExists: () => true,
				readFile: () => {
					throw new Error('Permission denied');
				},
				homeDir: '/home/user',
			};

			const result = parseSshConfig(deps);

			expect(result.success).toBe(false);
			expect(result.error).toContain('Permission denied');
			expect(result.hosts).toHaveLength(0);
		});
	});

	describe('findSshConfigHost', () => {
		it('should find a host by name', () => {
			const mockContent = `
Host dev-server
    HostName 192.168.1.100
    User admin

Host prod-server
    HostName 10.0.0.1
    User root
`;
			const deps: Partial<SshConfigParserDeps> = {
				fileExists: () => true,
				readFile: () => mockContent,
				homeDir: '/home/user',
			};

			const host = findSshConfigHost('dev-server', deps);

			expect(host).toBeDefined();
			expect(host?.host).toBe('dev-server');
			expect(host?.hostName).toBe('192.168.1.100');
		});

		it('should return undefined for non-existent host', () => {
			const mockContent = `
Host dev-server
    HostName 192.168.1.100
`;
			const deps: Partial<SshConfigParserDeps> = {
				fileExists: () => true,
				readFile: () => mockContent,
				homeDir: '/home/user',
			};

			const host = findSshConfigHost('unknown-server', deps);

			expect(host).toBeUndefined();
		});

		it('should perform case-insensitive host matching', () => {
			const mockContent = `
Host Dev-Server
    HostName 192.168.1.100
`;
			const deps: Partial<SshConfigParserDeps> = {
				fileExists: () => true,
				readFile: () => mockContent,
				homeDir: '/home/user',
			};

			const host = findSshConfigHost('dev-server', deps);

			expect(host).toBeDefined();
			expect(host?.host).toBe('Dev-Server');
		});
	});

	describe('getSshConfigHostSummary', () => {
		it('should format user@hostname', () => {
			const host: SshConfigHost = {
				host: 'myserver',
				hostName: 'server.example.com',
				user: 'admin',
			};

			expect(getSshConfigHostSummary(host)).toBe('admin@server.example.com');
		});

		it('should include non-default port', () => {
			const host: SshConfigHost = {
				host: 'myserver',
				hostName: 'server.example.com',
				user: 'admin',
				port: 2222,
			};

			expect(getSshConfigHostSummary(host)).toBe('admin@server.example.com, port 2222');
		});

		it('should exclude default port 22', () => {
			const host: SshConfigHost = {
				host: 'myserver',
				hostName: 'server.example.com',
				user: 'admin',
				port: 22,
			};

			expect(getSshConfigHostSummary(host)).toBe('admin@server.example.com');
		});

		it('should include identity file basename', () => {
			const host: SshConfigHost = {
				host: 'myserver',
				hostName: 'server.example.com',
				identityFile: '/home/user/.ssh/id_ed25519',
			};

			expect(getSshConfigHostSummary(host)).toBe('server.example.com, key: id_ed25519');
		});

		it('should show user@... when only user is available', () => {
			const host: SshConfigHost = {
				host: 'myserver',
				user: 'admin',
			};

			expect(getSshConfigHostSummary(host)).toBe('admin@...');
		});

		it('should show hostname when only hostname is available', () => {
			const host: SshConfigHost = {
				host: 'myserver',
				hostName: 'server.example.com',
			};

			expect(getSshConfigHostSummary(host)).toBe('server.example.com');
		});

		it('should return fallback when no details available', () => {
			const host: SshConfigHost = {
				host: 'myserver',
			};

			expect(getSshConfigHostSummary(host)).toBe('No details available');
		});

		it('should combine all available information', () => {
			const host: SshConfigHost = {
				host: 'myserver',
				hostName: 'server.example.com',
				user: 'admin',
				port: 2222,
				identityFile: '/home/user/.ssh/custom_key',
			};

			expect(getSshConfigHostSummary(host)).toBe(
				'admin@server.example.com, port 2222, key: custom_key'
			);
		});
	});
});
