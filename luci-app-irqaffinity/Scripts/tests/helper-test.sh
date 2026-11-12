#!/bin/bash
cd "$(dirname "$0")/../.."
F=root/usr/libexec/irqaffinity.sh
US=$(printf '\037')
getfn(){ sed -n "/^$1()/,/^}/p" "$F"; }
eval "$(getfn strlen)"; eval "$(getfn valid_mask)"; eval "$(getfn valid_iface)"
eval "$(getfn json_escape)"; eval "$(getfn strip_vendor)"; eval "$(getfn classify_from_model)"
eval "$(getfn cpu_json)"
fail=0
chk(){ if [ "$2" = "$3" ]; then printf 'ok   %-36s %s\n' "$1" "$2"; else printf 'FAIL %-36s got=[%s] want=[%s]\n' "$1" "$2" "$3"; fail=$((fail+1)); fi; }

chk RK3588_A76 "$(classify_from_model arm,cortex-a76)"  performance
chk RK3588_A55 "$(classify_from_model arm,cortex-a55)"  efficiency
chk RK3399_A72 "$(classify_from_model arm,cortex-a72)"  performance
chk RK3399_A53 "$(classify_from_model arm,cortex-a53)"  efficiency
chk A710       "$(classify_from_model arm,cortex-a710)" performance
chk A510       "$(classify_from_model arm,cortex-a510)" efficiency
chk n2         "$(classify_from_model arm,neoverse-n2)" performance
chk brahma     "$(classify_from_model brcm,brahma-b15)" unknown
chk x4         "$(classify_from_model arm,cortex-x4)"   performance
for m in 2 03 ff 0123456789abcdef; do valid_mask "$m" && r=ok||r=bad; chk "mask_ok[$m]" "$r" ok; done
for m in "" z "ff,3" "0123456789abcdef0" "2 3" '2;reboot'; do valid_mask "$m" && r=ok||r=bad; chk "mask_no[$m]" "$r" bad; done
valid_iface "eth0;reboot" && r=ok||r=bad; chk "iface_inject" "$r" bad
chk vendor "$(strip_vendor arm,cortex-a76)" cortex-a76

esc=$(json_escape 'a"b')
exp='a\"b'
chk json_escape "$esc" "$exp"

# positional args, so nothing gets swallowed into a variable name
line(){ printf '%s%s%s%s%s%s%s%s%s%s%s%s%s\n' "$1" "$US" "$2" "$US" "$3" "$US" "$4" "$US" "$5" "$US" "$6" "$US" "$7"; }
CPU_TABLE="$(line 0 performance '' 2400000 0-1 arm,cortex-a76 devicetree)
$(line 4 efficiency '' 1800000 4 arm,cortex-a55 devicetree)
$(line 1 pendingcap 758 '' 1 '' capacity)
$(line 2 pendingcap 1024 '' 2 '' capacity)"
out=$(cpu_json)
echo "raw: $out"
node -e '
const j=JSON.parse(process.argv[1]);
const want=[["0","performance","2400000","0-1","cortex-a76"],
            ["4","efficiency","1800000","4","cortex-a55"],
            ["1","efficiency","","1",""],
            ["2","performance","","2",""]];
let bad=[];
if(j.length!==4) bad.push("len="+j.length);
j.forEach((e,i)=>{ const w=want[i];
  if(String(e.id)!==w[0]) bad.push("id"+i+"="+e.id);
  if(e.class!==w[1]) bad.push("class"+i+"="+e.class);
  if(e.freq!==w[2]) bad.push("freq"+i+"=["+e.freq+"]");
  if(e.sibling!==w[3]) bad.push("sib"+i+"=["+e.sibling+"]");
  if(e.model!==w[4]) bad.push("model"+i+"=["+e.model+"]");
});
if(bad.length){ console.log("FAIL cpu_json: "+bad.join(" ")); process.exit(1); }
console.log("ok   cpu_json: empty cols keep alignment, capmax split correct");
' "$out" || fail=$((fail+1))
echo "---"
if [ "$fail" -ne 0 ]; then echo "$fail FAILED"; exit 1; fi
echo "ALL PASS"
