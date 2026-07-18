from __future__ import annotations

import sys

from photodedup.server import main


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
