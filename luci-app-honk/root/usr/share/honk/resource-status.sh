#!/bin/sh
exec ucode -e '
import { cursor } from "uci";
import { stat } from "fs";
const u = cursor();
const dir = u.get("honk", "infra", "geo_asset_dir") || "/usr/share/honk/geo";
let rows = [];
for (let name in ["geoip.dat", "geosite.dat"]) {
 const s = stat(dir + "/" + name);
 push(rows, {name, path: dir + "/" + name, size: s?.size, mtime: s?.mtime});
}
print(sprintf("%J", rows));
'
