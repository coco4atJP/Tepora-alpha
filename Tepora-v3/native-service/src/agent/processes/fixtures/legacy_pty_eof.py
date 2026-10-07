"""Exercise Python <=3.9's PTY EOF behavior on Linux as well as BSD/macOS.

Independent behavioral emulator, not a vendored stdlib implementation.
Reference: https://github.com/python/cpython/blob/3.9/Lib/pty.py (_copy/spawn),
fixed in https://github.com/python/cpython/blob/3.10/Lib/pty.py.
Loaded as sitecustomize only by the regression's child interpreter. The legacy
copy loop drops the master from select on b'' but continues waiting for stdin.
Its spawn catches OSError from the loop before closing/reaping; current spawn
instead uses finally, so catch here to reproduce the same lifecycle.
"""
import errno
import os
import pty
import select

_read = os.read


def bsd_read(fd, size):
    try:
        return _read(fd, size)
    except OSError as error:
        if error.errno == errno.EIO and os.isatty(fd):
            return b""
        raise


def legacy_copy(master_fd, master_read, stdin_read):
    sources = {master_fd: (master_read, 1), 0: (stdin_read, master_fd)}
    try:
        while True:
            ready, _, _ = select.select(list(sources), [], [])
            for source in ready:
                reader, destination = sources[source]
                pending = reader(source)
                if not pending:
                    del sources[source]
                while pending:
                    pending = pending[os.write(destination, pending):]
    except OSError:
        pass


os.read = bsd_read
pty._copy = legacy_copy

with open("legacy-pty-loaded", "w") as marker:
    marker.write("ready")
