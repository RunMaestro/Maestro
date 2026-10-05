"""Linux CLI observation: sealed candidates, isolated namespaces, enforced resources.

The project is read-only context; accepted artifacts are additionally sealed.
Toolchain mounts are pinned before launch. Missing kernel, bubblewrap, or
user-manager controls are errors, never an unsandboxed fallback.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid
from contextlib import ExitStack
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


class IsolationError(RuntimeError):
    """No trustworthy, complete observation was obtained."""


class CandidateError(RuntimeError):
    """The candidate violated its own contract; a definite, repairable failure rather than a missing observation."""


class PolicyViolation(CandidateError):
    """The validation target is outside the operator-declared workspace boundary."""


@dataclass(frozen=True, slots=True)
class CliIsolationLimits:
    timeout_seconds: float = 600
    output_bytes: int = 100_000
    artifact_bytes: int = 64 * 1024 * 1024
    artifact_count: int = 256
    scratch_bytes: int = 256 * 1024 * 1024
    # Real project suites (bun, pytest with native math, node) spawn many threads; keep the ceiling bounded but usable.
    memory_bytes: int = 2 * 1024 * 1024 * 1024
    processes: int = 256


@dataclass(frozen=True, slots=True)
class IsolatedCliResult:
    returncode: int
    stdout: str
    stderr: str
    artifacts: tuple[tuple[Path, str, int], ...]
    isolation: dict[str, object]


def _descriptor(stack: ExitStack, fd: int) -> int:
    stack.callback(os.close, fd)
    return fd


def _snapshot(
    stack: ExitStack, workspace: Path, paths: Sequence[Path], limits: CliIsolationLimits,
) -> tuple[list[str], list[int], tuple[tuple[Path, str, int], ...]]:

    import ctypes
    import fcntl

    # Portable CPython builds can omit these wrappers despite kernel/libc support.
    create_memfd = ctypes.CDLL(None, use_errno=True).memfd_create
    create_memfd.argtypes = [ctypes.c_char_p, ctypes.c_uint]
    create_memfd.restype = ctypes.c_int
    if len(paths) > limits.artifact_count:
        raise IsolationError("CLI validation artifact manifest exceeds its limit")
    root_fd = _descriptor(stack, os.open(workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))
    if Path(os.readlink(f"/proc/self/fd/{root_fd}")) != workspace:
        raise PolicyViolation("Validation target changed while its trusted-root scope was checked")
    mounts: list[str] = ["--dir", "/workspace"]
    descriptors: list[int] = [root_fd]
    observed: list[tuple[Path, str, int]] = []
    seen: set[Path] = set()
    remaining = limits.artifact_bytes
    for path in paths:
        if not path.is_relative_to(workspace):
            raise CandidateError(f"Candidate artifact {path} is outside the validation target {workspace}; "
                "artifacts must be files inside the folder the oracle command runs in")
        relative = path.relative_to(workspace)
        if not relative.parts or ".." in relative.parts or relative in seen:
            raise IsolationError("Candidate paths must be unique files inside the accepted workspace")
        seen.add(relative)
        with ExitStack() as source_stack:
            parent_fd = root_fd
            try:
                for part in relative.parts[:-1]:
                    parent_fd = _descriptor(source_stack, os.open(
                        part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd,
                    ))
                source_fd = _descriptor(source_stack, os.open(
                    relative.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent_fd,
                ))
            except FileNotFoundError:
                raise CandidateError(f"Claimed artifact {relative} does not exist in the validation target") from None
            before = os.fstat(source_fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size > remaining:
                raise IsolationError("Candidate contains a non-regular file or exceeds its snapshot limit")
            # MFD_CLOEXEC | MFD_ALLOW_SEALING: no on-disk snapshot or mutable pathname.
            frozen_fd = create_memfd(b"guardian-candidate", 0x3)
            if frozen_fd < 0:
                error = ctypes.get_errno()
                raise OSError(error, os.strerror(error))
            _descriptor(stack, frozen_fd)
            digest = hashlib.sha256()
            size = 0
            while chunk := os.read(source_fd, min(1024 * 1024, remaining + 1)):
                remaining -= len(chunk)
                if remaining < 0:
                    raise IsolationError("Candidate exceeds its snapshot limit")
                digest.update(chunk)
                size += len(chunk)
                view = memoryview(chunk)
                while view:
                    view = view[os.write(frozen_fd, view):]
            after = os.fstat(source_fd)
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_size, after.st_mtime_ns, after.st_ctime_ns,
            ):
                raise IsolationError("Candidate changed while its immutable snapshot was captured")
            # Linux F_ADD_SEALS and F_SEAL_{SEAL,SHRINK,GROW,WRITE}.
            fcntl.fcntl(frozen_fd, 1033, 0xF)
            os.lseek(frozen_fd, 0, os.SEEK_SET)
            mounts.extend(["--perms", "0555" if before.st_mode & 0o111 else "0444",
                           "--ro-bind-data", str(frozen_fd), "/workspace/" + relative.as_posix()])
            descriptors.append(frozen_fd)
            observed.append((path, digest.hexdigest(), size))
    return mounts, descriptors, tuple(observed)


def _verify_scope(pid: int, unit: str, limits: CliIsolationLimits) -> dict[str, object]:
    membership = Path(f"/proc/{pid}/cgroup").read_text(encoding="ascii").strip()
    if not membership.startswith("0::/") or "\n" in membership:
        raise IsolationError("CLI isolation requires unified cgroup v2")
    relative = Path(membership[4:])
    if ".." in relative.parts or relative.name != unit:
        raise IsolationError("Candidate is not in its owned validation scope")
    group = Path("/sys/fs/cgroup") / relative
    measured = {
        name: (group / name).read_text(encoding="ascii").strip()
        for name in ("memory.max", "memory.swap.max", "pids.max", "cpu.max")
    }
    if measured["memory.max"] != str(limits.memory_bytes) or measured["memory.swap.max"] != "0":
        raise IsolationError("Candidate memory/swap limits were not enforced")
    if measured["pids.max"] != str(limits.processes):
        raise IsolationError("Candidate process limit was not enforced")
    quota, period = measured["cpu.max"].split()
    if quota == "max" or int(quota) > int(period):
        raise IsolationError("Candidate CPU limit was not enforced")
    return {"unit": unit, "cgroup": membership[3:], "limits": measured}


def _capture(
    process: subprocess.Popen[bytes], status_fd: int, release_fd: int,
    unit: str, limits: CliIsolationLimits, deadline: float,
) -> tuple[bytes, bytes, dict[str, object]]:
    assert process.stdout is not None and process.stderr is not None
    streams = {"stdout": bytearray(), "stderr": bytearray(), "status": bytearray()}
    isolation: dict[str, object] = {}
    truncated = {"stdout": False, "stderr": False}
    read_only_write_detected = False
    stderr_tail = b""
    released = False
    exit_status: int | None = None
    with selectors.DefaultSelector() as selector:
        for stream, name in ((process.stdout, "stdout"), (process.stderr, "stderr"), (status_fd, "status")):
            os.set_blocking(stream if isinstance(stream, int) else stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise IsolationError("CLI observation exceeded its wall-time allowance")
            for key, _ in selector.select(min(remaining, 0.1)):
                chunk = os.read(key.fd, 16384)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                name = key.data
                if name == "status":
                    streams[name].extend(chunk)
                else:
                    if name == "stderr" and not read_only_write_detected:
                        diagnostic = (stderr_tail + chunk).lower()
                        read_only_write_detected = b"read-only file system" in diagnostic or b"erofs" in diagnostic
                        stderr_tail = diagnostic[-20:]
                    available = max(0, limits.output_bytes - len(streams[name]))
                    streams[name].extend(chunk[:available])
                    if len(chunk) > available:
                        truncated[name] = True
                if len(streams["status"]) > 8192:
                    raise IsolationError("Invalid isolation status stream")
                if name != "status":
                    continue
                while b"\n" in streams["status"]:
                    line, _, tail = streams["status"].partition(b"\n")
                    streams["status"] = bytearray(tail)
                    record = json.loads(line)
                    if "child-pid" in record:
                        if released or type(record["child-pid"]) is not int or record["child-pid"] <= 1:
                            raise IsolationError("Invalid candidate process identity")
                        for namespace in ("cgroup", "ipc", "mnt", "net", "pid", "uts"):
                            identity = record.get(namespace + "-namespace")
                            if type(identity) is not int or identity == os.stat(f"/proc/self/ns/{namespace}").st_ino:
                                raise IsolationError(f"Candidate {namespace} namespace is not isolated")
                        isolation = {"runner": "bubblewrap", "namespaces": record,
                                     **_verify_scope(record["child-pid"], unit, limits)}
                        os.write(release_fd, b"1")
                        released = True
                    elif "exit-code" in record:
                        if not released or exit_status is not None or type(record["exit-code"]) is not int:
                            raise IsolationError("Invalid isolation exit receipt")
                        exit_status = record["exit-code"]
                    else:
                        raise IsolationError("Unknown isolation status record")
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise IsolationError("CLI observation exceeded its wall-time allowance")
    process.wait(timeout=remaining)
    if not released or exit_status != process.returncode or streams["status"].strip():
        raise IsolationError("No complete isolation receipt: " + streams["stderr"].decode("utf-8", "replace")[:2000])
    isolation["outputTruncated"] = truncated
    isolation["readOnlyWriteDetected"] = read_only_write_detected
    return bytes(streams["stdout"]), bytes(streams["stderr"]), isolation


# System tool directories visible in the sandbox, and user-level toolchain installs the service PATH usually omits.
_SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin"
_USER_TOOL_DIRS = (".bun/bin", ".cargo/bin", ".deno/bin", "go/bin", ".local/bin")


def _program_index(command: Sequence[str]) -> int:
    """Index of the program env launches (`env [-opts] NAME=VALUE ... program`), else 0."""
    if Path(command[0]).name != "env":
        return 0
    for index, value in enumerate(command[1:], start=1):
        if not value.startswith("-") and "=" not in value:
            return index
    return 0


def _resolve_command(command: Sequence[str], workspace: Path | None = None) -> list[str]:
    """Make a bare program absolute at its real location when that lies outside /usr (a user install, or a
    /usr/local/bin symlink into one), so its install can be mounted read-only. System tools stay bare.
    A bare `python`/`python3` prefers the project's own virtualenv when the workspace has one, since that
    is where the project's test dependencies live and the system interpreter has none of them."""
    index = _program_index(command)
    program = command[index]
    if "/" in program:
        return list(command)
    if workspace is not None and program in ("python", "python3"):
        venv_python = workspace / ".venv" / "bin" / "python"
        if venv_python.is_file():
            return [*command[:index], str(venv_python), *command[index + 1:]]
    search = os.pathsep.join([_SYSTEM_PATH, os.environ.get("PATH", ""), *(str(Path.home() / tool) for tool in _USER_TOOL_DIRS)])
    found = shutil.which(program, path=search)
    if not found:
        return list(command)
    real = Path(found).resolve()
    return list(command) if real.is_relative_to("/usr") else [*command[:index], str(real), *command[index + 1:]]


def _toolchain_mounts(
    command: Sequence[str], workspace: Path, stack: ExitStack, descriptors: list[int],
) -> list[str]:
    """Read-only project interpreter: an absolute program outside the workspace (after any env prefix), its
    virtualenv, and the base Python that virtualenv names, at their host paths (symlink aliases included)."""
    first = Path(command[_program_index(command)])
    if not first.is_absolute() or first.is_relative_to("/usr"):
        return []
    venv = next((parent for parent in first.parents if (parent / "pyvenv.cfg").is_file()), None)
    if first.is_relative_to(workspace) and venv is None:
        return []
    roots: list[Path] = []
    aliases: list[Path] = [] if first.is_relative_to(workspace) else [first]
    if venv is not None:
        roots.append(venv)
        config_fd = _descriptor(stack, os.open(venv / "pyvenv.cfg", os.O_RDONLY | os.O_NONBLOCK))
        if not stat.S_ISREG(os.fstat(config_fd).st_mode):
            raise IsolationError("Toolchain configuration must be a regular file")
        config = os.read(config_fd, 8193)
        if len(config) > 8192:
            raise IsolationError("Toolchain configuration exceeds its 8192-byte limit")
        for line in config.decode("utf-8").splitlines():
            key, _, value = line.partition("=")
            if key.strip() == "home" and value.strip():
                aliases.append(Path(value.strip()))
    real = first.resolve(strict=True)
    install = real.parent
    if real.parent.name == "bin" and (real.parent.parent / "pyvenv.cfg").is_file():
        install = real.parent.parent
    elif real.parent.name == "bin" and any(
            parent.name == "uv" and parent.parent.name == "share" for parent in real.parents):
        install = real.parent.parent
    roots.append(install)
    import pwd
    homes = {Path(entry.pw_dir).resolve() for entry in pwd.getpwall() if entry.pw_dir.startswith("/")}
    homes.add(Path.home().resolve())
    mounts: list[str] = []
    bound: list[Path] = []
    for root in roots:
        resolved = root.resolve(strict=True)
        if (resolved == Path("/") or resolved.parent.name == "home"
                or any(home.is_relative_to(resolved) for home in homes)):
            if root == install:
                resolved = real
            else:
                continue
        if (resolved.is_relative_to(workspace) or resolved.is_relative_to("/usr")
                or any(resolved.is_relative_to(existing) for existing in bound)):
            continue
        fd = _descriptor(stack, os.open(resolved, os.O_PATH | os.O_NOFOLLOW))
        source = Path(f"/proc/self/fd/{fd}")
        if stat.S_ISLNK(os.fstat(fd).st_mode) or Path(os.readlink(source)) != resolved:
            raise IsolationError("Toolchain mount changed while its scope was checked")
        descriptors.append(fd)
        bound.append(resolved)
        mounts.extend(["--ro-bind", str(source), str(resolved)])
    linked: set[Path] = set()
    for path in aliases:
        for ancestor in (path, *path.parents):
            if ancestor in linked or not ancestor.is_symlink() or any(ancestor.is_relative_to(existing) for existing in bound):
                continue
            linked.add(ancestor)
            mounts.extend(["--symlink", str(ancestor.resolve()), str(ancestor)])
    return mounts


def run_isolated_cli(
    command: Sequence[str], workspace: Path, artifacts: Sequence[Path], *,
    timeout: float = 30, limits: CliIsolationLimits = CliIsolationLimits(),
    trusted_root: Path | None = None,
) -> IsolatedCliResult:
    """Observe an argv command against sealed artifacts; never execute on the host."""
    if trusted_root is None:
        raise PolicyViolation("Validation requires an operator-declared --trusted-root")
    trusted_root = trusted_root.resolve()
    requested_workspace = workspace.absolute()
    workspace = workspace.resolve(strict=True)
    if not workspace.is_relative_to(trusted_root):
        raise PolicyViolation(f"Validation target {workspace} is outside trusted root {trusted_root}")
    if sys.platform != "linux":
        raise IsolationError("CLI isolation requires the configured Linux validation host")
    if not math.isfinite(timeout) or not 0 < timeout <= limits.timeout_seconds:
        raise IsolationError("CLI timeout exceeds the validator's accepted allowance")
    if not command or any(not isinstance(value, str) or "\0" in value for value in command):
        raise IsolationError("CLI command must be a nonempty argv list")
    bwrap = shutil.which("bwrap")
    if bwrap is None or not Path("/usr/bin/systemd-run").is_file():
        raise IsolationError("Provision bubblewrap and a resource-controlling user manager before CLI validation")
    artifacts = [workspace / path.relative_to(requested_workspace)
                 if path.is_relative_to(requested_workspace) else path for path in artifacts]
    command = [str(workspace / Path(value).relative_to(requested_workspace))
               if Path(value).is_absolute() and Path(value).is_relative_to(requested_workspace)
               else value for value in command]
    unit = "guardian-validation-" + uuid.uuid4().hex + ".scope"
    environment = {
        "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "TZ": "UTC",
        "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}",
        "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{os.getuid()}/bus",
    }
    with ExitStack() as stack:
        mounts, artifact_fds, observed = _snapshot(stack, workspace, artifacts, limits)
        status_read, status_write = os.pipe()
        release_read, release_write = os.pipe()
        _descriptor(stack, status_read)
        _descriptor(stack, release_write)
        args = [
            "/usr/bin/systemd-run", "--user", "--scope", "--quiet", "--unit=" + unit,
            "--property=MemoryMax=" + str(limits.memory_bytes), "--property=MemorySwapMax=0",
            "--property=TasksMax=" + str(limits.processes), "--property=CPUQuota=100%",
            bwrap, "--unshare-user", "--disable-userns", "--assert-userns-disabled",
            "--unshare-pid", "--as-pid-1", "--unshare-net", "--unshare-ipc", "--unshare-uts",
            "--unshare-cgroup", "--new-session", "--die-with-parent", "--clearenv",
            "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin",
            "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
            "--proc", "/proc", "--dev", "/dev", "--size", str(limits.scratch_bytes), "--tmpfs", "/tmp",
            "--dir", "/home/validator", "--chdir", "/workspace",
        ]
        for name, value in {
            "PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home/validator",
            "TMPDIR": "/tmp", "XDG_CACHE_HOME": "/tmp/cache", "PYTHONPYCACHEPREFIX": "/tmp/pycache",
            "PYTHONNOUSERSITE": "1", "CI": "1", "LANG": "C.UTF-8", "TZ": "UTC",
            # The project is read-only: send common test-tool state to the writable scratch instead.
            "COVERAGE_FILE": "/tmp/.coverage", "PYTEST_ADDOPTS": "-p no:cacheprovider",
            "BUN_INSTALL_CACHE_DIR": "/tmp/bun-cache", "npm_config_cache": "/tmp/npm-cache",
            # Go: build cache in scratch; the module cache (deps and downloaded toolchains) is the
            # host's, mounted read-only below, so `go test` resolves everything offline.
            "GOCACHE": "/tmp/go-build", "GOPATH": "/tmp/gopath", "GOMODCACHE": "/home/validator/go/pkg/mod",
            "GOFLAGS": "-mod=mod", "GOTOOLCHAIN": "auto", "GOPROXY": "off", "GONOSUMDB": "*",
        }.items():
            args.extend(["--setenv", name, value])
        host_modcache = Path.home() / "go" / "pkg" / "mod"
        if host_modcache.is_dir():
            args.extend(["--ro-bind", str(host_modcache), "/home/validator/go/pkg/mod"])
        command = _resolve_command(command, workspace)
        argv = []
        for value in command:
            path = Path(value)
            argv.append("/workspace/" + path.relative_to(workspace).as_posix()
                        if path.is_absolute() and path.is_relative_to(workspace) else value)
        # The whole project is read-only context for its own tests; claimed artifacts are sealed over it below.
        args.extend(["--ro-bind", f"/proc/self/fd/{artifact_fds[0]}", "/workspace"])
        if not workspace.is_relative_to("/tmp"):
            # Editable installs name the project's real path; alias it to the same read-only view. Its parent
            # directories land on the read-only root, never in the writable /tmp scratch mount.
            args.extend(["--symlink", "/workspace", str(workspace)])
        args.extend(_toolchain_mounts(command, workspace, stack, artifact_fds))
        args.extend(mounts)
        args.extend(["--remount-ro", "/", "--json-status-fd", str(status_write),
                     "--block-fd", str(release_read), "--", *argv])
        deadline = time.monotonic() + timeout
        try:
            process = subprocess.Popen(
                args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=environment, pass_fds=(status_write, release_read, *artifact_fds), start_new_session=True,
            )
        finally:
            os.close(status_write)
            os.close(release_read)
        try:
            stdout, stderr, isolation = _capture(process, status_read, release_write, unit, limits, deadline)
        finally:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            if process.stdout is not None:
                process.stdout.close()
            if process.stderr is not None:
                process.stderr.close()
        return IsolatedCliResult(process.returncode, stdout.decode("utf-8", "replace"),
                                 stderr.decode("utf-8", "replace"), observed, isolation)

def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Observe a CLI oracle inside the Pianola sandbox")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--trusted-root")
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--artifact", action="append", default=[])
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    try:
        result = run_isolated_cli(command, Path(args.workspace), [Path(p) for p in args.artifact],
                                  timeout=args.timeout,
                                  trusted_root=Path(args.trusted_root) if args.trusted_root else None)
        payload = {"returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr,
                   "observed": True, "error": None, "timedOut": False,
                   "outputTruncated": result.isolation["outputTruncated"],
                   "readOnlyWriteDetected": result.isolation["readOnlyWriteDetected"]}
    except PolicyViolation as exc:
        payload = {"returncode": 1, "stdout": "", "stderr": str(exc), "observed": True,
                   "error": None, "timedOut": False, "policyViolation": str(exc)}
    except CandidateError as exc:
        # The oracle never ran, but the candidate is definitely wrong: a failed check, not an unknown.
        payload = {"returncode": 1, "stdout": "", "stderr": f"candidate contract: {exc}\n",
                   "observed": True, "error": None, "timedOut": False}
    except (RuntimeError, OSError, ValueError, subprocess.TimeoutExpired) as exc:
        message = str(exc)
        payload = {"returncode": None, "stdout": "", "stderr": "", "observed": False,
                   "error": message, "timedOut": "wall-time" in message or
                   isinstance(exc, (TimeoutError, subprocess.TimeoutExpired))}
    print(json.dumps(payload))


if __name__ == "__main__":
    main()
