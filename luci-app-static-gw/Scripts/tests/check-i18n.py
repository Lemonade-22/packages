#!/usr/bin/env python3
"""Verify that every _t('...') string used by the view is translated.

Checks both the committed EN_MAP in the view and the po file, so the built-in
fallback can never drift from the translation source.

Usage: python3 Scripts/tests/check-i18n.py
Exit code 1 when something is missing.
"""
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
js = (root / "htdocs/luci-static/resources/view/network/static-gw.js").read_text(encoding="utf-8")
po = (root / "po/en/luci-app-static-gw.po").read_text(encoding="utf-8")

used = set(re.findall(r"_t\('((?:[^'\\]|\\.)*)'\)", js))
used |= set(re.findall(r'_t\("((?:[^"\\]|\\.)*)"\)', js))

po_ids = set(re.findall(r'^msgid "(.+)"$', po, re.M))
po_translated = {
    k for k, v in re.findall(r'^msgid "(.+)"\nmsgstr "(.+)"$', po, re.M) if v
}

# msgids present in the generated in-file map
map_ids = set(re.findall(r'^\t"((?:[^"\\]|\\.)*)":', js, re.M))

missing_po = sorted(u for u in used if u and u not in po_ids)
missing_map = sorted(u for u in used if u and u not in map_ids)
untranslated = sorted(u for u in used if u and u in po_ids and u not in po_translated)

print(f"strings used in view   : {len(used)}")
print(f"msgids in po           : {len(po_ids)}")
print(f"entries in EN_MAP      : {len(map_ids)}")
print(f"missing from po        : {len(missing_po)}")
for m in missing_po:
    print("   MISSING-PO :", m)
print(f"missing from EN_MAP    : {len(missing_map)}")
for m in missing_map:
    print("   MISSING-MAP:", m)
print(f"untranslated in po     : {len(untranslated)}")
for m in untranslated:
    print("   UNTRANSLATED:", m)

sys.exit(1 if (missing_po or missing_map or untranslated) else 0)
