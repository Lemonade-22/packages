#!/usr/bin/env python3
"""Regenerate the in-view EN_MAP from the .po file.

LuCI normally translates `_()` strings through the installed luci-i18n-*
package, but that domain is not reliably loaded for a standalone app, which
left the UI untranslated. The view therefore carries a generated map.

Source language is Simplified Chinese, and po/en/luci-app-static-gw.po stays
the single source of translation. Re-run this after editing the .po:

    python3 Scripts/tests/apply-en-fallback.py
"""
import json
import re
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
view = root / "htdocs/luci-static/resources/view/network/static-gw.js"

map_src = subprocess.run(
    [sys.executable, str(root / "Scripts/tests/gen-en-map.py")],
    capture_output=True, text=True, check=True,
).stdout.strip()

src = view.read_text(encoding="utf-8")

if "const EN_MAP = {" in src:
    start = src.index("const EN_MAP = {")
    end = src.index("\n};", start) + len("\n};")
    src = src[:start] + map_src + src[end:]
    view.write_text(src, encoding="utf-8")
    print("regenerated the existing EN_MAP block")
else:
    header = """// --- Built-in English fallback ------------------------------------------
// Source language is Simplified Chinese. po/en/luci-app-static-gw.po is the
// single source of translation; Scripts/tests/gen-en-map.py generates this
// map from it. LuCI's per-app i18n domain is not guaranteed to be loaded for
// a standalone app, so translate locally when the browser asks for English.
"""
    wanted = """const WANT_EN = (function() {
	const cands = [
		(typeof document !== 'undefined' && document.documentElement)
			? document.documentElement.getAttribute('lang') : null,
		(typeof navigator !== 'undefined') ? navigator.language : null,
		(typeof navigator !== 'undefined') ? navigator.userLanguage : null,
		(typeof L !== 'undefined' && L.env) ? L.env.lang : null
	];
	return cands.some(l => l && String(l).toLowerCase().indexOf('en') === 0);
})();

function _t(msgid) {
	if (WANT_EN && Object.prototype.hasOwnProperty.call(EN_MAP, msgid))
		return EN_MAP[msgid];
	return (typeof _ === 'function') ? _(msgid) : msgid;
}
"""
    marker = "const callHostHints = rpc.declare({"
    src = src.replace(
        marker,
        header + map_src + "\n" + wanted + "\n" + marker,
        1,
    )
    view.write_text(src, encoding="utf-8")
    print("inserted a new EN_MAP block")
