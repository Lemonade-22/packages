#!/usr/bin/env python3
"""Generate the built-in English fallback map from the .po file.

Source language is Simplified Chinese; `po/en/luci-app-static-gw.po` is the
single source of translation. LuCI's per-app i18n domain is not guaranteed to
be loaded for a standalone app, which leaves the UI untranslated, so the view
carries this map and applies it when the browser asks for English.

Run it whenever the .po changes:

    python3 Scripts/tests/gen-en-map.py > /tmp/en-map.js

The generated block is committed into the view, and check-i18n.py verifies it
stays in sync with the .po file.
"""
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[2]
po = (root / "po/en/luci-app-static-gw.po").read_text(encoding="utf-8")

entries = re.findall(r'^msgid "(.+)"\nmsgstr "(.+)"$', po, re.M)
entries = [(k, v) for k, v in entries if v]

print("const EN_MAP = {")
for k, v in sorted(entries):
    print(f"\t{json.dumps(k, ensure_ascii=False)}: {json.dumps(v, ensure_ascii=False)},")
print("};")
