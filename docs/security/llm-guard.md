---
title: LLM Guard
description: AI security layer that protects prompts and responses from sensitive data exposure, prompt injection attacks, and dangerous code patterns.
icon: shield
---

LLM Guard is Maestro's built-in security layer that scans all prompts sent to AI agents and responses received from them. It detects and handles sensitive data, injection attacks, malicious URLs, dangerous code patterns, and more.

## Quick Start

1. Open **Settings** (`Cmd+,` / `Ctrl+,`) → **Security** tab
2. Toggle **Enable LLM Guard** on
3. Choose an action mode:
   - **Warn** — Show warnings but allow content through
   - **Sanitize** — Automatically redact detected sensitive content
   - **Block** — Prevent prompts/responses containing high-risk content

That's it. LLM Guard now scans all AI interactions.

## How It Works

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Your Prompt   │ ──▶ │   Input Guard   │ ──▶ │    AI Agent     │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                                                        │
┌─────────────────┐     ┌─────────────────┐             ▼
│   You See This  │ ◀── │  Output Guard   │ ◀── ┌─────────────────┐
└─────────────────┘     └─────────────────┘     │   AI Response   │
                                                └─────────────────┘
```

**Input Guard** scans your prompts before they reach the AI:

- Detects and optionally redacts PII (emails, phone numbers, SSNs)
- Finds secrets (API keys, passwords, tokens)
- Detects prompt injection attempts
- Scans for malicious URLs
- Applies ban lists and custom patterns

**Output Guard** scans AI responses before you see them:

- Re-identifies any anonymized PII (restores `[EMAIL_1]` → `alice@example.com`)
- Detects secrets the AI might have generated or hallucinated
- Warns about dangerous code patterns
- Scans for malicious URLs in suggestions
- Detects output injection attempts

## Configuration Reference

### Master Controls

| Setting              | Description                                                     |
| -------------------- | --------------------------------------------------------------- |
| **Enable LLM Guard** | Master toggle. When off, no scanning occurs.                    |
| **Action Mode**      | What happens when issues are detected: Warn, Sanitize, or Block |

### Action Modes

| Mode         | Behavior                                                 | Use Case                             |
| ------------ | -------------------------------------------------------- | ------------------------------------ |
| **Warn**     | Shows visual warnings but allows content through         | Learning mode, low-risk environments |
| **Sanitize** | Automatically redacts detected content with placeholders | Production use, balanced protection  |
| **Block**    | Prevents prompts/responses with high-risk findings       | High-security environments           |

### Input Protection

Settings that apply to prompts you send:

| Setting                     | Description                                                                         | Default |
| --------------------------- | ----------------------------------------------------------------------------------- | ------- |
| **Anonymize PII**           | Replace PII with placeholders (e.g., `[EMAIL_1]`)                                   | On      |
| **Redact Secrets**          | Replace API keys, passwords, tokens with `[REDACTED]`                               | On      |
| **Detect Prompt Injection** | Analyze for injection attack patterns                                               | On      |
| **Structural Analysis**     | Detect structural injection patterns (JSON/XML templates, multiple system sections) | On      |
| **Invisible Characters**    | Detect hidden Unicode characters that could manipulate LLM behavior                 | On      |
| **Scan URLs**               | Check URLs for suspicious indicators                                                | On      |

### Output Protection

Settings that apply to AI responses:

| Setting                     | Description                                           | Default |
| --------------------------- | ----------------------------------------------------- | ------- |
| **De-anonymize PII**        | Restore original values from placeholders             | On      |
| **Redact Secrets**          | Remove any secrets in AI responses                    | On      |
| **Detect PII Leakage**      | Warn if AI generates new PII                          | On      |
| **Detect Output Injection** | Detect patterns designed to manipulate future prompts | On      |
| **Scan URLs**               | Check URLs in responses for suspicious indicators     | On      |
| **Scan Code**               | Detect dangerous code patterns in code blocks         | On      |

### Thresholds

| Setting                        | Description                                         | Range     | Default |
| ------------------------------ | --------------------------------------------------- | --------- | ------- |
| **Prompt Injection Threshold** | Minimum confidence score to flag injection attempts | 0% – 100% | 70%     |

Lower values catch more attacks but may produce false positives. Higher values reduce false positives but may miss subtle attacks.

### Ban Lists

| Setting                | Description                                                              |
| ---------------------- | ------------------------------------------------------------------------ |
| **Ban Substrings**     | Exact text matches that trigger the configured action (case-insensitive) |
| **Ban Topic Patterns** | Regex patterns for broader topic blocking                                |

### Group Chat Protection

| Setting                  | Description                                       | Default |
| ------------------------ | ------------------------------------------------- | ------- |
| **Inter-Agent Scanning** | Scan messages passed between agents in Group Chat | On      |

When enabled, LLM Guard scans agent-to-agent messages to prevent prompt injection chains where one compromised agent could manipulate another.

## Detection Types

### Secrets Detection

LLM Guard detects credentials and secrets using pattern matching and entropy analysis:

| Type             | Examples                              | Confidence |
| ---------------- | ------------------------------------- | ---------- |
| **API Keys**     | `sk-proj-...`, `AKIAIOSFODNN7EXAMPLE` | High       |
| **Private Keys** | `-----BEGIN RSA PRIVATE KEY-----`     | Very High  |
| **Passwords**    | `password: mySecret123`               | Medium     |
| **Tokens**       | `ghp_xxxxxxxxxxxx`, `xoxb-...`        | High       |
| **High Entropy** | Random-looking 32+ character strings  | Variable   |

### PII Detection

Detects personally identifiable information:

| Type            | Pattern                             |
| --------------- | ----------------------------------- |
| **Email**       | `user@example.com`                  |
| **Phone**       | `+1-555-123-4567`, `(555) 123-4567` |
| **SSN**         | `123-45-6789`                       |
| **Credit Card** | `4111-1111-1111-1111`               |
| **IP Address**  | `192.168.1.1` (in certain contexts) |

### Prompt Injection Detection

Detects attempts to override system instructions or manipulate the AI:

| Type                            | What It Catches                                                    |
| ------------------------------- | ------------------------------------------------------------------ |
| **Role Override**               | "Ignore previous instructions", "You are now...", "Act as..."      |
| **ChatML Delimiters**           | `<\|system\|>`, `<\|user\|>`, `<\|assistant\|>`                    |
| **Llama Delimiters**            | `[INST]`, `<<SYS>>`, `[/INST]`                                     |
| **System Instruction Override** | Attempts to inject new system prompts                              |
| **Structural Injection**        | JSON/XML prompt templates, multiple system sections, base64 blocks |
| **Invisible Characters**        | Zero-width spaces, directional overrides, confusable homoglyphs    |

### Malicious URL Detection

Scans URLs for suspicious indicators:

| Indicator                | Risk Level  | Example                                      |
| ------------------------ | ----------- | -------------------------------------------- |
| **IP Address URLs**      | High        | `http://192.168.1.1/payload`                 |
| **Suspicious TLDs**      | Medium-High | `.tk`, `.ml`, `.ga`, `.xyz`, `.top`          |
| **Punycode/IDN**         | High        | `xn--` domains (potential homograph attacks) |
| **Encoded Hostnames**    | High        | `%` encoding in hostname portion             |
| **Excessive Subdomains** | Medium      | `a.b.c.d.e.example.com`                      |
| **URL Shorteners**       | Low         | `bit.ly`, `t.co` (warning only)              |

### Dangerous Code Detection

Detects potentially harmful code patterns in AI responses:

**Shell Commands**
| Pattern | Description |
|---------|-------------|
| `rm -rf /` | Recursive force delete |
| `sudo <dangerous>` | Privileged destructive commands |
| `chmod 777` | World-writable permissions |
| `curl \| bash` | Download and execute |
| Fork bombs | System crash patterns |
| Reverse shells | Remote access patterns |

**SQL Injection**
| Pattern | Description |
|---------|-------------|
| `'; DROP TABLE` | Destructive SQL in strings |
| `OR 1=1` | Authentication bypass |
| `UNION SELECT` | Data extraction |
| `; INSERT/UPDATE` | Multi-statement injection |

**Command Injection**
| Pattern | Description |
|---------|-------------|
| `$(command)` | Command substitution with dangerous commands |
| `` `command` `` | Backtick execution |
| `eval()` / `exec()` | Dynamic code execution |
| `os.system()` | System calls with variables |

**Sensitive File Access**
| Pattern | Description |
|---------|-------------|
| `/etc/passwd`, `/etc/shadow` | System auth files |
| `~/.ssh/`, `id_rsa` | SSH keys |
| `~/.aws/credentials` | Cloud credentials |
| `/proc/self/environ` | Environment variables |

**Network Operations**
| Pattern | Description |
|---------|-------------|
| `nmap`, `masscan` | Port scanning |
| `nc -l -p` | Netcat listeners |
| `iptables -F` | Firewall flush |

## Custom Regex Patterns

Define your own patterns to detect organization-specific sensitive data.

### Creating Patterns

1. Go to **Settings** → **Security** tab
2. Expand **Custom Regex Patterns**
3. Click **Add Pattern**
4. Configure:
   - **Name**: Human-readable identifier
   - **Pattern**: JavaScript regex (automatically uses `gi` flags)
   - **Type**: `secret`, `pii`, `injection`, or `other`
   - **Action**: `warn`, `sanitize`, or `block`
   - **Confidence**: 0.0 – 1.0 (affects severity)
5. Test against sample text
6. Save

### Example Patterns

**Internal Project Codes**

```
Name: Project Code
Pattern: PROJECT-[A-Z]{3}-\d{4}
Type: other
Action: warn
Confidence: 0.7
```

**Internal Domain**

```
Name: Internal URLs
Pattern: https?://[^/]*\.internal\.company\.com
Type: other
Action: warn
Confidence: 0.6
```

**Custom API Key Format**

```
Name: MyService API Key
Pattern: myservice_[a-zA-Z0-9]{32}
Type: secret
Action: sanitize
Confidence: 0.95
```

**Employee ID**

```
Name: Employee ID
Pattern: EMP-\d{6}
Type: pii
Action: sanitize
Confidence: 0.85
```

**Database Connection String**

```
Name: DB Connection String
Pattern: (?:mysql|postgres|mongodb)://[^:]+:[^@]+@[^\s]+
Type: secret
Action: block
Confidence: 0.95
```

### Import/Export Patterns

Share patterns across teams:

1. **Export**: Click **Export** → save JSON file
2. **Import**: Click **Import** → select JSON file

Patterns are validated on import. Invalid patterns are skipped.

## Per-Session Security Policies

Override global settings for specific agents or projects.

### Setting Up

1. Right-click an agent in the Left Bar
2. Select **Security Settings...**
3. Toggle **Override global LLM Guard settings**
4. Configure overrides

### Use Cases

**Strict Mode for Sensitive Projects**

- Enable blocking mode
- Lower injection threshold to 50%
- Add project-specific ban patterns

**Relaxed Mode for Internal Testing**

- Switch to warn-only mode
- Disable URL scanning (testing internal services)
- Keep secret detection enabled

### Policy Inheritance

Session policies merge with global settings:

1. Session-specific values override global settings
2. Arrays (ban lists, custom patterns) are merged
3. Unspecified settings inherit from global

## Group Chat Inter-Agent Protection

When agents communicate in Group Chat, LLM Guard can scan messages passed between them.

### Why This Matters

Without inter-agent scanning, a compromised or manipulated agent could:

- Inject malicious instructions into another agent's context
- Exfiltrate data through carefully crafted messages
- Create prompt injection chains

### How It Works

1. Agent A generates a response
2. LLM Guard scans the response (output guard)
3. Before passing to Agent B, LLM Guard scans again (inter-agent guard)
4. Agent B receives the sanitized message

Findings are logged with `INTER_AGENT_` prefix in security events.

### Configuration

Enable in **Settings** → **Security** → **Group Chat Protection** → **Enable inter-agent scanning**

## Audit Log Export

Export security events for compliance, analysis, or sharing.

### Exporting

1. Open the **Security Events** panel (Right Bar → Security tab)
2. Click the **Export** button
3. Configure:
   - **Format**: JSON, CSV, or HTML
   - **Date Range**: All time, last 7/30 days, or custom
   - **Event Types**: Filter by scan type
   - **Minimum Confidence**: Filter by severity
4. Click **Export**
5. Choose save location

### Export Formats

| Format   | Best For                                       |
| -------- | ---------------------------------------------- |
| **JSON** | Machine processing, importing into other tools |
| **CSV**  | Spreadsheets, data analysis                    |
| **HTML** | Human-readable reports, sharing                |

## Configuration Import/Export

Share LLM Guard settings across devices or teams.

### Exporting

1. **Settings** → **Security** → **Configuration** section
2. Click **Export**
3. Save the JSON file

### Importing

1. **Settings** → **Security** → **Configuration** section
2. Click **Import**
3. Select a JSON file
4. Review any validation warnings
5. Settings are applied immediately

The export includes:

- All toggle states
- Thresholds
- Ban lists
- Custom patterns
- Group Chat settings

## Security Recommendations

LLM Guard analyzes your security events and configuration to provide actionable recommendations.

### Accessing Recommendations

1. **Settings** → **Security** tab
2. Expand **Security Recommendations**
3. Review recommendations sorted by severity

### Recommendation Categories

| Category             | Triggers                           |
| -------------------- | ---------------------------------- |
| **Blocked Content**  | High volume of blocked prompts     |
| **Secret Detection** | Frequent secret findings           |
| **PII Detection**    | High PII volume                    |
| **Prompt Injection** | Injection attempts detected        |
| **Code Patterns**    | Dangerous code in responses        |
| **URL Detection**    | Suspicious URLs detected           |
| **Configuration**    | Disabled features, high thresholds |
| **Usage Patterns**   | No events (guard may be unused)    |

### Dismissing Recommendations

Click the **X** on any recommendation to dismiss it. Dismissed recommendations won't reappear during the current session.

## Best Practices

### For Development Teams

1. **Start with Warn mode** — Learn what gets flagged before enabling sanitization
2. **Add custom patterns** — Define patterns for internal credentials, project names, and data formats
3. **Export configurations** — Share standardized security settings across the team
4. **Review security events weekly** — Look for patterns and adjust thresholds

### For Sensitive Environments

1. **Enable Block mode** — Prevent any flagged content from passing through
2. **Lower injection threshold** — Catch more subtle injection attempts (50-60%)
3. **Enable all detection types** — Leave all scanners active
4. **Set up per-session policies** — Apply stricter settings to sensitive projects
5. **Export audit logs** — Maintain compliance records

### Reducing False Positives

1. **Raise injection threshold** — If legitimate prompts are flagged, try 75-85%
2. **Disable URL shortener warnings** — If you frequently use bit.ly, etc.
3. **Add exceptions to ban lists** — Use negative patterns or session policies
4. **Review custom pattern confidence** — Lower confidence for broad patterns

### Balancing Security and Usability

| Risk Level | Recommended Settings                            |
| ---------- | ----------------------------------------------- |
| **Low**    | Warn mode, 70% threshold, optional URL scanning |
| **Medium** | Sanitize mode, 65% threshold, all scanners on   |
| **High**   | Block mode, 50% threshold, per-session policies |

## Troubleshooting

### Common Issues

**"Legitimate content is being blocked"**

1. Check Security Events to see what triggered the block
2. Review the finding type and confidence
3. Options:
   - Raise the relevant threshold
   - Switch from Block to Sanitize or Warn mode
   - Add a session policy for this project

**"Secrets aren't being detected"**

1. Verify **Redact Secrets** is enabled (Input and/or Output)
2. Check if the secret format is recognized
3. Add a custom pattern for your specific secret format

**"PII anonymization breaks my prompts"**

1. Ensure **De-anonymize PII** is enabled on output
2. The AI should work with placeholders; original values are restored in responses
3. If this doesn't work for your use case, disable PII anonymization for that session

**"Too many URL warnings"**

1. URL shorteners trigger low-confidence warnings by default
2. Option 1: Accept the warnings (they don't block content in Warn mode)
3. Option 2: Disable URL scanning if your workflow uses many shortened URLs

**"Prompt injection false positives"**

1. Technical discussions about prompts can trigger detection
2. Raise the threshold to 80-85% for fewer false positives
3. Consider session policies for AI research projects

**"Custom pattern not matching"**

1. Test the pattern in the pattern editor with sample text
2. Remember: patterns use JavaScript regex syntax
3. Patterns are applied with `gi` flags (global, case-insensitive)
4. Escape special characters: `\.` `\[` `\(` etc.

### Security Events Not Appearing

1. Verify LLM Guard is enabled
2. Check that relevant detection types are enabled
3. Events only appear when findings are detected
4. Clear filters in the Security Events panel

### Performance Considerations

LLM Guard scanning adds minimal latency (<10ms for most prompts). If you experience slowdowns:

1. Disable detection types you don't need
2. Reduce custom pattern count or simplify regex
3. Consider using session policies to enable full scanning only where needed

## Architecture

LLM Guard runs entirely locally in Maestro's main process:

- No external API calls for scanning
- Patterns and findings stay on your machine
- Works offline
- No data leaves your device

Key components:

- `src/main/security/llm-guard/` — Core detection engines
- `src/main/security/security-logger.ts` — Event logging and export
- `src/renderer/components/Settings/tabs/LlmGuardTab.tsx` — Settings UI
- `src/renderer/components/SecurityEventsPanel.tsx` — Events viewer
