# Retired Agent Flow fixture

`agent-flow-0.3.0.json.gz` is a gzip-compressed JSON map of the four public files
from `examples/plugins/agent-flow/` at `fef3c70ec9ed666da72405ff255c1553b5b02373^`
(the parent of #1740). It contains no profile data or release signature. Tests
materialize it only in an isolated temporary directory; it is never bundled.

Regenerate from the public repository history with Python:

```python
import gzip, json, pathlib, subprocess

files = {
    name: subprocess.check_output([
        "git", "show", "fef3c70ec^:examples/plugins/agent-flow/" + name
    ]).decode()
    for name in ["README.md", "main.js", "panel.html", "plugin.json"]
}
pathlib.Path("src/__tests__/main/plugins/fixtures/agent-flow-0.3.0.json.gz").write_bytes(
    gzip.compress(json.dumps(files).encode(), mtime=0)
)
```
