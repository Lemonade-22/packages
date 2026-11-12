'use strict';
'require view';
'require form';
'require rpc';
'require uci';
'require ui';
'require network';
'require validation';

const TAG_PREFIX = 'lsgw_';
const MANAGED_MARK = 'lsgw_managed';

// Keep in sync with PKG_VERSION in the package Makefile. Shown on the page so
// it is always obvious which build the browser actually loaded (stale caches
// otherwise give very confusing bug reports).
const APP_VERSION = '1.1.3';

// --- Built-in English fallback ------------------------------------------
// Source language is Simplified Chinese. po/en/luci-app-static-gw.po is the
// single source of translation; Scripts/tests/gen-en-map.py generates this
// map from it. LuCI's per-app i18n domain is not guaranteed to be loaded for
// a standalone app, so translate locally when the browser asks for English.
const EN_MAP = {
	"/etc/config/network 中未找到 LAN 接口": "LAN interface not found in /etc/config/network",
	"1 小时": "1 hour",
	"12 小时": "12 hours",
	"24 小时": "24 hours",
	"30 分钟": "30 minutes",
	"5 分钟": "5 minutes",
	"7 天": "7 days",
	"DHCP 地址池：": "DHCP pool: ",
	"DNS 服务器": "DNS server",
	"IPv4 地址": "IPv4 address",
	"IPv4 已被其他绑定使用": "IPv4 already used by another binding",
	"LAN 接口未配置为静态 IPv4": "LAN interface is not configured as static IPv4",
	"LAN 未配置 IPv4 地址": "LAN has no IPv4 address configured",
	"LAN 没有活动的 DHCPv4 配置": "No active DHCPv4 configuration for LAN",
	"LAN：": "LAN: ",
	"MAC 地址": "MAC Address",
	"MAC 地址已被其他绑定使用": "MAC address already used by another binding",
	"MAC 必须是有效的单播地址": "MAC must be a valid unicast address",
	"不能使用网络地址或广播地址": "Cannot use network or broadcast address",
	"不能绑定路由器自身地址": "Cannot bind the router address itself",
	"与网关相同": "same as gateway",
	"主机名": "Hostname",
	"仅为该客户端下发 DNS 服务器（DHCP option 6）。": "Send a DNS server (DHCP option 6) to this client only.",
	"只读（请在官方 DHCP 页面管理）": "Read-only (manage in official DHCP page)",
	"可选。仅为该客户端覆盖 IPv4 网关（DHCP option 3）。留空则继承系统网关。": "Optional. Overrides the IPv4 gateway (DHCP option 3) for this client. Leave empty to inherit the system gateway.",
	"固定 IPv4": "Fixed IPv4",
	"在线设备": "Online devices",
	"地址不在 LAN 子网内": "Address is outside the LAN subnet",
	"地址当前已被另一台设备租用": "Address currently leased to another device",
	"将固定 IPv4 地址绑定到 MAC，并可为指定客户端下发自定义网关（DHCP option 3）和 DNS（option 6）。": "Bind fixed IPv4 addresses to MAC and optionally override gateway (option 3) and DNS (option 6) for individual clients.",
	"已暂存": "Staged",
	"已暂存 %s 的静态绑定。请点击“保存并应用”提交。": "Staged a static binding for %s. Click “Save & Apply” to commit.",
	"当前持有 DHCP 租约的设备。点击“设为静态”会暂存该地址的固定绑定，再点“保存并应用”生效。": "Devices that currently hold a DHCP lease. “Make static” stages a fixed binding for the leased address; commit it with “Save & Apply”.",
	"当前没有活动的 DHCP 租约。": "No active DHCP leases.",
	"必须填写主机名或 MAC 地址": "Hostname or MAC address is required",
	"必须填写固定 IPv4 地址": "Fixed IPv4 address is required",
	"提示：": "Notice: ",
	"操作": "Action",
	"无效的 IPv4 地址": "Invalid IPv4 address",
	"无效的 MAC 地址": "Invalid MAC address",
	"无法确定 LAN 子网": "Cannot determine LAN subnet",
	"未检测到，沿用接口配置": "not detected - inheriting interface configuration",
	"未能识别 LAN 的 DHCP 地址池配置，因此地址池范围未知。仍可正常创建和编辑绑定。": "No DHCP pool section for LAN could be identified, so the pool range is unknown. Bindings can still be created and edited.",
	"检测到多个 dnsmasq 实例": "Multiple dnsmasq instances detected",
	"永久": "Infinite",
	"状态": "Status",
	"由其他规则决定": "Decided by other rules",
	"租期": "Lease time",
	"租期格式无效（例如 12h、7d）": "Invalid lease time format (e.g. 12h, 7d)",
	"租约到期": "Lease expires",
	"系统默认（未确定）": "System default (undetermined)",
	"继承地址池": "Inherit from pool",
	"继承系统": "Inherit system",
	"继承系统（留空）": "Inherit system (leave empty)",
	"编辑已禁用：": "Editing disabled: ",
	"编辑静态绑定": "Edit static binding",
	"网关": "Gateway",
	"网关不能与固定 IP 相同": "Gateway cannot be the same as the fixed IP",
	"网关不能是网络地址或广播地址": "Gateway cannot be network or broadcast address",
	"网关必须在 LAN 子网内": "Gateway must be inside the LAN subnet",
	"自定义 DNS": "Custom DNS",
	"设为静态": "Make static",
	"该客户端使用的 DNS 服务器 IPv4 地址。留空则使用上方的网关地址。": "IPv4 address of the DNS server for this client. Leave empty to use the gateway address above.",
	"该租约没有可用的 MAC 地址。": "This lease has no usable MAC address.",
	"该设备已有静态绑定。": "This device already has a static binding.",
	"需要有效的 MAC 地址": "Expecting a valid MAC address",
	"静态": "Static",
	"静态地址绑定": "Static Address Binding",
	"静态绑定": "Static Bindings",
	"默认网关：": "Default gateway: ",
	"（未保存）": "(unsaved)",
	"（来自接口配置）": "(from interface config)",
};

const WANT_EN = (function() {
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
// ------------------------------------------------------------------------

const callHostHints = rpc.declare({
	object: 'luci-rpc',
	method: 'getHostHints',
	expect: { '': {} }
});

const callDHCPLeases = rpc.declare({
	object: 'luci-rpc',
	method: 'getDHCPLeases',
	expect: { '': {} }
});

const callNetworkDevices = rpc.declare({
	object: 'luci-rpc',
	method: 'getNetworkDevices',
	expect: { '': {} }
});

function isValidMAC(s) {
	if (!s) return true;
	const m = String(s).trim().toLowerCase().replace(/-/g, ':');
	if (!m.match(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/)) return _t('需要有效的 MAC 地址');
	return true;
}

function normalizeMAC(s) {
	if (!s) return null;
	const m = String(s).trim().toLowerCase().replace(/-/g, ':');
	return m.match(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/) ? m : null;
}

function isUnicastMAC(mac) {
	if (!mac) return false;
	const first = parseInt(mac.split(':')[0], 16);
	if (first & 1) return false;           // multicast
	if (mac === '00:00:00:00:00:00') return false;
	if (mac === 'ff:ff:ff:ff:ff:ff') return false;
	return true;
}

function calculateNetwork(addr, mask) {
	const a = validation.parseIPv4(String(addr));
	let m = validation.parseIPv4(String(mask));
	if (!a || !m) return null;
	return [
		[a[0] & (m[0] >>> 0 & 255), a[1] & (m[1] >>> 0 & 255),
		 a[2] & (m[2] >>> 0 & 255), a[3] & (m[3] >>> 0 & 255)].join('.'),
		m.join('.')
	];
}

function ipInSubnet(ip, net, mask) {
	const n = calculateNetwork(ip, mask);
	return n && n[0] === net;
}

function isNetworkOrBroadcast(ip, net, mask) {
	const n = calculateNetwork(ip, mask);
	if (!n) return true;
	const netInt = validation.parseIPv4(n[0]);
	const maskInt = validation.parseIPv4(n[1]);
	const ipInt = validation.parseIPv4(ip);
	if (!netInt || !maskInt || !ipInt) return true;
	const networkAddr = [
		netInt[0] & (maskInt[0] >>> 0 & 255),
		netInt[1] & (maskInt[1] >>> 0 & 255),
		netInt[2] & (maskInt[2] >>> 0 & 255),
		netInt[3] & (maskInt[3] >>> 0 & 255)
	].join('.');
	const bcast = [
		(netInt[0] | ((~maskInt[0]) >>> 0 & 255)),
		(netInt[1] | ((~maskInt[1]) >>> 0 & 255)),
		(netInt[2] | ((~maskInt[2]) >>> 0 & 255)),
		(netInt[3] | ((~maskInt[3]) >>> 0 & 255))
	].join('.');
	return ip === networkAddr || ip === bcast;
}

function tagNameFor(gw, dns) {
	let name = TAG_PREFIX + String(gw).replace(/\./g, '_');
	if (dns) {
		// `_dns` when the DNS server is the gateway itself (the common case),
		// otherwise encode the distinct server so the tag stays reusable.
		name += (dns === gw) ? '_dns' : '_dns_' + String(dns).replace(/\./g, '_');
	}
	return name;
}

function isManagedTag(t) {
	return t && String(t[MANAGED_MARK]) === '1';
}

function tagHasOption(t, code, value) {
	const opts = L.toArray(t && t.dhcp_option);
	const needle = code + ',' + value;
	return opts.some(o => String(o) === needle);
}

function getManagedGatewayFromHost(sid) {
	const tags = L.toArray(uci.get('dhcp', sid, 'tag'));
	let managedGw = null, dns = null, hasThirdParty = false;
	for (const tn of tags) {
		const t = uci.get('dhcp', tn);
		if (!t) continue;
		if (isManagedTag(t)) {
			const opts = L.toArray(t.dhcp_option).map(String);
			const o3 = opts.find(o => o.match(/^3,/));
			if (o3) {
				managedGw = o3.split(',')[1];
				const o6 = opts.find(o => o.match(/^6,/));
				dns = o6 ? o6.split(',')[1] : null;
			}
		} else {
			hasThirdParty = true;
		}
	}
	if (managedGw) return { mode: 'custom', gw: managedGw, dns: dns };
	if (hasThirdParty) return { mode: 'other' };
	return { mode: 'inherit' };
}

function findReusableTag(gw, dns) {
	const want = dns ? ['3,' + gw, '6,' + dns] : ['3,' + gw];
	for (const t of uci.sections('dhcp', 'tag')) {
		if (!isManagedTag(t)) continue;
		if (t.force || t.match_tag || t.networkid || t.instance) continue;
		const opts = L.toArray(t.dhcp_option).map(String);
		if (opts.length !== want.length) continue;
		if (want.every(w => opts.includes(w))) return t['.name'];
	}
	return null;
}

function ensureManagedTag(gw, dns) {
	let name = findReusableTag(gw, dns);
	if (name) return name;

	const base = tagNameFor(gw, dns);
	name = base;
	let suffix = 2;
	while (uci.get('dhcp', name)) {
		name = base + '_' + suffix;
		suffix++;
	}

	uci.add('dhcp', 'tag', name);
	uci.set('dhcp', name, MANAGED_MARK, '1');
	uci.set('dhcp', name, 'dhcp_option', dns ? ['3,' + gw, '6,' + dns] : ['3,' + gw]);
	return name;
}

function setHostGateway(sid, gw, dns) {
	const curTags = L.toArray(uci.get('dhcp', sid, 'tag'));
	const other = curTags.filter(tn => {
		const t = uci.get('dhcp', tn);
		return t && !isManagedTag(t);
	});

	if (gw) {
		other.push(ensureManagedTag(gw, dns));
	}

	if (other.length > 0) {
		uci.set('dhcp', sid, 'tag', other);
	} else {
		uci.unset('dhcp', sid, 'tag');
	}
}

function hostIsEditable(sid) {
	const h = uci.get('dhcp', sid);
	if (!h) return false;
	if (h.ignore === '1' || h.disabled === '1') return false;
	if (h.duid || h.ip6addr || h.ip6prefix || h.hostid) return false;
	if (h.match_tag || h.networkid || h.instance) return false;
	if (h.ip === 'ignore') return false;

	const macs = L.toArray(h.mac);
	if (macs.length > 1) return false;

	const tags = L.toArray(h.tag);
	for (const tn of tags) {
		const t = uci.get('dhcp', tn);
		if (t && !isManagedTag(t)) return false;
	}

	// Only allow simple single-MAC IPv4 records
	return true;
}

function maskToPrefix(mask) {
	const p = validation.parseIPv4(String(mask));
	if (!p) return null;
	let bits = 0;
	for (const octet of p) {
		let n = octet;
		while (n & 0x80) { bits++; n = (n << 1) & 0xff; }
	}
	return bits;
}

function getLanTopology() {
	const lanNet = uci.get('network', 'lan');
	if (!lanNet) {
		return { ready: false, reason: _t('/etc/config/network 中未找到 LAN 接口') };
	}

	// Static is OpenWrt's default protocol; many configs omit `option proto`.
	const proto = lanNet.proto || 'static';
	if (proto !== 'static') {
		return { ready: false, reason: _t('LAN 接口未配置为静态 IPv4') + ' (' + proto + ')' };
	}

	// `ipaddr` is either "192.168.1.1/24" or a bare address with a separate
	// `netmask` option - accept both forms.
	let lanIp = null, lanMask = null;
	const cidr = L.toArray(lanNet.ipaddr || lanNet.ipaddrs)[0];
	if (cidr) {
		const parts = String(cidr).split('/');
		lanIp = parts[0];
		if (parts.length > 1) {
			lanMask = network.prefixToMask(parseInt(parts[1], 10));
		}
	}
	if (!lanIp) {
		return { ready: false, reason: _t('LAN 未配置 IPv4 地址') };
	}
	lanMask = lanMask || lanNet.netmask || '255.255.255.0';

	const netInfo = calculateNetwork(lanIp, lanMask);
	if (!netInfo) {
		return { ready: false, reason: _t('无法确定 LAN 子网') + ' (' + lanIp + '/' + lanMask + ')' };
	}

	// Locate the dnsmasq DHCPv4 section that serves lan.
	const allDhcp = uci.sections('dhcp', 'dhcp');
	const isLan = s => (s.interface || s['.name']) === 'lan';
	let dhcpSection = allDhcp.find(s => isLan(s) && s.ignore !== '1');
	// A stock anonymous `config dhcp` without `interface` applies to lan.
	if (!dhcpSection) {
		dhcpSection = allDhcp.find(s => !s.interface && s.ignore !== '1' && s['.anonymous'] !== false);
	}
	// Still nothing? Accept an anonymous non-ignored section (single-DHCP LANs).
	if (!dhcpSection) {
		dhcpSection = allDhcp.find(s => !s.interface && s.ignore !== '1');
	}

	const dnsmasqSections = uci.sections('dhcp', 'dnsmasq').filter(s => s.ignore !== '1');
	if (dnsmasqSections.length > 1) {
		return {
			ready: false,
			reason: _t('检测到多个 dnsmasq 实例') +
				' (' + dnsmasqSections.map(s => s['.name'] || '[anonymous]').join(', ') + ')'
		};
	}

	// Diagnostics for the "why is editing disabled" case.
	const diag = [
		'lan=' + lanIp + '/' + (maskToPrefix(lanMask) ?? '?') + ' proto=' + proto,
		'dhcp sections=' + (allDhcp.length ? allDhcp.map(s => (s['.name'] || '?') + ':' + (s.interface || '-')).join(', ') : 'none'),
		'dnsmasq instances=' + dnsmasqSections.length
	].join('; ');

	return {
		ready: true,
		// When the pool section cannot be identified we still allow editing:
		// this app only writes global `config host` / `config tag` sections,
		// so it does not depend on a specific `config dhcp` block.
		poolKnown: !!dhcpSection,
		diag: diag,
		lanIp,
		lanMask,
		lanPrefix: maskToPrefix(lanMask),
		lanNet: netInfo[0],
		dhcpSection: dhcpSection ? dhcpSection['.name'] : null,
		start: dhcpSection ? dhcpSection.start : null,
		limit: dhcpSection ? dhcpSection.limit : null,
		leasetime: dhcpSection ? dhcpSection.leasetime : null
	};
}

function getEffectiveDefaultGateway(topology) {
	if (!topology.ready) return _t('系统默认（未确定）');

	const dhcpSection = uci.get('dhcp', topology.dhcpSection);
	if (dhcpSection) {
		const opts = L.toArray(dhcpSection.dhcp_option);
		for (const o of opts) {
			if (String(o).match(/^3,/)) return String(o).split(',')[1];
		}
	}
	// Fallback to LAN address (dnsmasq default)
	return topology.lanIp;
}

function getDynamicPool(topology) {
	if (!topology.ready || !topology.start || !topology.limit) return null;
	const start = parseInt(topology.start);
	const limit = parseInt(topology.limit);
	if (isNaN(start) || isNaN(limit)) return null;
	const first = calculateNetwork(topology.lanIp, topology.lanMask);
	if (!first) return null;
	const base = validation.parseIPv4(first[0]);
	if (!base) return null;
	const firstIp = ((base[0] << 24) | (base[1] << 16) | (base[2] << 8) | base[3]) + start;
	const lastIp = firstIp + limit - 1;
	const toIp = n => [(n>>>24)&255, (n>>>16)&255, (n>>>8)&255, n&255].join('.');
	return toIp(firstIp) + ' – ' + toIp(lastIp);
}

return view.extend({
	load() {
		return Promise.all([
			uci.load('dhcp'),
			uci.load('network'),
			callHostHints(),
			callDHCPLeases(),
			callNetworkDevices(),
			network.getNetworks()
		]);
	},

	// load() resolves in declaration order:
	// [ uci dhcp, uci network, host hints, dhcp leases, network devices, networks ]
	render([, , hosts, leases, devices, nets]) {
		const top = getLanTopology();
		const defaultGw = getEffectiveDefaultGateway(top);
		const pool = getDynamicPool(top);

		let m, s, o;

		m = new form.Map('dhcp', _t('静态地址绑定'),
			_t('将固定 IPv4 地址绑定到 MAC，并可为指定客户端下发自定义网关（DHCP option 3）和 DNS（option 6）。'));

		if (!top.ready) {
			const note = m.section(form.TypedSection, '_info');
			note.anonymous = true;
			note.cfgsections = () => ['_info'];
			o = note.option(form.DummyValue, '_warn');
			o.rawhtml = true;
			o.default = E('div', { class: 'alert-message warning' }, [
				E('strong', _t('编辑已禁用：')), top.reason
			]);
			return m.render();
		}

		const header = m.section(form.TypedSection, '_header');
		header.anonymous = true;
		header.cfgsections = () => ['_header'];
		o = header.option(form.DummyValue, '_info');
		o.rawhtml = true;

		const headerNodes = [
			E('div', { class: 'cbi-section-descr' }, [
				E('strong', _t('LAN：')), top.lanIp + '/' + (top.lanPrefix != null ? top.lanPrefix : '?'),
				E('br'),
				E('strong', _t('DHCP 地址池：')), pool || _t('未检测到，沿用接口配置'),
				E('br'),
				E('strong', _t('默认网关：')), defaultGw
			])
		];

		// Editing stays possible without a `config dhcp` block: this app only
		// writes global host/tag sections. Say so instead of silently limiting.
		if (!top.poolKnown) {
			headerNodes.push(E('div', { class: 'alert-message notice' }, [
				E('strong', _t('提示：')),
				_t('未能识别 LAN 的 DHCP 地址池配置，因此地址池范围未知。仍可正常创建和编辑绑定。'),
				E('br'),
				E('small', { class: 'muted' }, top.diag)
			]));
		}

		o.default = E('div', {}, headerNodes);

		s = m.section(form.GridSection, 'host', _t('静态绑定'));
		s.anonymous = true;
		s.addremove = true;
		s.sortable = true;
		s.nodescriptions = true;
		// Label the action column. Without this the header cell above the
		// edit/delete buttons renders empty, so the column reads as a broken
		// white box instead of "these are the actions".
		s.actionstitle = _t('操作');
		s.modaltitle = _t('编辑静态绑定');

		// Hostname
		o = s.option(form.Value, 'name', _t('主机名'));
		o.validate = function(section_id, value) {
			if (!value && !this.section.formvalue(section_id, 'mac'))
				return _t('必须填写主机名或 MAC 地址');
			return true;
		};
		o.write = function(section, value) {
			uci.set('dhcp', section, 'name', value);
			uci.set('dhcp', section, 'dns', '1');
		};
		o.remove = function(section) {
			uci.unset('dhcp', section, 'name');
			uci.unset('dhcp', section, 'dns');
		};

		// MAC (single)
		o = s.option(form.Value, 'mac', _t('MAC 地址'));
		o.datatype = 'macaddr';
		o.validate = function(section_id, value) {
			const norm = normalizeMAC(value);
			if (!norm) return _t('无效的 MAC 地址');
			if (!isUnicastMAC(norm)) return _t('MAC 必须是有效的单播地址');
			// conflict with other hosts
			for (const h of uci.sections('dhcp', 'host')) {
				if (h['.name'] === section_id) continue;
				const otherMacs = L.toArray(h.mac).map(normalizeMAC);
				if (otherMacs.includes(norm))
					return _t('MAC 地址已被其他绑定使用');
			}
			return true;
		};
		o.cfgvalue = function(section) {
			const v = uci.get('dhcp', section, 'mac');
			return normalizeMAC(L.toArray(v)[0]) || '';
		};
		o.write = function(section, value) {
			const norm = normalizeMAC(value);
			uci.set('dhcp', section, 'mac', norm);
		};

		// Fixed IP
		o = s.option(form.Value, 'ip', _t('固定 IPv4'));
		o.datatype = 'ip4addr';
		o.validate = function(section_id, value) {
			if (!value) return _t('必须填写固定 IPv4 地址');
			if (!ipInSubnet(value, top.lanNet, top.lanMask))
				return _t('地址不在 LAN 子网内');
			if (isNetworkOrBroadcast(value, top.lanNet, top.lanMask))
				return _t('不能使用网络地址或广播地址');
			if (value === top.lanIp)
				return _t('不能绑定路由器自身地址');

			// conflict with other bindings
			for (const h of uci.sections('dhcp', 'host')) {
				if (h['.name'] === section_id) continue;
				if (h.ip === value)
					return _t('IPv4 已被其他绑定使用');
			}

			// check active leases (best effort)
			const leaseList = leases && leases.dhcp_leases ? leases.dhcp_leases : [];
			for (const l of leaseList) {
				if (l.ipaddr === value) {
					const thisMac = normalizeMAC(this.section.formvalue(section_id, 'mac'));
					if (thisMac && normalizeMAC(l.macaddr) !== thisMac)
						return _t('地址当前已被另一台设备租用');
				}
			}
			return true;
		};

		// Gateway: per-host override of DHCP option 3.
		// No `modalonly`, so it is shown both as a table column and as the
		// editable field inside the edit dialog. Empty means "inherit".
		o = s.option(form.Value, '__gw', _t('网关'));
		o.placeholder = _t('继承系统（留空）');
		o.description = _t('可选。仅为该客户端覆盖 IPv4 网关（DHCP option 3）。留空则继承系统网关。');
		o.textvalue = function(section_id) {
			if (!hostIsEditable(section_id)) return _t('由其他规则决定');
			const info = getManagedGatewayFromHost(section_id);
			if (info.mode === 'custom') return info.gw + (info.dns ? ' + DNS' : '');
			if (info.mode === 'other') return _t('由其他规则决定');
			return _t('继承系统');
		};
		o.cfgvalue = function(section_id) {
			const info = getManagedGatewayFromHost(section_id);
			return (info.mode === 'custom') ? info.gw : '';
		};
		o.write = function(section_id, value) {
			if (!hostIsEditable(section_id)) return;
			const gw = (value && String(value).trim()) ? String(value).trim() : null;
			let dns = null;
			if (gw && this.section.formvalue(section_id, '__gw_dns') === '1') {
				const typed = String(this.section.formvalue(section_id, '__dns') || '').trim();
				dns = typed || gw; // empty means "use the gateway address"
			}
			setHostGateway(section_id, gw, dns);
		};
		o.remove = function(section_id) {
			if (!hostIsEditable(section_id)) return;
			setHostGateway(section_id, null, null);
		};
		o.validate = function(section_id, value) {
			if (!value) return true; // inherit
			if (!ipInSubnet(value, top.lanNet, top.lanMask))
				return _t('网关必须在 LAN 子网内');
			if (isNetworkOrBroadcast(value, top.lanNet, top.lanMask))
				return _t('网关不能是网络地址或广播地址');
			const fixedIp = this.section.formvalue(section_id, 'ip');
			if (value === fixedIp)
				return _t('网关不能与固定 IP 相同');
			return true;
		};

		// Custom DNS: its own opt-in block. When enabled a dedicated DNS
		// address can be entered; leaving it empty reuses the gateway address
		// (the classic "gateway also acts as DNS" behaviour).
		o = s.option(form.Flag, '__gw_dns', _t('自定义 DNS'));
		o.modalonly = true;
		o.default = '0';
		o.depends('__gw', '', true); // only meaningful together with a gateway
		o.description = _t('仅为该客户端下发 DNS 服务器（DHCP option 6）。');
		o.write = function() {}; // handled in __gw.write
		o.cfgvalue = function(section_id) {
			const info = getManagedGatewayFromHost(section_id);
			return (info.mode === 'custom' && info.dns) ? '1' : '0';
		};

		// Dedicated DNS server address, shown as a separate block once the
		// "Custom DNS" switch is on.
		o = s.option(form.Value, '__dns', _t('DNS 服务器'));
		o.modalonly = true;
		o.depends('__gw_dns', '1');
		o.placeholder = _t('与网关相同');
		o.description = _t('该客户端使用的 DNS 服务器 IPv4 地址。留空则使用上方的网关地址。');
		o.cfgvalue = function(section_id) {
			const info = getManagedGatewayFromHost(section_id);
			if (info.mode !== 'custom' || !info.dns) return '';
			return (info.dns === info.gw) ? '' : info.dns;
		};
		o.write = function() {}; // handled in __gw.write
		o.validate = function(section_id, value) {
			if (!value) return true;
			const v = String(value).trim();
			if (!validation.parseIPv4(v)) return _t('无效的 IPv4 地址');
			if (ipInSubnet(v, top.lanNet, top.lanMask) &&
			    isNetworkOrBroadcast(v, top.lanNet, top.lanMask))
				return _t('不能使用网络地址或广播地址');
			return true;
		};

		// Leasetime
		o = s.option(form.Value, 'leasetime', _t('租期'));
		o.modalonly = true;
		o.rmempty = true;
		o.placeholder = _t('继承地址池');
		o.value('5m', _t('5 分钟'));
		o.value('30m', _t('30 分钟'));
		o.value('1h', _t('1 小时'));
		o.value('12h', _t('12 小时'));
		o.value('24h', _t('24 小时'));
		o.value('7d', _t('7 天'));
		o.value('infinite', _t('永久'));
		o.validate = function(section_id, value) {
			if (!value) return true;
			if (value === 'infinite') return true;
			if (!value.match(/^\d+[smhd]$/)) return _t('租期格式无效（例如 12h、7d）');
			return true;
		};

		// Records that cannot be expressed losslessly stay read-only: their
		// table cells show a hint and every write is suppressed centrally
		// below, so nothing of the original record can be lost.
		// Modal only: as a table column it would be a permanently blank cell
		// for every editable binding (the hint is only ever set for records
		// that are read-only), so it lives in the edit dialog instead.
		o = s.option(form.DummyValue, '__state', _t('状态'));
		o.modalonly = true;
		o.textvalue = function(section_id) {
			if (hostIsEditable(section_id)) return '';
			return E('em', { class: 'muted' }, _t('只读（请在官方 DHCP 页面管理）'));
		};

		// Central guard: a record that is not losslessly editable must never be
		// written or removed, no matter which field the dialog submits.
		for (const child of s.children) {
			if (typeof child.write === 'function') {
				const origWrite = child.write.bind(child);
				child.write = function(section_id, value) {
					if (!hostIsEditable(section_id)) return;
					return origWrite(section_id, value);
				};
			}
			if (typeof child.remove === 'function') {
				const origRemove = child.remove.bind(child);
				child.remove = function(section_id) {
					if (!hostIsEditable(section_id)) return;
					return origRemove(section_id);
				};
			}
		}

		// ---------------------------------------------------------------
		// Online devices: read the current DHCPv4 leases and offer a one-click
		// "make static" action, like the vendor UI's access-device list.
		// ---------------------------------------------------------------
		const leaseList = (leases && Array.isArray(leases.dhcp_leases)) ? leases.dhcp_leases : [];

		const alreadyStatic = mac => {
			if (!mac) return false;
			return uci.sections('dhcp', 'host').some(h =>
				L.toArray(h.mac).map(normalizeMAC).includes(mac));
		};

		// Section ids staged by "Make static" and not committed yet. Staging
		// re-renders the table, which rebuilds every row, so the pending
		// markers are re-applied from this set after each click.
		const stagedSids = new Set();

		const markStagedRows = () => {
			for (const sid of stagedSids) {
				const row = document.getElementById('cbi-dhcp-' + sid);
				if (!row) continue;
				const cell = row.querySelector('td');
				if (!cell || cell.querySelector('.lsgw-staged')) continue;
				cell.appendChild(E('em', { 'class': 'muted lsgw-staged' }, [ ' ', _t('（未保存）') ]));
			}
		};

		// ui.createHandlerFn() does NOT pass the event first: LuCI binds the
		// extra arguments before it (its own implementation reaches the event
		// via `arguments[args.length].currentTarget`), and older LuCI releases
		// appended them after the event. Reading the lease positionally is
		// therefore build-dependent - pick it out by shape so both orders work.
		// The lease object never has a `target` field, the event always does.
		const makeStatic = function() {
			const args = Array.prototype.slice.call(arguments);
			const lease = args.find(a => a && typeof a === 'object' && !a.target);
			const ev = args.find(a => a && typeof a === 'object' && a.target);
			const btn = ev ? ev.target : null;
			const mac = lease ? normalizeMAC(lease.macaddr) : null;
			if (!mac) {
				ui.addNotification(null, E('p', _t('该租约没有可用的 MAC 地址。')), 'warning');
				return;
			}
			if (alreadyStatic(mac)) {
				ui.addNotification(null, E('p', _t('该设备已有静态绑定。')), 'info');
				return;
			}

			const sid = uci.add('dhcp', 'host');
			uci.set('dhcp', sid, 'mac', mac);
			if (lease.hostname) uci.set('dhcp', sid, 'name', lease.hostname);
			uci.set('dhcp', sid, 'dns', '1');
			if (lease.ipaddr) uci.set('dhcp', sid, 'ip', lease.ipaddr);
			uci.set('dhcp', sid, 'leasetime', 'infinite');

			stagedSids.add(sid);

			if (btn) {
				btn.disabled = true;
				btn.classList.remove('cbi-button-add');
				btn.classList.add('cbi-button-neutral');
				btn.textContent = _t('已暂存');
			}
			ui.addNotification(null, E('p',
				_t('已暂存 %s 的静态绑定。请点击“保存并应用”提交。').format(
					lease.ipaddr || mac)), 'info');

			// Redraw the form from the (still uncommitted) UCI state so the
			// staged binding is visible in the table immediately. reset() only
			// re-renders - it does not reload the configuration - so the staged
			// section survives, and nothing is written to the device here.
			return Promise.resolve(m.reset()).then(() => { markStagedRows(); });
		};

		const leaseRows = [];
		if (leaseList.length === 0) {
			leaseRows.push(E('tr', { class: 'tr' }, [
				E('td', { class: 'td', colspan: 5 }, E('em', _t('当前没有活动的 DHCP 租约。')))
			]));
		} else {
			for (const lease of leaseList) {
				const mac = normalizeMAC(lease.macaddr);
				const isStatic = alreadyStatic(mac);
				leaseRows.push(E('tr', { class: 'tr' }, [
					E('td', { class: 'td' }, lease.hostname || '-'),
					E('td', { class: 'td' }, mac || '-'),
					E('td', { class: 'td' }, lease.ipaddr || '-'),
					E('td', { class: 'td' }, lease.expires === false ? _t('永久') : (lease.expires || '-')),
					E('td', { class: 'td' }, isStatic
						? E('span', { class: 'label label-success' }, _t('静态'))
						: E('button', {
							'class': 'cbi-button cbi-button-add',
							'click': ui.createHandlerFn(this, makeStatic, lease)
						}, _t('设为静态')))
				]));
			}
		}

		const dev = m.section(form.TypedSection, '_devices');
		dev.anonymous = true;
		dev.cfgsections = () => ['_devices'];
		o = dev.option(form.DummyValue, '_leasetable');
		o.rawhtml = true;
		o.default = E('div', {}, [
			E('h3', {}, _t('在线设备')),
			E('div', { class: 'cbi-section-descr' },
				_t('当前持有 DHCP 租约的设备。点击“设为静态”会暂存该地址的固定绑定，再点“保存并应用”生效。')),
			E('div', { class: 'table-wrapper' }, [
				E('table', { class: 'table' }, [
					E('tr', { class: 'tr table-titles' }, [
						E('th', { class: 'th' }, _t('主机名')),
						E('th', { class: 'th' }, _t('MAC 地址')),
						E('th', { class: 'th' }, _t('IPv4 地址')),
						E('th', { class: 'th' }, _t('租约到期')),
						E('th', { class: 'th' }, _t('操作'))
					]),
					...leaseRows
				])
			])
		]);

		return m.render();
	}
});

