'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require fs';

/*
 * luci-app-honk
 *
 * 这一页只做两件事：把 UCI 写好，让 /etc/init.d/honk 的 reload 去生成 .dae。
 * 不在这里拼 dae 文本，也不在这里重启进程。
 *
 * honk 的硬约束：路由目标只能是 direct / block / 组。所以「主节点」这个下拉
 * 列的是组名，不是节点名——哪怕那个组里只有一个节点。
 */
return view.extend({
	load: function() {
		return Promise.all([ uci.load('honk'), uci.load('network') ]).then(function() {
			var groups = uci.sections('honk', 'group').map(function(g) {
				return (g.name || g['.name'] || '').trim();
			}).filter(function(n) { return n.length > 0; });

			var nodes = uci.sections('honk', 'node').filter(function(n) {
				return n.enabled === '1' && (n.uri || '').length > 0;
			}).map(function(n) {
				return { id: n['.name'], name: n.name || n['.name'], uri: n.uri };
			});

			var ifaces = uci.sections('network', 'interface')
				.map(function(i) { return i['.name']; })
				.filter(function(n) { return /^wifi\d+$/.test(n); })
				.sort();

			return { groups: groups, nodes: nodes, ifaces: ifaces };
		});
	},

	render: function(data) {
		var m = new form.Map('honk', _('Honk'),
			_('eBPF transparent proxy engine. This page writes UCI only; ' +
			  'the dae config is generated into /etc/honk/config.dae on reload.'));

		/* 公共段：开关、主节点、路由模式 */
		var s = m.section(form.NamedSection, 'config', 'honk');
		s.anonymous = true;

		/* tab 顺序就是这里的声明顺序 */
		s.tab('routing', _('Routing Settings'));
		s.tab('dns', _('DNS'));
		s.tab('nodes', _('Nodes & Groups'));
		s.tab('ssid', _('Per-SSID Routing'));
		s.tab('control', _('Access Control'));
		s.tab('diversion', _('Diversion'));
		s.tab('custom', _('Custom Rules'));
		s.tab('status', _('Status'));

		var o = s.taboption('routing', form.Flag, 'enabled', _('Enable honk'));
		o.rmempty = false;

		o = s.taboption('routing', form.ListValue, 'main_group', _('Main node'));
		o.value('nil', _('Disable'));
		(data.groups || []).forEach(function(g) {
			o.value(g, g);
		});
		o.rmempty = false;
		o.description = _('honk can only route to direct / block / a group, never to a bare node name.');

		o = s.taboption('routing', form.ListValue, 'routing_mode', _('Routing mode'));
		o.value('bypass_mainland_china', _('Bypass mainland China'));
		o.value('global', _('Global'));
		o.rmempty = false;

		o = s.taboption('routing', form.ListValue, 'routing_port', _('Routing ports'));
		o.value('', _('All ports'));
		o.value('common', _('Common ports only (bypass P2P traffic)'));

		o = s.taboption('routing', form.ListValue, 'quic_mode', _('QUIC handling'));
		o.value('block', _('Block'));
		o.value('direct', _('Direct'));
		o.value('off', _('Leave alone'));
		o.default = 'block';
		o.rmempty = false;
		o.description = E('span', {}, [
			E('span', {
				title: _('Blocking drops UDP 443, so browsers and apps fall back to TCP/TLS. ' +
				         'QUIC going direct means that traffic leaves from your local ISP ' +
				         'instead of the node, which is a second uncontrolled egress.')
			}, '\u24d8 '),
			_('Recommended: block. Switch to direct only if an app stalls badly without QUIC.')
		]);

		o = s.taboption('routing', form.ListValue, 'ipv6_mode', _('IPV6'));
		o.value('proxy', _('Proxy IPv6'));
		o.value('direct', _('IPv6 direct'));
		o.value('block', _('IPv6 block (China exempt)'));
		o.value('block_global', _('Global IPv6 block'));
		o.default = 'block';
		o.rmempty = false;
		o.description = E('span', {}, [
			E('span', {
				title: _('honk has no IPv6 toggle: eBPF captures v4 and v6 alike, and the chosen ' +
					'rule decides where v6 goes.') + '\n\n' +
					_('Proxy  — no rule; v6 follows fallback and enters the node.') + '\n' +
					_('Direct — ipversion(6) -> direct, emitted first; v6 leaves from your ISP.') + '\n' +
					_('Block (China exempt) — ipversion(6) -> block after geosite-cn/geoip-cn, ' +
					  'so Chinese v6 stays direct and the rest is dropped.') + '\n' +
					_('Global block — ipversion(6) -> block emitted first; no v6 leaves at all.') + '\n\n' +
					_('Blocking only stops TCP/UDP from leaving over v6: WAN prefix delegation, ' +
					  'RA/SLAAC and LAN-internal v6 keep working.')
			}, '\u24d8 '),
			_('Four ways to treat IPv6 traffic; hover the icon for the exact rule each one emits.')
		])

		/* infra 段：接口与运行时 */
		var sv = s.taboption('routing', form.SectionValue, '_infra', form.NamedSection, 'infra', 'honk');
		sv.depends('enabled', '1');
		var ss = sv.subsection;

		o = ss.option(form.Value, 'lan_interface', _('LAN interface'),
			_('Interfaces carrying LAN-forwarded traffic. Leave empty to only proxy traffic from the router itself.'));
		o.placeholder = 'br-lan';
		o.rmempty = true;

		o = ss.option(form.Value, 'wan_interface', _('WAN interface'),
			_('Interface carrying the router\u2019s own traffic. "auto" follows the IPv4 default route.'));
		o.placeholder = 'auto';
		o.rmempty = true;

		o = ss.option(form.ListValue, 'log_level', _('Log level'));
		['error', 'warn', 'info', 'debug'].forEach(function(v) {
			o.value(v, v);
		});
		o.default = 'info';

		o = ss.option(form.Value, 'data_dir', _('Runtime data directory'));
		o.placeholder = '/var/lib/honk';
		o.rmempty = true;

		/* ================= 节点与组 ================= */

		var nv = s.taboption('nodes', form.SectionValue, '_nodes', form.GridSection, 'node', null);
		var nodesSec = nv.subsection;
		nodesSec.addremove = true;
		nodesSec.sortable = true;
		nodesSec.anonymous = true;
		nodesSec.sectiontitle = function(section_id) {
			return uci.get('honk', section_id, 'name') || section_id;
		};

		o = nodesSec.option(form.Flag, 'enabled', _('Enable'));
		o.default = '1';
		o.rmempty = false;

		o = nodesSec.option(form.Value, 'name', _('Name'));
		o.placeholder = 'hk01';
		o.rmempty = false;
		o.description = _('Used by group members and by the API. Keep it short and stable.');

		o = nodesSec.option(form.Value, 'uri', _('Share link'));
		o.placeholder = 'vless://uuid@host:443?security=tls&sni=host#name';
		o.rmempty = false;
		o.description = _('One link per node. honk understands vless / vmess / trojan / hysteria2 / tuic / ' +
			'shadowsocks / anytls / juicity / socks5.');

		var gv = s.taboption('nodes', form.SectionValue, '_groups', form.GridSection, 'group', null);
		var groupsSec = gv.subsection;
		groupsSec.addremove = true;
		groupsSec.sortable = true;
		groupsSec.anonymous = true;
		groupsSec.sectiontitle = function(section_id) {
			return uci.get('honk', section_id, 'name') || section_id;
		};

		o = groupsSec.option(form.Value, 'name', _('Group name'));
		o.placeholder = 'proxy';
		o.rmempty = false;
		o.description = _('Routing targets can only be direct / block / a group. ' +
			'A group holding a single node is still a group.');

		o = groupsSec.option(form.ListValue, 'policy', _('Policy'));
		o.value('selector', _('Selector (manual)'));
		o.value('urltest', _('URLTest (lowest latency)'));
		o.value('score', _('Score (measured reliability)'));
		o.value('loadbalance', _('Load balance'));
		o.value('fallback', _('Fallback (first alive)'));
		o.default = 'urltest';
		o.rmempty = false;

		o = groupsSec.option(form.DynamicList, 'members', _('Members'),
			_('Nodes and/or other groups. Every member stays warm, so keep groups small.'));
		(data.nodes || []).forEach(function(n) {
			o.value(n.name, n.name);
		});
		(data.groups || []).forEach(function(g) {
			o.value(g, _('[group] ') + g);
		});
		o.rmempty = true;

		o = groupsSec.option(form.Value, 'check_url', _('Health check URL'));
		o.placeholder = 'https://www.gstatic.com/generate_204';
		o.rmempty = true;

		o = groupsSec.option(form.Value, 'tolerance', _('Tolerance (ms)'));
		o.datatype = 'uinteger';
		o.placeholder = '50';
		o.rmempty = true;

		o = groupsSec.option(form.ListValue, 'final', _('Fallback'));
		o.value('direct', _('Direct'));
		o.value('block', _('Block'));
		(data.groups || []).forEach(function(g) {
			o.value(g, _('[group] ') + g);
		});
		o.default = 'direct';
		o.rmempty = false;

		/* ================= 多SSID分流 ================= */

		o = s.taboption('ssid', form.DummyValue, '_ssid_hint', null);
		o.rawhtml = true;
		o.cfgvalue = function() {
			return E('div', { 'class': 'cbi-value-description' }, [
				E('p', {}, _('One row per SSID subnet. Each row emits a sip(<source>) rule for egress ' +
					'and, when a DNS upstream is given, a matching sip() rule inside dns.routing.request. ' +
					'These rules are placed above the China-direct rules, so a subnet always wins.')),
				E('p', {}, _('Source can be filled from the staged wifiNN interfaces: ') +
					E('em', {}, (data.ifaces || []).join(', ') || _('(none found)')))
			]);
		};
		o.depends('enabled', '1');

		var sv2 = s.taboption('ssid', form.SectionValue, '_ssid_routes', form.GridSection, 'ssid_route', null);
		sv2.depends('enabled', '1');
		var ssr = sv2.subsection;
		ssr.addremove = true;
		ssr.sortable = true;
		ssr.anonymous = true;
		ssr.sectiontitle = function(section_id) {
			return uci.get('honk', section_id, 'name') || section_id;
		};

		o = ssr.option(form.Flag, 'enabled', _('Enable'));
		o.default = '1';
		o.rmempty = false;

		o = ssr.option(form.Value, 'name', _('Name'));
		o.placeholder = 'jy01';
		o.rmempty = false;

		o = ssr.option(form.Value, 'source', _('Source subnet'),
			_('CIDR of the SSID subnet, e.g. 188.181.1.0/24.'));
		o.placeholder = '188.181.1.0/24';
		o.datatype = 'cidr4';
		o.rmempty = false;

		o = ssr.option(form.ListValue, 'target', _('Egress group'));
		(data.groups || []).forEach(function(g) {
			o.value(g, g);
		});
		o.rmempty = false;

		o = ssr.option(form.Value, 'interface', _('Interface'),
			_('Optional wifiNN interface. When set it is appended to lan_interface ' +
			  'so honk can actually see this subnet.'));
		(data.ifaces || []).forEach(function(i) {
			o.value(i, i);
		});
		o.rmempty = true;

		o = ssr.option(form.ListValue, 'dns', _('DNS upstream'),
			_('Optional. Name of an upstream above; queries from this subnet are pinned to it.'));
		uci.sections('honk', 'dns_upstream').forEach(function(u) {
			if (u.name)
				o.value(u.name, u.name);
		});
		o.rmempty = true;

		/* ================= DNS ================= */

		var dnsv = s.taboption('dns', form.SectionValue, '_dns', form.NamedSection, 'infra', 'honk');
		dnsv.depends('enabled', '1');
		var ds = dnsv.subsection;

		ds.tab('dns_basic', _('Basic'));
		ds.tab('dns_advanced', _('Advanced'));

		/* ---- 基础 ---- */
		o = ds.taboption('dns_basic', form.Value, 'bind', _('Standalone listener'),
			_('Optional. honk already answers transparent :53 traffic from the LAN, ' +
			  'so leave this empty unless something on the router itself needs a DNS server. ' +
			  'Format: tcp+udp://:5335'));
		o.placeholder = 'tcp+udp://:5335';
		o.rmempty = true;

		o = ds.taboption('dns_basic', form.ListValue, 'ipversion_prefer', _('Address family preference'));
		o.value('', _('No preference'));
		o.value('4', _('Prefer IPv4'));
		o.value('6', _('Prefer IPv6'));
		o.rmempty = true;

		o = ds.taboption('dns_basic', form.Value, 'client_subnet', _('EDNS Client Subnet'),
			_('Only set this when a CDN really needs local results. "auto" probes the public path. ' +
			  'Leaving it empty is the safe default.'));
		o.placeholder = 'auto';
		o.rmempty = true;

		o = ds.taboption('dns_basic', form.Value, 'bootstrap_resolver', _('Bootstrap resolver'),
			_('Plain host:port used to resolve node server names and upstream DoH/DoT hosts. ' +
			  'It deliberately bypasses all DNS routing below.'));
		o.placeholder = '1.1.1.1:53';
		o.datatype = 'hostport';
		o.rmempty = true;

		/* 上游列表 */
		var upv = ds.taboption('dns_basic', form.SectionValue, '_upstreams', form.GridSection, 'dns_upstream', null);
		var up = upv.subsection;
		up.addremove = true;
		up.sortable = true;
		up.anonymous = true;
		up.sectiontitle = function(section_id) {
			var name = uci.get('honk', section_id, 'name');
			return name || section_id;
		};

		o = up.option(form.Flag, 'enabled', _('Enable'));
		o.default = '1';
		o.rmempty = false;

		o = up.option(form.Value, 'name', _('Name'),
			_('Used as the tag in routing rules. Lowercase, no spaces.'));
		o.placeholder = 'cn_ali';
		o.datatype = 'and(uciname)';
		o.rmempty = false;

		o = up.option(form.Value, 'uri', _('Server'),
			_('Full URI. Supported: udp:// tcp:// tls:// https:// quic:// h3://. ' +
			  'A bare host:port means UDP.'));
		o.placeholder = 'https://dns.alidns.com/dns-query';
		o.rmempty = false;

		o = up.option(form.ListValue, 'role', _('Role'));
		o.value('cn', _('China'));
		o.value('remote', _('Remote'));
		o.default = 'remote';
		o.rmempty = false;
		o.description = _('China upstream answers geosite:cn queries; ' +
			'Remote is the fallback for everything else.');

		o = up.option(form.Value, 'outbound', _('Outbound'),
			_('Optional group name. When set, queries to this upstream are dialled through that group.'));
		o.placeholder = _('(follow routing rules)');
		o.rmempty = true;

		/* ---- 高级 ---- */
		o = ds.taboption('dns_advanced', form.Value, 'max_cache_size', _('Cache entries'),
			_('1 to 100000.'));
		o.datatype = 'range(1,100000)';
		o.default = '10000';
		o.rmempty = false;

		o = ds.taboption('dns_advanced', form.Flag, 'optimistic_cache', _('Enable cache'),
			_('Serves cached answers and refreshes them in the background.'));
		o.default = '1';
		o.rmempty = false;

		o = ds.taboption('dns_advanced', form.Value, 'optimistic_cache_ttl', _('Cache TTL override'),
			_('Seconds. honk only accepts a bare number here — a "600s" style value is silently ' +
			  'ignored and falls back to 60. 0 keeps the reply TTL.'));
		o.datatype = 'uinteger';
		o.default = '600';
		o.rmempty = false;

		o = ds.taboption('dns_advanced', form.Value, 'optimistic_stale_reply_ttl', _('Serve-stale TTL'),
			_('Seconds a stale entry may still be served while refreshing. Same bare-number rule.'));
		o.datatype = 'uinteger';
		o.default = '30';
		o.rmempty = false;

		o = ds.taboption('dns_advanced', form.Flag, 'cache_file', _('Persist cache'),
			_('Keeps the DNS cache across restarts.'));
		o.default = '1';
		o.rmempty = false;

		o = ds.taboption('dns_advanced', form.Flag, 'block_https_rr', _('Strip HTTPS/SVCB records'),
			_('Rejects QTYPE 65 so clients fall back to plain A/AAAA. Useful when ECH breaks routing.'));
		o.default = '1';
		o.rmempty = false;

		o = ds.taboption('dns_advanced', form.Flag, 'ad_block', _('Ad blocking'),
			_('Rejects qname(geosite: category-ads-all) before it reaches any upstream.'));
		o.default = '1';
		o.rmempty = false;

		/* ================= 访问控制 ================= */

		var cv = s.taboption('control', form.SectionValue, '_control', form.NamedSection, 'control', 'honk');
		cv.depends('enabled', '1');
		var cs = cv.subsection;

		o = cs.option(form.ListValue, 'lan_list_mode', _('LAN source policy'));
		o.value('0', _('Every LAN client goes through the rules below'));
		o.value('1', _('Only listed clients are proxied'));
		o.default = '0';
		o.rmempty = false;
		o.description = _('"Only listed" turns the proxy list into a whitelist: clients outside it ' +
			'are forced direct, even if the domain rules would proxy them.');

		o = cs.option(form.DynamicList, 'lan_proxy', _('LAN sources -> proxy'),
			_('CIDR or plain address. Matched with sip().'));
		o.placeholder = '188.181.1.0/24';
		o.rmempty = true;

		o = cs.option(form.DynamicList, 'lan_direct', _('LAN sources -> direct'),
			_('Matched before any domain rule, so these clients never enter a node.'));
		o.placeholder = '192.168.10.0/24';
		o.rmempty = true;

		o = cs.option(form.DynamicList, 'wan_proxy', _('Destinations -> proxy'),
			_('CIDR of destination networks that must go through a node. Matched with dip().'));
		o.placeholder = '8.8.8.0/24';
		o.rmempty = true;

		o = cs.option(form.DynamicList, 'wan_direct', _('Destinations -> direct'));
		o.placeholder = '203.0.113.0/24';
		o.rmempty = true;

		/* ================= 分流控制 ================= */

		o = s.taboption('diversion', form.DummyValue, '_div_hint', null);
		o.rawhtml = true;
		o.cfgvalue = function() {
			return E('div', { 'class': 'cbi-value-description' },
				_('Domain lists emit domain(suffix: …) rules. Entries are matched as suffixes, ' +
				  'so "qq.com" also covers "www.qq.com". One domain per line.'));
		};
		o.depends('enabled', '1');

		var dv = s.taboption('diversion', form.SectionValue, '_domain_routes', form.GridSection, 'domain_route', null);
		dv.depends('enabled', '1');
		var dr = dv.subsection;
		dr.addremove = true;
		dr.sortable = true;
		dr.anonymous = true;
		dr.sectiontitle = function(section_id) {
			return uci.get('honk', section_id, 'name') || section_id;
		};

		o = dr.option(form.Flag, 'enabled', _('Enable'));
		o.default = '1';
		o.rmempty = false;

		o = dr.option(form.Value, 'name', _('Name'));
		o.placeholder = 'cn_direct';
		o.rmempty = false;

		o = dr.option(form.ListValue, 'action', _('Action'));
		o.value('direct', _('Direct'));
		(data.groups || []).forEach(function(g) {
			o.value(g, g);
		});
		o.default = 'direct';
		o.rmempty = false;

		o = dr.option(form.TextValue, '_domains', _('Domains'),
			_('One per line.'));
		o.rows = 8;
		o.monospace = true;
		o.rmempty = true;
		o.write = function(section_id, value) {
			var list = String(value || '').split('\n')
				.map(function(v) { return v.trim(); })
				.filter(function(v) { return v.length; });
			uci.set('honk', section_id, 'domains', list);
		};
		o.cfgvalue = function(section_id) {
			var v = uci.get('honk', section_id, 'domains');
			return Array.isArray(v) ? v.join('\n') : (v || '');
		};
		o.validate = function(section_id, value) {
			if (!value)
				return true;
			var bad = (value || '').split('\n').map(function(v) { return v.trim(); })
				.filter(function(v) { return v.length && !/^[A-Za-z0-9*._-]+$/.test(v); });
			return bad.length === 0 || _('Invalid domain: ') + bad[0];
		};

		/* ================= 仪表盘 ================= */

		o = s.taboption('status', form.DummyValue, '_status_text', _('Service'));
		o.rawhtml = true;
		o.cfgvalue = function() {
			var enabled = uci.get('honk', 'config', 'enabled') === '1';
			return E('div', {}, [
				E('p', {}, enabled ? _('Enabled in configuration.') : _('Disabled in configuration.')),
				E('p', { 'class': 'cbi-value-description' },
					_('honk writes /etc/honk/config.dae on reload. For live traffic, node latency ' +
					  'and DNS statistics install doona (native API) or zashboard (Clash API) — ' +
					  'both are one-click installers from the honk project.'))
			]);
		};

		o = s.taboption('status', form.Button, '_reload', _('Regenerate config'));
		o.inputtitle = _('Regenerate');
		o.inputstyle = 'apply';
		o.onclick = function() {
			return uci.save().then(function() {
				return uci.apply();
			}).then(function() {
				ui.addNotification(null, E('p', {}, _('Configuration applied; honk reloaded.')), 'info');
			});
		};

		/* 自定义路由规则 */
		o = s.taboption('custom', form.Flag, 'custom_rules_enabled', _('Enable custom rules'),
			E('span', {}, [
				E('strong', {}, _('This replaces the whole routing block. ')),
				_('While it is on, these are all ignored: per-SSID routing, access control, ' +
				  'diversion domain lists, the IPv6 mode, the port whitelist and the QUIC setting. ' +
				  'You must write the fallback line yourself.')
			]));
		o.rmempty = false;

		o = s.taboption('custom', form.TextValue, '_custom_rules', _('Routing rules'),
			_('Write the body of the routing { } block. dae syntax, one rule per line. ' +
			  'Stored in /etc/honk/custom.rules, not in UCI.'));
		o.rows = 20;
		o.monospace = true;
		o.depends('custom_rules_enabled', '1');
		o.cfgvalue = function() {
			return fs.read('/etc/honk/custom.rules').catch(function() { return ''; });
		};
		o.write = function(section_id, value) {
			return fs.write('/etc/honk/custom.rules', String(value || ''));
		};
		o.remove = function() {
			return fs.write('/etc/honk/custom.rules', '');
		};
		o.placeholder = [
			'sip(188.181.1.0/24) -> proxy',
			'sip(188.181.2.0/24) -> proxy',
			'domain(geosite: geolocation-cn) -> direct',
			'dip(geoip: cn) -> direct',
			'l4proto(udp) && dport(443) -> block',
			'fallback: proxy'
		].join('\n');

		return m.render();
	}
});