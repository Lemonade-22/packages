#!/usr/bin/env python3
"""Validate the English translation package without gettext tooling.

Checks that po2lmo would accept the catalogue and that the UI would render
correct English:

  * header has charset=UTF-8 and Language: en
  * no duplicate msgids, no empty msgstr outside the header
  * %s / %d placeholders match between msgid and msgstr
  * leading/trailing whitespace is preserved (the UI concatenates strings)
  * no untranslated (CJK) text left in msgstr
  * po/templates .pot and po/en .po describe the same msgids
  * every _t('...') in the view is translated
  * the in-view EN_MAP equals the po pairs exactly

Usage: python3 Scripts/tests/check-po.py
Exit code 1 when a check fails.
"""
import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
po_path = root / "po/en/luci-app-static-gw.po"
pot_path = root / "po/templates/luci-app-static-gw.pot"
view_path = root / "htdocs/luci-static/resources/view/network/static-gw.js"

CJK = re.compile(r"[\u3400-\u9fff\uf900-\ufaff]")
PLACEHOLDER = re.compile(r"%(?:\d+\$)?[-+ #0]*\d*(?:\.\d+)?[sd]")


def parse_po(text):
    """Return list of (msgid, msgstr) pairs, handling quoted continuations."""
    entries = []
    msgid = msgstr = None
    field = None
    for raw in text.splitlines():
        line = raw.rstrip("\r")
        if line.startswith("msgid "):
            if msgid is not None and msgstr is not None:
                entries.append((msgid, msgstr))
            msgid = _unquote(line[6:])
            msgstr = None
            field = "id"
        elif line.startswith("msgstr "):
            msgstr = _unquote(line[7:])
            field = "str"
        elif line.startswith('"'):
            fragment = _unquote(line)
            if field == "id":
                msgid += fragment
            elif field == "str":
                msgstr += fragment
    if msgid is not None and msgstr is not None:
        entries.append((msgid, msgstr))
    return entries


def _unquote(quoted):
    quoted = quoted.strip()
    if len(quoted) >= 2 and quoted[0] == '"' and quoted[-1] == '"':
        quoted = quoted[1:-1]
    return quoted.encode("utf-8").decode("unicode_escape").encode("latin-1").decode("utf-8") if "\\" in quoted else quoted


errors = []
warnings = []

po_text = po_path.read_text(encoding="utf-8")
pairs = parse_po(po_text)
header = pairs[0] if pairs else ("", "")
pairs = [p for p in pairs if p[0] != ""]

# ---- header ----
if "charset=UTF-8" not in header[1]:
    errors.append("po header: missing charset=UTF-8")
if "Language: en" not in header[1]:
    errors.append("po header: missing Language: en")

# ---- duplicates / empties ----
ids = [k for k, _ in pairs]
dupes = sorted({i for i in ids if ids.count(i) > 1})
if dupes:
    errors.append(f"duplicate msgids: {dupes}")

for k, v in pairs:
    if not v:
        errors.append(f"empty msgstr: {k!r}")

# ---- placeholders / whitespace / untranslated ----
for k, v in pairs:
    if sorted(PLACEHOLDER.findall(k)) != sorted(PLACEHOLDER.findall(v)):
        errors.append(f"placeholder mismatch: {k!r} -> {v!r}")
    if k[:1] == " " and v[:1] != " ":
        errors.append(f"leading space lost: {k!r} -> {v!r}")
    if k[-1:] == " " and v[-1:] != " ":
        errors.append(f"trailing space lost: {k!r} -> {v!r}")
    if CJK.search(v):
        errors.append(f"untranslated (CJK) msgstr: {k!r} -> {v!r}")
    if v == k and re.search(r"[A-Za-z]", k):
        warnings.append(f"msgstr identical to msgid: {k!r}")

# ---- pot vs po ----
pot_ids = {k for k, _ in parse_po(pot_path.read_text(encoding="utf-8")) if k != ""}
po_ids = set(ids)
if pot_ids != po_ids:
    only_pot = sorted(pot_ids - po_ids)
    only_po = sorted(po_ids - pot_ids)
    errors.append(f"pot/po msgid mismatch: only-pot={only_pot[:5]} only-po={only_po[:5]}")

# ---- view cross-check ----
js = view_path.read_text(encoding="utf-8")
used = set(re.findall(r"_t\('((?:[^'\\]|\\.)*)'\)", js))
used |= set(re.findall(r'_t\("((?:[^"\\]|\\.)*)"\)', js))
used.discard("")
missing = sorted(used - po_ids)
if missing:
    errors.append(f"_t() strings missing from po: {missing[:5]}")

map_pairs = dict(re.findall(r'^\t"((?:[^"\\]|\\.)*)": "((?:[^"\\]|\\.)*)",', js, re.M))
po_dict = {k: v for k, v in pairs}
map_missing = sorted(set(po_dict) - set(map_pairs))
map_extra = sorted(set(map_pairs) - set(po_dict))
map_diff = sorted(k for k in set(map_pairs) & set(po_dict) if map_pairs[k] != po_dict[k])
if map_missing:
    errors.append(f"EN_MAP missing {len(map_missing)} po msgids, e.g. {map_missing[:3]}")
if map_extra:
    errors.append(f"EN_MAP has {len(map_extra)} keys not in po, e.g. {map_extra[:3]}")
if map_diff:
    errors.append(f"EN_MAP value differs from po for {len(map_diff)} keys, e.g. {map_diff[:3]}")

# ---- report ----
print(f"po entries           : {len(pairs)}")
print(f"pot entries          : {len(pot_ids)}")
print(f"_t() strings used    : {len(used)}")
print(f"EN_MAP entries       : {len(map_pairs)}")
print(f"errors               : {len(errors)}")
print(f"warnings             : {len(warnings)}")

for e in errors:
    print("  ERROR:", e)
for w in warnings[:10]:
    print("  WARN :", w)

print("\nSample translations:")
for k, v in pairs[:5]:
    print(f"  {k}  ->  {v}")

sys.exit(1 if errors else 0)
