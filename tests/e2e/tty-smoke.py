#!/usr/bin/env python3
"""Live PTY smoke for talon (T2 Task 20): boot, stream, approval escalation, goodbye.

Spawns `pnpm dsh --profile talon` on a real PTY with cwd = ../deepseek-harness
(the sibling checkout). Requires DEEPSEEK_API_KEY in the environment; the vitest
wrapper (tests/e2e/tty-smoke.e2e.ts) gates on that and skips otherwise.

Phases (each prints [ok]/[FAIL]; exit 0 only if every hard phase passes):
  1. Mount      idle hint 'enter send' appears (120s).
  2. Roundtrip  prompt for the single word READY; running hint (SOFT check),
                a fresh READY from the model (not the echoed prompt: any READY
                immediately preceded by 'word ' is the echo/committed prompt
                text and does not count), idle hint restored.
  3. Approval   HARD, the T2 DoD: a sandbox-denied `touch` outside the
                workspace -> escalation retry -> approval panel ('- approval'
                rule + '[1] allow once') -> send '1' -> audit line 'allowed
                once' + the marker file exists.
  4. Goodbye    /exit dispatches live; process exits 0 within the deadline and
                the captured output contains the goodbye line.

The approval phase creates ~/.talon-e2e-<pid> and removes it in `finally`.
Teardown: SIGTERM then SIGKILL on the child's process group; an ANSI-stripped
transcript tail is always printed for post-mortems.
"""

import fcntl
import os
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.abspath(os.path.join(HERE, "..", "..", "..", "deepseek-harness"))
MARKER = os.path.expanduser(f"~/.talon-e2e-{os.getpid()}")

ROUNDTRIP_PROMPT = b"Reply with exactly the single word READY"
APPROVAL_PROMPT = (
    f"Use the bash tool to run exactly: touch {MARKER} . That path is outside the workspace, "
    "so the sandbox will deny it; retry the SAME command once with sandbox_permissions escalation, "
    "justification 'talon T2 e2e smoke'. Do not ask me any questions."
)

# CSI / OSC / other ESC-prefixed sequences, for the human-readable tail.
ANSI = re.compile(
    rb"\x1b\[[0-9;?]*[ -/]*[@-~]"
    rb"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"
    rb"|\x1b[@-Z\\^_]"
)

buf = bytearray()

master, slave = pty.openpty()
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
proc = subprocess.Popen(
    ["pnpm", "dsh", "--profile", "talon"],
    cwd=HARNESS,
    stdin=slave,
    stdout=slave,
    stderr=slave,
    start_new_session=True,
    env=os.environ.copy(),
)
os.close(slave)


def pump(seconds):
    """Drain PTY output into buf for `seconds` (returns early once the child side is gone)."""
    end = time.time() + seconds
    while time.time() < end:
        try:
            readable, _, _ = select.select([master], [], [], 0.05)
        except OSError:
            return
        if not readable:
            continue
        try:
            chunk = os.read(master, 65536)
        except OSError:  # EIO after the child exits
            return
        if not chunk:
            return
        buf.extend(chunk)


def wait_for(needle, timeout, label, start=0, hard=True):
    """Pump until `needle` appears in buf[start:]. Returns the absolute offset
    just past the match (always truthy) or 0 on timeout."""
    deadline = time.time() + timeout
    while True:
        i = buf.find(needle, start)
        if i != -1:
            print(f"[ok] {label}")
            return i + len(needle)
        if time.time() >= deadline:
            print(f"[{'FAIL' if hard else 'soft'}] {label} (timeout {int(timeout)}s)")
            return 0
        pump(0.25)


def send(data, label):
    """Write to the PTY, then pump briefly: the app batches input sequences that
    arrive within ~10ms, so paced writes keep prompt text and Enter distinct."""
    os.write(master, data)
    print(f"[send] {label}")
    pump(0.2)


def strip_ansi(data):
    return ANSI.sub(b"", bytes(data)).replace(b"\r", b"").decode("utf-8", "replace")


def wait_for_fresh_ready(start, timeout):
    """A READY in buf[start:] NOT immediately preceded by 'word ' — that prefix
    marks the echoed/committed prompt text ('… the single word READY'), so the
    first unprefixed READY is the model's reply. Returns offset past it, else 0."""
    deadline = time.time() + timeout
    while True:
        pos = start
        while True:
            i = buf.find(b"READY", pos)
            if i == -1:
                break
            context = strip_ansi(buf[max(0, i - 48):i])
            if not context.endswith("word "):
                print("[ok] roundtrip: fresh READY from the model")
                return i + len(b"READY")
            pos = i + len(b"READY")
        if time.time() >= deadline:
            print(f"[FAIL] roundtrip: fresh READY from the model (timeout {int(timeout)}s)")
            return 0
        pump(0.25)


def main():
    # Phase 1: mount
    if not wait_for(b"enter send", 120, "mount: idle hint visible"):
        return 1

    # Phase 2: roundtrip
    mark = len(buf)
    send(ROUNDTRIP_PROMPT, "roundtrip prompt")
    send(b"\r", "Enter (dispatch roundtrip)")
    wait_for(b"esc interrupt", 15, "roundtrip: running hint (soft)", start=mark, hard=False)
    ready_end = wait_for_fresh_ready(mark, 120)
    if not ready_end:
        return 1
    if not wait_for(b"enter send", 60, "roundtrip: idle hint restored", start=ready_end):
        return 1

    # Phase 3: approval (HARD — the DoD). The panel must appear over the still-running turn.
    send(APPROVAL_PROMPT.encode(), "approval prompt")
    send(b"\r", "Enter (dispatch approval turn)")
    ok = wait_for(b"\xe2\x94\x80 approval", 180, "approval panel rule")          # '─ approval'
    ok = ok and wait_for(b"[1] allow once", 10, "approval options")
    if ok:
        time.sleep(0.3)
        send(b"1", "approve once")
        ok = wait_for(b"allowed once", 120, "approval audit line")
        deadline = time.time() + 30
        while ok and not os.path.exists(MARKER) and time.time() < deadline:
            pump(0.25)
        if not os.path.exists(MARKER):
            print("[FAIL] approved command did not create the marker file")
            ok = False
        else:
            print("[ok] approved command executed (marker exists)")

    # Phase 4: /exit + goodbye
    if ok:
        send(b"/exit", "typed /exit")
        send(b"\r", "Enter (/exit)")
        deadline = time.time() + 20
        while time.time() < deadline and proc.poll() is None:
            pump(0.25)
        pump(0.5)  # drain the goodbye tail written after tui.stop()
        ok = proc.poll() is not None and proc.returncode == 0
        print(f"[{'ok' if ok else 'FAIL'}] exit code {proc.returncode}")
        ok = ok and (b"To resume: dsh --profile talon" in buf)
        print(f"[{'ok' if ok else 'FAIL'}] goodbye line present")

    return 0 if ok else 1


if __name__ == "__main__":
    code = 1
    try:
        code = main()
    finally:
        try:
            if os.path.exists(MARKER):
                os.remove(MARKER)
                print(f"[cleanup] removed {MARKER}")
        except OSError as error:
            print(f"[cleanup] could not remove {MARKER}: {error}")
        if proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            deadline = time.time() + 5
            while proc.poll() is None and time.time() < deadline:
                pump(0.1)
            if proc.poll() is None:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait()
        print("---- transcript tail (ANSI stripped) ----")
        print(strip_ansi(buf)[-2500:])
        print("---- end tail ----")
    sys.exit(code)
