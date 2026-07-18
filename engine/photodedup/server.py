from __future__ import annotations

import argparse
import atexit
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import sys

from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from .api import create_app


def _register_diagnostics() -> None:
    def on_exit() -> None:
        exc_type, _, _ = sys.exc_info()
        exc_name = exc_type.__name__ if exc_type is not None else "none"
        print(f"[diag] atexit fired exc_info={exc_name}", file=sys.stderr, flush=True)

    def make_signal_handler(sig: signal.Signals, previous_handler: signal.Handlers):
        def handler(signum: int, frame: object) -> None:
            print(f"[diag] signal received: {signum}", file=sys.stderr, flush=True)
            if callable(previous_handler):
                previous_handler(signum, frame)
                return
            if previous_handler == signal.SIG_DFL:
                signal.signal(sig, signal.SIG_DFL)
                os.kill(os.getpid(), signum)

        return handler

    atexit.register(on_exit)
    for sig in (signal.SIGTERM, signal.SIGINT, getattr(signal, "SIGBREAK", None)):
        if sig is None:
            continue
        previous_handler = signal.getsignal(sig)
        signal.signal(sig, make_signal_handler(sig, previous_handler))


def default_data_dir() -> Path:
    return Path.home() / ".local" / "share" / "photo-dedup-desktop"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="photodedup-sidecar")
    parser.add_argument("--data-dir", type=Path, default=default_data_dir())
    args = parser.parse_args(argv)

    _register_diagnostics()

    token = secrets.token_hex(16)
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    port = int(sock.getsockname()[1])

    app = create_app(args.data_dir, token)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    print(json.dumps({"port": port, "token": token}), flush=True)
    config = uvicorn.Config(
        app,
        host="127.0.0.1",
        port=port,
        log_level=os.environ.get("PHOTODEDUP_LOG_LEVEL", "warning"),
        access_log=True,
    )
    server = uvicorn.Server(config)
    server.run(sockets=[sock])
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
