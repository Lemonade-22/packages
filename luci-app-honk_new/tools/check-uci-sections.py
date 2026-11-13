#!/usr/bin/env python3
"""
UCI 配置自检：同名 section 会让 uci 整份拒收，而且报错位置跟真正的问题
隔了几十行，症状又表现为「LuCI 菜单消失 / 页面 500」——排查成本极高。

这个脚本没有依赖，改完配置跑一次：
    python3 tools/check-uci-sections.py root/etc/config/honk_new

退出码非 0 表示有问题。
"""
import re
import sys
from collections import defaultdict

SECTION = re.compile(r"^config\s+(\S+)\s+'([^']+)'\s*$")
OPTION = re.compile(r"^\s+(?:option|list)\s+(\S+)(?:\s+'([^']*)')?\s*$")


def check(path):
    seen = defaultdict(list)
    problems = []

    with open(path, encoding="utf-8") as fh:
        for lineno, raw in enumerate(fh, 1):
            line = raw.rstrip("\n")
            m = SECTION.match(line)
            if m:
                seen[m.group(2)].append((lineno, m.group(1)))
                continue
            if line.strip() and not line.lstrip().startswith("#"):
                if not OPTION.match(line):
                    problems.append((lineno, "unrecognised line", line.strip()[:60]))

    for name, hits in seen.items():
        if len(hits) > 1:
            types = {t for _, t in hits}
            where = ", ".join(f"line {n} ({t})" for n, t in hits)
            kind = "same name, different types" if len(types) > 1 else "duplicate section"
            problems.append((hits[0][0], kind, f"'{name}': {where}"))

    return problems


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    failed = False
    for path in sys.argv[1:]:
        problems = check(path)
        if not problems:
            print(f"OK  {path}")
            continue
        failed = True
        print(f"FAIL {path}")
        for lineno, kind, detail in problems:
            print(f"  line {lineno}: {kind} -- {detail}")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
