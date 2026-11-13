#!/usr/bin/env python3
"""Linux/WSL: python3 tools/test-regressions.py (requires uci and ucode)."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]

def run(args, **kwargs):
    return subprocess.run(args, text=True, capture_output=True, **kwargs)

with tempfile.TemporaryDirectory(prefix="honk-test-") as tmp:
    base = Path(tmp)
    scripts = base / "scripts"
    scripts.mkdir()
    for src in (ROOT / "root/usr/share/honk").glob("*"):
        if src.is_file():
            dst = scripts / src.name
            dst.write_text(src.read_text())
            dst.chmod(0o755)
    for script in scripts.glob("*.sh"):
        r = run(["sh", "-n", str(script)])
        assert r.returncode == 0, r.stderr
    cfg = base / "config"
    cfg.mkdir()
    output = base / "config.dae"
    env = dict(os.environ, UCI_CONFIG_DIR=str(cfg))
    def reset():
        (cfg / "honk").write_text((ROOT / "root/etc/config/honk").read_text())
        setval("config.enabled", "1")
        setval("infra.lan_interface", "br-test")
    def setval(key, value):
        r = run(["uci", "-c", str(cfg), "set", "honk." + key + "=" + value])
        assert r.returncode == 0, r.stderr
        run(["uci", "-c", str(cfg), "commit", "honk"], check=True)
    def generate(ok=True):
        r = run(["sh", str(scripts / "gen_dae.sh"), str(output)], env=env)
        assert (r.returncode == 0) == ok, r.stderr
        return output.read_text() if output.exists() else ""
    reset()
    text = generate()
    assert "dip(geoip:private) -> direct(must)" in text
    assert "fallback: proxy" in text
    for mode, rule in [("direct", "ipversion(6) -> direct"), ("block_global", "ipversion(6) -> block"), ("block", "ipversion(6) && dip(geoip:cn) -> direct"), ("proxy", None)]:
        setval("config.ipv6_mode", mode)
        text = generate()
        if rule:
            assert rule in text
        else:
            assert "ipversion(6) -> block" not in text
    reset()
    for key, value in {"wifi_test": "ssid_route", "wifi_test.enabled": "1", "wifi_test.source": "192.168.50.0/24", "wifi_test.target": "proxy"}.items():
        setval(key, value)
    assert "sip(192.168.50.0/24) -> proxy" in generate()
    custom = base / "custom.rules"
    custom.write_text("domain(suffix: example.org) -> direct\nfallback: proxy\n")
    setval("config.custom_rules_enabled", "1")
    setval("config.custom_rules_file", str(custom))
    text = generate()
    assert "domain(suffix: example.org) -> direct" in text
    assert "sip(192.168.50.0/24)" not in text
    reset()
    for key, value in {"sample.enabled": "1", "sample.name": "test-node", "sample.uri": "hy2://test@example.com:443", "testsub": "subscription", "testsub.enabled": "1", "testsub.tag": "testsub", "testsub.url": "https://example.com/sub", "proxy.members": "test-node", "proxy.providers": "testsub"}.items():
        setval(key, value)
    text = generate()
    assert "hy2://test@example.com:443" in text and "subtag('testsub')" in text
    old = output.read_bytes()
    setval("config.main_group", "missing")
    generate(False)
    assert output.read_bytes() == old, "Invalid config replaced working output"
    print("PASS: generator defaults, IPv6 modes, SSID, custom rules, subscriptions, invalid-config preservation")

    # Exercise real adblock filter and replacement with deterministic local downloads.
    mock = base / "bin"
    mock.mkdir()
    target = base / "adblock.list"
    target.write_text("old.example\n")
    (mock / "uci").write_text('#!/bin/sh\ncase "$*" in *ad_block_file*) echo "$TEST_TARGET";; *ad_block_source*) echo "https://one.test https://two.test";; esac\n')
    (mock / "curl").write_text('#!/bin/sh\nwhile [ "$#" -gt 0 ]; do if [ "$1" = -o ]; then shift; out="$1"; fi; shift; done\nif [ "$TEST_FAIL" = 1 ]; then exit 22; fi\nif [ "$TEST_FAIL" = 2 ]; then echo "! empty" > "$out"; else printf "||ads.example^\\n0.0.0.0 tracker.example\\n" > "$out"; fi\n')
    for f in mock.iterdir():
        f.chmod(0o755)
    env = dict(os.environ, PATH=str(mock) + ":" + os.environ["PATH"], TEST_TARGET=str(target))
    for failure in ["1", "2"]:
        r = run(["sh", str(scripts / "update-adblock.sh")], env=dict(env, TEST_FAIL=failure))
        assert r.returncode != 0
        assert target.read_text() == "old.example\n"
    r = run(["sh", str(scripts / "update-adblock.sh")], env=dict(env, TEST_FAIL="0"))
    assert r.returncode == 0, r.stderr
    assert target.read_text() == "ads.example\ntracker.example\n", target.read_text()
    print("PASS: adblock multi-source deduplication and preservation on empty/download failures")

    # Exercise the actual rpcd parser with deterministic curl failures.
    rpc = (ROOT / "root/usr/share/rpcd/ucode/luci.honk").read_text()
    fakecurl = mock / "probe-curl"
    fakecurl.write_text('#!/bin/sh\nprintf "000\\t0.000\\t8.000"\nexit 28\n')
    fakecurl.chmod(0o755)
    rpc = rpc.replace("/usr/bin/curl", str(fakecurl)).replace('return { "luci.honk":', 'const api = { "luci.honk":')
    rpc += '\nprint(sprintf("%J", api["luci.honk"].connection_check.call({args:{site:"all"}})));\n'
    fixture = base / "rpc.uc"
    fixture.write_text(rpc)
    r = run(["ucode", str(fixture)])
    assert r.returncode == 0, r.stderr
    import json
    results = json.loads(r.stdout)["results"]
    assert len(results) == 6
    assert all(row["timed_out"] and row["exit_code"] == 28 and not row["result"] for row in results), results
    fakecurl.write_text('#!/bin/sh\nprintf "403\\t0.123\\t0.200"\nexit 0\n')
    r = run(["ucode", str(fixture)])
    results = json.loads(r.stdout)["results"]
    assert all(row["result"] and row["latency_ms"] == 123 for row in results)
    print("PASS: six concurrent site results, curl timeout classification, reachable HTTP 403")

    # Launch two clients and verify that both attach to a single worker.
    import time
    count = base / "worker-count"
    worker = base / "worker.sh"
    worker.write_text('#!/bin/sh\necho run >> "' + str(count) + '"\nsleep 1\n')
    worker.chmod(0o755)
    task = scripts / "task.sh"
    task.write_text(task.read_text().replace('/var/run/honk', str(base / 'run')).replace('/usr/share/honk/update-geo.sh', str(worker)))
    assert run(["sh", str(task), "geo"]).returncode == 0
    assert run(["sh", str(task), "geo"]).returncode == 0
    state = base / "run/task-geo/status"
    for _ in range(50):
        if state.read_text().strip() != 'running':
            break
        time.sleep(.1)
    assert state.read_text().strip() == 'succeeded'
    assert count.read_text().splitlines() == ['run']
    print("PASS: background task returns promptly and duplicate clients share one worker")
