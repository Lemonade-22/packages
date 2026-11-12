#!/usr/bin/env python3
"""Remove the signing-key publishing block from Scripts/ci-build.sh.

The apk is still signed by the SDK (that is unavoidable), but the public key
is no longer shipped as a release asset, per the project requirement.
"""
from pathlib import Path

p = Path(__file__).resolve().parents[2] / "Scripts/ci-build.sh"
s = p.read_text(encoding="utf-8")

start = s.index("# ------------------------------------------------------------ signing key ----")
end = s.index("shopt -s nullglob", start) if "shopt -s nullglob" in s[start:] else None
# the block ends at the closing "fi\n\n" of the top-level if
marker = s.index("\nfi\n", start) + len("\nfi\n")
block = s[start:marker]
assert "signing-key.pem" in block, "unexpected block content"

replacement = """# The apk is signed with the SDK build key; a device does not trust it by
# default, so installing requires --allow-untrusted (or trusting the key
# manually). No key file is published as a release asset.
"""

s = s.replace(block, replacement, 1)
p.write_text(s, encoding="utf-8", newline="\n")
print("removed signing key publishing block")
