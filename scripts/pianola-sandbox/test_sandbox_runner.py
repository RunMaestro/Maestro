import json
import os
import shutil
import subprocess
import sys
import time
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace

import pytest
import sandbox_runner

pytestmark = pytest.mark.skipif(shutil.which("bwrap") is None, reason="bubblewrap required")
RUNNER = Path(__file__).with_name("sandbox_runner.py")


def observe(workspace, *command, timeout=30):
    completed = subprocess.run(
        [sys.executable, str(RUNNER), "--workspace", str(workspace), "--trusted-root", str(workspace),
         "--timeout", str(timeout),
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
        [sys.executable, str(RUNNER), "--workspace", str(tmp_path), "--trusted-root", str(tmp_path), "--timeout", "30",
         "--artifact", str(tmp_path / "answer.txt"), "--", "sh", "-c", "true"],
        capture_output=True, text=True, check=True,
    )
    result = json.loads(completed.stdout)
    assert result["observed"] is True
    assert result["returncode"] == 1
    assert "answer.txt" in result["stderr"]


def test_go_caches_are_writable_and_offline(tmp_path):
    """`go test` must run with a scratch build cache, the host module cache read-only, and no network."""
    result = observe(tmp_path, "sh", "-c", "printf '%s %s %s\\n' \"$GOCACHE\" \"$GOPROXY\" \"$GOTOOLCHAIN\"")
    assert result["observed"] is True
    assert result["stdout"].split() == ["/tmp/go-build", "off", "auto"]


def test_bare_python_prefers_the_project_venv(tmp_path):
    """A project's own virtualenv holds its test dependencies; the system python has none of them."""
    venv = tmp_path / ".venv"
    subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(venv)], check=True)
    result = observe(tmp_path, "python3", "-c", "import sys; print(sys.prefix)")
    assert result["observed"] is True, result
    assert result["returncode"] == 0, result
    assert result["stdout"].strip() == "/workspace/.venv"


def test_user_bin_does_not_expose_home(tmp_path):
    home = tmp_path / "home" / "u"
    tool = home / "bin" / "tool"
    tool.parent.mkdir(parents=True)
    tool.write_text("#!/bin/sh\necho ok\n")
    with ExitStack() as stack:
        mounts = sandbox_runner._toolchain_mounts([str(tool)], tmp_path / "workspace", stack, [])
        destinations = [mounts[i + 2] for i, arg in enumerate(mounts) if arg == "--ro-bind"]
        assert str(tool.parent) in destinations or str(tool) in destinations
        assert str(home) not in destinations


def test_verbose_success_keeps_observed_verdict(tmp_path):
    result = observe(tmp_path, "python3", "-c",
                     "import sys; sys.stdout.write('x' * 120000); sys.stderr.write('y' * 120000)")
    assert result["observed"] is True, result
    assert result["returncode"] == 0
    assert result["stdout"] == "x" * 100000
    assert result["stderr"] == "y" * 100000
    assert result["outputTruncated"] == {"stdout": True, "stderr": True}



def test_toolchain_bind_is_pinned_before_launch(tmp_path, monkeypatch):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    install = tmp_path / "install"
    install.mkdir()
    home = tmp_path / "home"
    home.mkdir()
    for directory in (install, home):
        shutil.copy2("/usr/bin/dash", directory / "sh")
    (home / "secret").write_text("HOME_SECRET_FIXTURE")
    monkeypatch.setattr("pwd.getpwall", lambda: [SimpleNamespace(pw_dir=str(home))])
    popen = subprocess.Popen

    def swap(*args, **kwargs):
        install.rename(tmp_path / "saved-install")
        install.symlink_to(home, target_is_directory=True)
        return popen(*args, **kwargs)

    monkeypatch.setattr(subprocess, "Popen", swap)
    result = sandbox_runner.run_isolated_cli(
        [str(install / "sh"), "-c",
         'if test -e "$1"; then cat "$1"; else echo sealed-toolchain; fi', "sh", str(install / "secret")],
        workspace, [], trusted_root=workspace,
    )
    assert result.returncode == 0
    assert result.stdout.strip() == "sealed-toolchain"


def test_symlink_workspace_keeps_artifacts_and_absolute_commands(tmp_path):
    workspace = tmp_path / "project"
    workspace.mkdir()
    (workspace / "answer.txt").write_text("ok")
    tool = workspace / "check"
    tool.write_text("#!/bin/sh\ncat answer.txt\n")
    tool.chmod(0o755)
    alias = tmp_path / "linked-project"
    alias.symlink_to(workspace, target_is_directory=True)
    completed = subprocess.run(
        [sys.executable, str(RUNNER), "--workspace", str(alias), "--trusted-root", str(workspace),
         "--artifact", str(alias / "answer.txt"), "--", str(alias / "check")],
        capture_output=True, text=True, check=True,
    )
    result = json.loads(completed.stdout)
    assert result["observed"] is True
    assert result["returncode"] == 0
    assert result["stdout"].strip() == "ok"


def test_missing_artifact_parent_is_a_candidate_failure(tmp_path):
    completed = subprocess.run(
        [sys.executable, str(RUNNER), "--workspace", str(tmp_path), "--trusted-root", str(tmp_path),
         "--artifact", str(tmp_path / "missing" / "answer.txt"), "--", "true"],
        capture_output=True, text=True, check=True,
    )
    result = json.loads(completed.stdout)
    assert result["observed"] is True
    assert result["returncode"] == 1
    assert result["error"] is None
    assert "missing/answer.txt" in result["stderr"]



@pytest.mark.parametrize("stream", ["stdout", "stderr"])
def test_single_verbose_stream_drains_and_keeps_failure(tmp_path, stream):
    result = observe(tmp_path, "python3", "-c",
                     f"import sys; sys.{stream}.write('x' * 2000000); sys.exit(7)")
    other = "stderr" if stream == "stdout" else "stdout"
    assert result["observed"] is True, result
    assert result["returncode"] == 7
    assert result[stream] == "x" * 100000
    assert result[other] == ""
    assert result["outputTruncated"] == {stream: True, other: False}


def test_timeout_kills_forked_setsid_child(tmp_path, monkeypatch):
    popen = subprocess.Popen
    child = None
    groups = []
    verify = sandbox_runner._verify_scope

    def verify_scope(*args):
        result = verify(*args)
        groups.append(Path("/sys/fs/cgroup") / str(result["cgroup"]).lstrip("/"))
        return result

    monkeypatch.setattr(sandbox_runner, "_verify_scope", verify_scope)

    def launch(*args, **kwargs):
        nonlocal child
        child = popen(*args, **kwargs)
        return child

    monkeypatch.setattr(subprocess, "Popen", launch)
    with pytest.raises(sandbox_runner.IsolationError, match="wall-time"):
        sandbox_runner.run_isolated_cli(
            ["python3", "-c",
             "import os,time; pid=os.fork(); os.setsid() if pid == 0 else None; time.sleep(30)"],
            tmp_path, [], timeout=0.5, trusted_root=tmp_path,
        )
    assert child is not None
    assert child.poll() is not None
    assert child.stdout.closed and child.stderr.closed
    assert groups, "Candidate never reached its verified resource scope"
    events = groups[0] / "cgroup.events"
    deadline = time.monotonic() + 3
    while events.exists() and "populated 1" in events.read_text():
        assert time.monotonic() < deadline, "Forked candidate survived sandbox termination"
        time.sleep(0.01)


@pytest.mark.parametrize("kind", ["traversal", "duplicate", "file-symlink", "parent-symlink", "directory", "fifo", "oversize", "count"])
def test_rejects_unsafe_artifact_manifest(tmp_path, kind):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    artifact = workspace / "answer"
    artifact.write_text("ok")
    limits = sandbox_runner.CliIsolationLimits(artifact_bytes=8, artifact_count=2)
    paths = [artifact]
    if kind == "traversal":
        paths = [workspace / ".." / "outside" / "answer"]
    elif kind == "duplicate":
        paths = [artifact, artifact]
    elif kind == "file-symlink":
        artifact.unlink()
        (outside / "answer").write_text("HOST_FIXTURE")
        artifact.symlink_to(outside / "answer")
    elif kind == "parent-symlink":
        (outside / "answer").write_text("HOST_FIXTURE")
        (workspace / "link").symlink_to(outside, target_is_directory=True)
        paths = [workspace / "link" / "answer"]
    elif kind == "directory":
        paths = [workspace]
    elif kind == "fifo":
        artifact.unlink()
        os.mkfifo(artifact)
    elif kind == "oversize":
        artifact.write_text("x" * 9)
    elif kind == "count":
        paths = [artifact] * 3
    with ExitStack() as stack, pytest.raises((sandbox_runner.IsolationError, OSError)):
        sandbox_runner._snapshot(stack, workspace, paths, limits)


@pytest.mark.parametrize("base_home", ["/", "home"])
def test_venv_config_does_not_mount_host_home(tmp_path, monkeypatch, base_home):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    home = tmp_path / "home" / "u"
    home.mkdir(parents=True)
    (home / "pyvenv.cfg").write_text(f"home = {base_home if base_home == '/' else home}\n")
    tool = home / "tool"
    tool.write_text("#!/bin/sh\necho ok\n")
    monkeypatch.setattr("pwd.getpwall", lambda: [SimpleNamespace(pw_dir=str(home))])
    with ExitStack() as stack:
        mounts = sandbox_runner._toolchain_mounts([str(tool)], workspace, stack, [])
        destinations = [mounts[i + 2] for i, arg in enumerate(mounts) if arg == "--ro-bind"]
        assert destinations == [str(tool)]


def test_invalid_pyvenv_config_returns_unknown_json(tmp_path):
    (tmp_path / "pyvenv.cfg").write_bytes(b"home = \xff")
    tool = tmp_path / "check"
    tool.write_text("#!/bin/sh\necho ok\n")
    tool.chmod(0o755)
    result = observe(tmp_path, str(tool))
    assert result["observed"] is False
    assert result["returncode"] is None
    assert result["error"]
    assert result["timedOut"] is False


def test_symlink_loop_target_returns_unknown_json(tmp_path):
    target = tmp_path / "loop"
    target.symlink_to(target)
    result = observe(target, "true")
    assert result["observed"] is False
    assert result["returncode"] is None
    assert result["error"]


def test_wait_timeout_returns_unknown_json(monkeypatch, capsys, tmp_path):
    def timeout(*args, **kwargs):
        raise subprocess.TimeoutExpired("sandbox", 0.5)

    monkeypatch.setattr(sandbox_runner, "run_isolated_cli", timeout)
    monkeypatch.setattr(sys, "argv", [str(RUNNER), "--workspace", str(tmp_path), "--", "true"])
    sandbox_runner.main()
    result = json.loads(capsys.readouterr().out)
    assert result["observed"] is False
    assert result["returncode"] is None
    assert result["error"]
    assert result["timedOut"] is True



@pytest.mark.parametrize("spelling", ["absolute", "dotdot", "symlink"])
def test_external_uv_venv_mounts_only_venv_and_install(tmp_path, spelling):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    install = tmp_path / "home" / "u" / ".local" / "share" / "uv" / "python" / "test-python"
    (install / "bin").mkdir(parents=True)
    tool = install / "bin" / "python3"
    tool.write_text("#!/bin/sh\necho ok\n")
    venv = tmp_path / "venv"
    (venv / "bin").mkdir(parents=True)
    (venv / "pyvenv.cfg").write_text(f"home = {install / 'bin'}\n")
    (venv / "bin" / "python3").symlink_to(tool)
    program = venv / "bin" / "python3"
    if spelling == "dotdot":
        program = venv / "bin" / ".." / "bin" / "python3"
    elif spelling == "symlink":
        alias = tmp_path / "venv-alias"
        alias.symlink_to(venv, target_is_directory=True)
        program = alias / "bin" / "python3"
    with ExitStack() as stack:
        fds = []
        mounts = sandbox_runner._toolchain_mounts(["env", "NAME=value", str(program)], workspace, stack, fds)
        binds = [(mounts[i + 1], mounts[i + 2]) for i, arg in enumerate(mounts) if arg == "--ro-bind"]
        assert {destination for _, destination in binds} == {str(venv), str(install)}
        assert {os.readlink(source) for source, _ in binds} == {str(venv), str(install)}
        assert len(fds) == 2



def test_oversize_venv_config_is_not_read_unbounded(tmp_path):
    (tmp_path / "pyvenv.cfg").write_bytes(b"#" * 8193)
    tool = tmp_path / "check"
    tool.write_text("#!/bin/sh\necho ok\n")
    tool.chmod(0o755)
    result = observe(tmp_path, str(tool))
    assert result["observed"] is False
    assert result["returncode"] is None
    assert "configuration exceeds" in result["error"]



def test_read_only_failure_is_detected_after_stderr_truncation(tmp_path):
    result = observe(tmp_path, "python3", "-c",
                     "import sys; sys.stderr.write('x' * 100001); sys.stderr.flush(); open('cannot-write', 'w')")
    assert result["observed"] is True
    assert result["returncode"] != 0
    assert result["outputTruncated"]["stderr"] is True
    assert "Read-only file system" not in result["stderr"]
    assert result["readOnlyWriteDetected"] is True


@pytest.mark.parametrize("marker", ["Read-only file system", "EROFS"])
def test_read_only_marker_spans_stderr_chunks(tmp_path, marker):
    split = len(marker) - 2
    result = observe(tmp_path, "python3", "-c",
                     f"import sys,time; sys.stderr.write('x' * 100001 + {marker[:split]!r}); "
                     f"sys.stderr.flush(); time.sleep(0.2); sys.stderr.write({marker[split:]!r}); sys.exit(1)")
    assert result["returncode"] == 1
    assert result["outputTruncated"]["stderr"] is True
    assert result["readOnlyWriteDetected"] is True


def test_stdout_read_only_marker_is_not_a_stderr_failure(tmp_path):
    result = observe(tmp_path, "python3", "-c",
                     "import sys; print('Read-only file system EROFS'); sys.exit(7)")
    assert result["observed"] is True
    assert result["returncode"] == 7
    assert result["readOnlyWriteDetected"] is False



@pytest.mark.parametrize("scenario", ["inside", "home", "symlink-escape", "missing"])
def test_trusted_root_policy(tmp_path, scenario):
    home = tmp_path / "home" / "dev"
    root = home / "project"
    root.mkdir(parents=True)
    workspace = root / "subproject"
    workspace.mkdir()
    if scenario == "home":
        workspace = home
    elif scenario == "symlink-escape":
        outside = tmp_path / "outside"
        outside.mkdir()
        workspace = root / "escape"
        workspace.symlink_to(outside, target_is_directory=True)
    trusted_args = [] if scenario == "missing" else ["--trusted-root", str(root)]
    completed = subprocess.run(
        [sys.executable, str(RUNNER), "--workspace", str(workspace), *trusted_args,
         "--", "sh", "-c", "echo launched"], capture_output=True, text=True, check=True,
    )
    result = json.loads(completed.stdout)
    assert result["observed"] is True
    assert result["error"] is None
    if scenario == "inside":
        assert result["returncode"] == 0
        assert result["stdout"].strip() == "launched"
        assert not result.get("policyViolation")
    else:
        assert result["returncode"] == 1
        assert result["policyViolation"]
        assert result["stdout"] == ""
        assert result["timedOut"] is False



def test_parent_replacement_cannot_escape_trusted_root(tmp_path, monkeypatch):
    trusted = tmp_path / "trusted"
    parent = trusted / "parent"
    workspace = parent / "project"
    workspace.mkdir(parents=True)
    outside = tmp_path / "outside"
    (outside / "project").mkdir(parents=True)
    snapshot = sandbox_runner._snapshot

    def replace_parent(*args, **kwargs):
        parent.rename(trusted / "saved-parent")
        parent.symlink_to(outside, target_is_directory=True)
        return snapshot(*args, **kwargs)

    def forbidden_launch(*args, **kwargs):
        pytest.fail("Policy rejection must happen before launching the oracle")

    monkeypatch.setattr(sandbox_runner, "_snapshot", replace_parent)
    monkeypatch.setattr(subprocess, "Popen", forbidden_launch)
    with pytest.raises(sandbox_runner.PolicyViolation, match="target changed"):
        sandbox_runner.run_isolated_cli(["true"], workspace, [], trusted_root=trusted)

