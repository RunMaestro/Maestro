# Security Policy

Thank you for your interest in the security of Maestro. We welcome contributions from security researchers and the broader community to help keep this project safe.

## Reporting a Vulnerability

### For Most Issues
Please open a [GitHub issue](https://github.com/RunMaestro/Maestro/issues) with the `security` label. Include:
- A clear description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if you have one)

### For Serious/Critical Issues
If you discover a vulnerability that could cause significant harm if disclosed publicly before a fix is available, please contact us directly:

**Email:** pedram@runmaestro.ai

This allows us to develop and release a patch before public disclosure.

## Scope

### In Scope
- Maestro application code (Electron main process, renderer, preload scripts)
- IPC handler security
- Process spawning and command execution
- Local file system access
- Web server and tunnel functionality
- Authentication and session management

### Out of Scope
The following are **not** in scope for Maestro security reports:
- **AI agent vulnerabilities** - Security issues within Claude Code, OpenAI Codex, Gemini CLI, Qwen3 Coder, or other integrated agents are the responsibility of their respective maintainers
- **Upstream dependencies** - Vulnerabilities in Electron, Node.js, or npm packages should be reported to those projects (though please let us know if Maestro is using a vulnerable version)
- **Social engineering attacks**
- **Denial of service on local application**
- **Issues requiring physical access to the user's machine**

## Response Timeline

We aim to respond to security reports as soon as possible. However, please understand that Maestro is an open source side project maintained by volunteers. Until there is a larger developer community behind it, we cannot commit to specific response timelines.

What you can expect:
- Acknowledgment of your report
- Assessment of severity and impact
- A fix prioritized based on severity
- Credit in our release notes (unless you prefer to remain anonymous)

## Recognition

We appreciate security researchers who help improve Maestro. Contributors who report valid security issues will be:
- Credited in release notes and this document (with permission)
- Thanked publicly (unless anonymity is preferred)

**Security Contributors:**
- *Your name could be here!*

## Bug Bounty

There is no bug bounty program at this time. Maestro is an open source project without funding for monetary rewards. We hope the satisfaction of contributing to open source security and public recognition is sufficient motivation.

We also welcome pull requests! If you find a vulnerability and know how to fix it, PRs are greatly appreciated.

## Known Security Considerations

The following are known aspects of Maestro's design that users should be aware of:

### Process Execution
Maestro spawns AI agents and terminal processes with the same privileges as the user running the application. This is by design—the agents need filesystem and command access to function. Users should:
- Only run Maestro on projects they trust
- Be aware that AI agents can execute commands on your system
- Review agent actions, especially on sensitive repositories

### Local Web Server
When the web/mobile interface is enabled, Maestro runs a local web server. The Cloudflare tunnel feature can expose this externally. Users should:
- Only enable tunnels when needed
- Be aware of who has access to tunnel URLs

### IPC Security
Maestro uses Electron's IPC for communication between the main process and renderer. We follow Electron security best practices including context isolation and a minimal preload API surface.

### Sentry DSN
The Sentry DSN in the codebase is a **public secret by design**. This is standard practice for client-side error reporting—the DSN is intentionally exposed to allow error telemetry. Reporting this as a vulnerability is not necessary. We monitor for abuse and will rotate keys if needed.

## Security Best Practices in Codebase

For contributors, Maestro enforces these security patterns:

- **Always use `execFileNoThrow`** for external commands—never shell-based execution
- **Validate all IPC inputs** in main process handlers
- **Minimize preload API surface**—only expose what's necessary
- **Sanitize file paths** before filesystem operations

See [CLAUDE.md](CLAUDE.md) and [CONTRIBUTING.md](CONTRIBUTING.md) for more details.
