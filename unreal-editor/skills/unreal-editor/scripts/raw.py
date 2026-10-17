"""Same as ue.py, but prints the raw MCP envelope - for when ue.py says `success: False` and the
reason is unclear (the bridge's real traceback is in there).

    python raw.py [--project DIR] [--url URL] < code
    python raw.py --call <toolset> <tool> [JSON|-]
"""
import os
import sys

sys.dont_write_bytecode = True  # no __pycache__ next to the skill
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ue  # noqa: E402

if __name__ == "__main__":
    if "-h" in sys.argv or "--help" in sys.argv:
        print(__doc__.strip())
        sys.exit(0)
    sys.exit(ue.main(sys.argv[1:], raw=True))
