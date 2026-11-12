function parseIPv4(s){const p=String(s).split('.');if(p.length!==4)return null;const r=p.map(Number);return r.some(isNaN)?null:r;}
function maskToPrefix(mask) {
	const p = parseIPv4(String(mask));
	if (!p) return null;
	let bits = 0;
	for (const octet of p) {
		let n = octet;
		while (n & 0x80) { bits++; n = (n << 1) & 0xff; }
	}
	return bits;
}
for (const m of ['255.255.255.0','255.255.0.0','255.255.255.252','255.0.0.0','0.0.0.0'])
  console.log(m, '->', maskToPrefix(m));
