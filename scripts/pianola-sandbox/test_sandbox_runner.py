import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.skipif(shutil.which("bwrap") is None, reason="bubblewrap required")
RUNNER = Path(__file__).with_name("sandbox_runner.py")


def observe(workspace, *command, timeout=30):
    completed = subprocess.run(
        [sys.executable, str(RUNNER), "--workspace", str(workspace), "--timeout", str(timeout),
         "--", *command], capture_output=True, text=True, check=True,
    )
    return json.loads(completed.stdout)


def test_success(tmp_path):
    result = observe(tmp_path, "sh", "-c", "echo ok")
    assert result["observed"] is True
    assert result["returncode"] == 0
    assert result["stdout"].strip() == "ok"


def test_workspace_read_only(tmp_path):
    result = observe(tmp_path, "sh", "-c", "echo x > f")
    assert result["observed"] is True
    assert result["returncode"] != 0
    assert "Read-only file system" in result["stderr"]
    assert not (tmp_path / "f").exists()


def test_missing_program(tmp_path):
    result = observe(tmp_path, "nonexistent-pianola-program")
    assert result["observed"] is False or (
        result["returncode"] == 127 and "No such file" in result["stderr"]
    )


def test_timeout(tmp_path):
    result = observe(tmp_path, "sh", "-c", "sleep 3", timeout=0.5)
    assert result["timedOut"] is True


def test_coverage_goes_to_scratch(tmp_path):
    result = observe(tmp_path, "sh", "-c", "printf '%s\\n' \"$COVERAGE_FILE\"")
    assert result["observed"] is True
    assert result["stdout"].strip().startswith("/tmp/")


def test_missing_claimed_artifact_is_a_candidate_failure(tmp_path):
    """A worker that never produced its claimed file is wrong, not unobservable."""
    completed = subprocess.run(
        [sys.executable, str(RUNNER), "--workspace", str(tmp_path), "--timeout", "30",
         "--artifact", str(tmp_path / "answer.txt"), "--", "sh", "-c", "true"],
        capture_output=True, text=True, check=True,
    )
    result = json.loads(completed.stdout)
    assert result["observed"] is True
    assert result["returncode"] == 1
    assert "answer.txt" in result["stderr"]
