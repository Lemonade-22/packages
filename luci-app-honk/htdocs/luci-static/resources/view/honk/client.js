'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require fs';
'require poll';

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
		return Promise.all([
			uci.load('honk'),
			uci.load('network'),
			fs.read('/var/log/honk.log').catch(function() { return ''; })
		]).then(function(res) {
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

			return { groups: groups, nodes: nodes, ifaces: ifaces, log: res[2] || '' };
		});
	},

	render: function(data) {
		var m = new form.Map('honk', _('Honk'),
			_('honk 的 eBPF 透明代理引擎。本页只写 UCI，' +
			  '真正的配置在重载时生成到 /etc/honk/config.dae。'));

		/* 公共段：开关、主节点、路由模式 */
		var s = m.section(form.NamedSection, 'config', 'honk');
		s.anonymous = true;

		/* tab 顺序就是这里的声明顺序 */
		s.tab('routing', _('路由设置'));
		s.tab('dns', _('DNS'));
		s.tab('nodes', _('节点与分组'));
		s.tab('ssid', _('多SSID分流'));
		s.tab('control', _('访问控制'));
		s.tab('diversion', _('分流控制'));
		s.tab('custom', _('自定义规则'));
		s.tab('status', _('运行状态'));

		var o = s.taboption('routing', form.Flag, 'enabled', _('启用 honk'));
		o.rmempty = false;

		o = s.taboption('routing', form.ListValue, 'main_group', _('主节点'));
		o.value('nil', _('禁用'));
		(data.groups || []).forEach(function(g) {
			o.value(g, g);
		});
		o.rmempty = false;
		o.description = _('honk 的路由目标只能是 direct / block / 组，不能填单个节点名。');

		o = s.taboption('routing', form.ListValue, 'routing_mode', _('路由模式'));
		o.value('bypass_mainland_china', _('绕过中国大陆'));
		o.value('global', _('全局'));
		o.rmempty = false;

		o = s.taboption('routing', form.ListValue, 'routing_port', _('路由端口'));
		o.value('', _('全部端口'));
		o.value('common', _('仅常用端口（跳过 P2P）'));

		o = s.taboption('routing', form.ListValue, 'quic_mode', _('QUIC 处理'));
		o.description = _('建议阻断：丢弃 UDP 443，应用回落 TCP/TLS；' +
			'设为直连则该流量从本地宽带出去；不处理则 honk 完全不碰 QUIC。');
		o.value('block', _('阻断'));
		o.value('direct', _('直连'));
		o.value('off', _('不处理'));
		o.default = 'block';
		o.rmempty = false;


		o = s.taboption('routing', form.ListValue, 'ipv6_mode', _('IPV6'));
		o.description = _('代理＝v6 走节点；直连＝从本地宽带出；' +
			'阻断（大陆除外）＝国内 v6 仍直连、其余断；全局阻断＝所有 v6 都不出网。' +
			'阻断只拦 TCP/UDP 出网，LAN 内部 v6 与 RA/SLAAC 照常。');
		o.value('proxy', _('代理 IPv6'));
		o.value('direct', _('IPv6 直连'));
		o.value('block', _('IPv6 阻断（大陆除外）'));
		o.value('block_global', _('全局 IPv6 阻断'));
		o.default = 'block';
		o.rmempty = false;


		/* infra 段：接口与运行时 */
		var sv = s.taboption('routing', form.SectionValue, '_infra', form.NamedSection, 'infra', 'honk');
		var ss = sv.subsection;

		o = ss.option(form.Value, 'lan_interface', _('LAN 接口'),
			_('承载局域网转发流量的接口。留空则只代理路由器本机流量。'));
		o.placeholder = 'br-lan';
		o.rmempty = true;

		o = ss.option(form.Value, 'wan_interface', _('WAN 接口'),
			_('承载路由器本机流量的接口。auto 表示跟随 IPv4 默认路由。'));
		o.placeholder = 'auto';
		o.rmempty = true;

		o = ss.option(form.ListValue, 'log_level', _('日志等级'));
		['error', 'warn', 'info', 'debug'].forEach(function(v) {
			o.value(v, v);
		});
		o.default = 'info';

		o = ss.option(form.Value, 'data_dir', _('运行时数据目录'));
		o.placeholder = '/var/lib/honk';
		o.rmempty = true;

		/* ================= 节点与分组 ================= */

		var nv = s.taboption('nodes', form.SectionValue, '_nodes', form.GridSection, 'node', null);
		var nodesSec = nv.subsection;
		nodesSec.addremove = true;
		nodesSec.sortable = true;
		nodesSec.anonymous = true;
		nodesSec.sectiontitle = function(section_id) {
			return uci.get('honk', section_id, 'name') || section_id;
		};

		o = nodesSec.option(form.Flag, 'enabled', _('启用'));
		o.default = '1';
		o.rmempty = false;

		o = nodesSec.option(form.Value, 'name', _('名称'));
		o.placeholder = 'hk01';
		o.rmempty = false;

		o = nodesSec.option(form.Value, 'uri', _('分享链接'));
		o.placeholder = 'vless://uuid@host:443?security=tls&sni=host#name';
		o.rmempty = false;

		var gv = s.taboption('nodes', form.SectionValue, '_groups', form.GridSection, 'group', null);
		var groupsSec = gv.subsection;
		groupsSec.addremove = true;
		groupsSec.sortable = true;
		groupsSec.anonymous = true;
		groupsSec.sectiontitle = function(section_id) {
			return uci.get('honk', section_id, 'name') || section_id;
		};

		o = groupsSec.option(form.Value, 'name', _('组名'));
		o.placeholder = 'proxy';
		o.rmempty = false;

		o = groupsSec.option(form.ListValue, 'policy', _('策略'));
		o.value('selector', _('手动选择'));
		o.value('urltest', _('延迟最低'));
		o.value('score', _('实测可靠性优先'));
		o.value('loadbalance', _('负载均衡'));
		o.value('fallback', _('故障转移（取第一个可用）'));
		o.default = 'urltest';
		o.rmempty = false;

		o = groupsSec.option(form.DynamicList, 'members', _('成员'));
		(data.nodes || []).forEach(function(n) {
			o.value(n.name, n.name);
		});
		(data.groups || []).forEach(function(g) {
			o.value(g, _('[组] ') + g);
		});
		o.rmempty = true;

		o = groupsSec.option(form.Value, 'check_url', _('健康检查地址'));
		o.placeholder = 'https://www.gstatic.com/generate_204';
		o.rmempty = true;

		o = groupsSec.option(form.Value, 'tolerance', _('切换容忍（毫秒）'));
		o.datatype = 'uinteger';
		o.placeholder = '50';
		o.rmempty = true;

		o = groupsSec.option(form.ListValue, 'final', _('兜底'));
		o.value('direct', _('直连'));
		o.value('block', _('阻断'));
		(data.groups || []).forEach(function(g) {
			o.value(g, _('[组] ') + g);
		});
		o.default = 'direct';
		o.rmempty = false;

		/* ================= 多SSID分流 ================= */

		o = s.taboption('ssid', form.DummyValue, '_ssid_hint', null);
		o.rawhtml = true;
		o.cfgvalue = function() {
			return E('div', { 'class': 'cbi-value-description' }, [
				E('p', {}, _('一行一个 SSID 网段。每行生成一条 sip(<源网段>) 出口规则；' +
					'填了 DNS 上游时，还会在 dns.routing.request 里生成对应的 sip() 规则。' +
					'这些规则排在大陆直连规则之前，所以网段总是优先。')),
				E('p', {}, (data.ifaces || []).length
					? _('可选的 wifiNN 接口：') + E('em', {}, data.ifaces.join(', '))
					: _('本机没有 wifiNN 接口——可能是 WIFI-NO 固件（无无线驱动），或者还没生成多 SSID。' +
						'接口一栏留空即可，直接填网段。'))
			]);
		};

		var sv2 = s.taboption('ssid', form.SectionValue, '_ssid_routes', form.GridSection, 'ssid_route', null);
		var ssr = sv2.subsection;
		ssr.addremove = true;
		ssr.sortable = true;
		ssr.anonymous = true;
		ssr.sectiontitle = function(section_id) {
			return uci.get('honk', section_id, 'name') || section_id;
		};

		o = ssr.option(form.Flag, 'enabled', _('启用'));
		o.default = '1';
		o.rmempty = false;

		o = ssr.option(form.Value, 'name', _('名称'));
		o.placeholder = 'jy01';
		o.rmempty = false;

		o = ssr.option(form.Value, 'source', _('源网段'));
		o.placeholder = '188.181.1.0/24';
		o.placeholder = '188.181.1.0/24';
		o.datatype = 'cidr4';
		o.rmempty = false;

		o = ssr.option(form.ListValue, 'target', _('出口组'));
		(data.groups || []).forEach(function(g) {
			o.value(g, g);
		});
		o.rmempty = false;

		o = ssr.option(form.Value, 'interface', _('接口'));
		(data.ifaces || []).forEach(function(i) {
			o.value(i, i);
		});
		o.rmempty = true;

		o = ssr.option(form.ListValue, 'dns', _('DNS 上游'));
		uci.sections('honk', 'dns_upstream').forEach(function(u) {
			if (u.name)
				o.value(u.name, u.name);
		});
		o.rmempty = true;

		/* ================= DNS ================= */

		var dnsv = s.taboption('dns', form.SectionValue, '_dns', form.NamedSection, 'infra', 'honk');
		var ds = dnsv.subsection;

		ds.tab('dns_basic', _('基础设置'));
		ds.tab('dns_servers', _('DNS服务器'));
		ds.tab('dns_advanced', _('高级设置'));

		/* ---- 基础 ---- */
		o = ds.taboption('dns_basic', form.Value, 'bind', _('独立监听'),
			_('可选。局域网来的 :53 请求 honk 已经透明接管，' +
			  '除非路由器本机有程序需要一个 DNS 服务，否则留空。' +
			  '格式：tcp+udp://:5335'));
		o.placeholder = 'tcp+udp://:5335';
		o.rmempty = true;

		o = ds.taboption('dns_basic', form.ListValue, 'ipversion_prefer', _('地址族偏好'));
		o.value('', _('不偏好'));
		o.value('4', _('优先 IPv4'));
		o.value('6', _('优先 IPv6'));
		o.rmempty = true;

		o = ds.taboption('dns_basic', form.Value, 'client_subnet', _('EDNS 客户子网'),
			_('只有在 CDN 确实需要就近结果时才设。auto 会探测公网出口。' +
			  '留空是最安全的默认值。'));
		o.placeholder = 'auto';
		o.rmempty = true;

		o = ds.taboption('dns_basic', form.Value, 'bootstrap_resolver', _('引导 DNS'),
			_('明文 host:port，用来解析节点服务器名和上游 DoH/DoT 域名。' +
			  '它故意绕开下面所有 DNS 路由。'));
		o.placeholder = '1.1.1.1:53';
		o.datatype = 'hostport';
		o.rmempty = true;

		/* 快捷选择：跟 MosDNS 一样，国内一个、国外一个 */
		var CN_DNS = {
			'udp://223.5.5.5:53': '阿里 223.5.5.5',
			'udp://223.6.6.6:53': '阿里 223.6.6.6',
			'udp://119.29.29.29:53': '腾讯 119.29.29.29',
			'udp://182.254.116.116:53': '腾讯 182.254.116.116',
			'udp://114.114.114.114:53': '114 DNS 114.114.114.114',
			'udp://114.114.115.115:53': '114 DNS 114.114.115.115',
			'udp://180.76.76.76:53': '百度 180.76.76.76',
			'https://dns.alidns.com/dns-query': '阿里 DoH',
			'https://doh.pub/dns-query': '腾讯 DoH',
			'https://doh.114dns.com/dns-query': '114 DoH',
			'https://doh.baidu.com/dns-query': '百度 DoH'
		};
		var REMOTE_DNS = {
			'udp://1.1.1.1:53': 'Cloudflare 1.1.1.1',
			'udp://1.0.0.1:53': 'Cloudflare 1.0.0.1',
			'udp://8.8.8.8:53': 'Google 8.8.8.8',
			'udp://8.8.4.4:53': 'Google 8.8.4.4',
			'udp://9.9.9.9:53': 'Quad9 9.9.9.9',
			'udp://149.112.112.112:53': 'Quad9 149.112.112.112',
			'udp://208.67.222.222:53': 'OpenDNS 208.67.222.222',
			'udp://208.67.220.220:53': 'OpenDNS 208.67.220.220',
			'udp://94.140.14.14:53': 'AdGuard 94.140.14.14',
			'udp://94.140.15.15:53': 'AdGuard 94.140.15.15',
			'udp://76.76.2.0:53': 'Control D 76.76.2.0',
			'https://dns.cloudflare.com/dns-query': 'Cloudflare DoH',
			'https://dns.google/dns-query': 'Google DoH',
			'https://dns.quad9.net/dns-query': 'Quad9 DoH',
			'https://dns.adguard-dns.com/dns-query': 'AdGuard DoH'
		};

		/* 多选：按选中的顺序重建该角色的上游段。
		   honk 的 dns.routing 只能指向一个上游，生成器取第一个；其余声明保留备用。 */
		/* 单一上游：清掉该角色旧段，重建一个。 */
		function syncUpstream(role, uri, outbound) {
			var prefix = role === 'cn' ? 'cn' : 'remote';
			uci.sections('honk', 'dns_upstream')
				.filter(function(x) { return x.role === role; })
				.forEach(function(x) { uci.remove('honk', x['.name']); });
			if (!uri) return;
			var sid = prefix + '_1';
			uci.set('honk', sid, 'dns_upstream');
			uci.set('honk', sid, 'enabled', '1');
			uci.set('honk', sid, 'name', sid);
			uci.set('honk', sid, 'role', role);
			uci.set('honk', sid, 'uri', uri);
			if (outbound) uci.set('honk', sid, 'outbound', outbound);
		}

		o = ds.taboption('dns_servers', form.ListValue, '_cn_dns', _('国内 DNS'),
			_('国内域名解析用它。选「自定义」后在下方填写。'));
		Object.keys(CN_DNS).forEach(function(k) { o.value(k, CN_DNS[k]); });
		o.value('custom', _('自定义（在下方填写）'));
		o.cfgvalue = function() {
			var sec = uci.sections('honk', 'dns_upstream').filter(function(x) { return x.role === 'cn' && x.enabled === '1'; });
			if (!sec.length) return '';
			var uri = sec[0].uri || '';
			return Object.prototype.hasOwnProperty.call(CN_DNS, uri) ? uri : 'custom';
		};
		o.write = function(section_id, value) {
			if (value && value !== 'custom') syncUpstream('cn', value, 'direct');
		};
		o.rmempty = false;

		o = ds.taboption('dns_servers', form.Value, '_cn_custom', _('自定义国内 DNS'),
			_('填完整 URI，例如 udp://223.5.5.5:53 或 https://dns.example/dns-query'));
		o.placeholder = 'udp://223.5.5.5:53';
		o.cfgvalue = function() {
			var sec = uci.sections('honk', 'dns_upstream').filter(function(x) { return x.role === 'cn' && x.enabled === '1'; });
			if (!sec.length) return '';
			var uri = sec[0].uri || '';
			return Object.prototype.hasOwnProperty.call(CN_DNS, uri) ? '' : uri;
		};
		o.write = function(section_id, value) {
			if (value) syncUpstream('cn', value, 'direct');
		};
		o.rmempty = true;

		o = ds.taboption('dns_servers', form.ListValue, '_remote_dns', _('国外 DNS'),
			_('其余域名用它。选「自定义」后在下方填写。'));
		Object.keys(REMOTE_DNS).forEach(function(k) { o.value(k, REMOTE_DNS[k]); });
		o.value('custom', _('自定义（在下方填写）'));
		o.cfgvalue = function() {
			var sec = uci.sections('honk', 'dns_upstream').filter(function(x) { return x.role === 'remote' && x.enabled === '1'; });
			if (!sec.length) return '';
			var uri = sec[0].uri || '';
			return Object.prototype.hasOwnProperty.call(REMOTE_DNS, uri) ? uri : 'custom';
		};
		o.write = function(section_id, value) {
			if (value && value !== 'custom') syncUpstream('remote', value, null);
		};
		o.rmempty = false;

		o = ds.taboption('dns_servers', form.Value, '_remote_custom', _('自定义国外 DNS'),
			_('填完整 URI，例如 udp://1.1.1.1:53 或 https://dns.example/dns-query'));
		o.placeholder = 'udp://1.1.1.1:53';
		o.cfgvalue = function() {
			var sec = uci.sections('honk', 'dns_upstream').filter(function(x) { return x.role === 'remote' && x.enabled === '1'; });
			if (!sec.length) return '';
			var uri = sec[0].uri || '';
			return Object.prototype.hasOwnProperty.call(REMOTE_DNS, uri) ? '' : uri;
		};
		o.write = function(section_id, value) {
			if (value) syncUpstream('remote', value, null);
		};
		o.rmempty = true;

		/* 上游列表 */
		var upv = ds.taboption('dns_servers', form.SectionValue, '_upstreams', form.GridSection, 'dns_upstream', null);
		var up = upv.subsection;
		up.addremove = true;
		up.sortable = true;
		up.anonymous = true;
		up.sectiontitle = function(section_id) {
			var name = uci.get('honk', section_id, 'name');
			return name || section_id;
		};

		o = up.option(form.Flag, 'enabled', _('启用'));
		o.default = '1';
		o.rmempty = false;

		o = up.option(form.Value, 'name', _('名称'));
		o.placeholder = 'cn_ali';
		o.datatype = 'and(uciname)';
		o.rmempty = false;

		o = up.option(form.Value, 'uri', _('服务器'));
		o.placeholder = 'https://dns.alidns.com/dns-query';
		o.rmempty = false;

		o = up.option(form.ListValue, 'role', _('角色'));
		o.value('cn', _('大陆'));
		o.value('remote', _('远端'));
		o.default = 'remote';
		o.rmempty = false;

		o = up.option(form.Value, 'outbound', _('出站'));
		o.placeholder = _('（跟随路由规则）');
		o.rmempty = true;

		/* ---- 高级 ---- */
		o = ds.taboption('dns_advanced', form.Value, 'max_cache_size', _('缓存条数'),
			_('取值 1 到 100000。'));
		o.datatype = 'range(1,100000)';
		o.default = '10000';
		o.rmempty = false;

		o = ds.taboption('dns_advanced', form.Flag, 'optimistic_cache', _('启用缓存'),
			_('先返回缓存结果，同时后台刷新。'));
		o.default = '1';
		o.rmempty = false;

		o = ds.taboption('dns_advanced', form.Value, 'optimistic_cache_ttl', _('缓存 TTL 覆盖'),
			_('单位秒。honk 这里只吃裸数字——写成 600s 会被静默忽略并回退到 60。' +
			  '填 0 表示沿用应答本身的 TTL。'));
		o.datatype = 'uinteger';
		o.default = '600';
		o.rmempty = false;

		o = ds.taboption('dns_advanced', form.Value, 'optimistic_stale_reply_ttl', _('过期容忍 TTL'),
			_('刷新期间过期记录还能返回多久（秒）。同样只填数字。'));
		o.datatype = 'uinteger';
		o.default = '30';
		o.rmempty = false;

		o = ds.taboption('dns_advanced', form.Flag, 'cache_file', _('持久化缓存'),
			_('重启后保留 DNS 缓存。'));
		o.default = '1';
		o.rmempty = false;

		o = ds.taboption('dns_advanced', form.Flag, 'block_https_rr', _('剥离 HTTPS/SVCB 记录'),
			_('拒绝 QTYPE 65，让客户端回落到普通 A/AAAA。ECH 影响分流时有用。'));
		o.default = '1';
		o.rmempty = false;

		/* 自定义广告域名：写文件，生成器按 40 个一组拆成 domain(suffix:) 规则 */
		o = ds.taboption('dns_advanced', form.TextValue, '_adblock_list', _('自定义广告域名'),
			_('一行一个域名，按后缀匹配，所以 example.com 也覆盖 a.example.com。' +
			  '存在 /etc/honk/adblock.list，与上面的 geosite 广告分类叠加生效。'));
		o.rows = 10;
		o.monospace = true;
		o.cfgvalue = function() {
			return fs.read('/etc/honk/adblock.list').catch(function() { return ''; });
		};
		o.write = function(section_id, value) {
			return fs.write('/etc/honk/adblock.list', String(value || ''));
		};
		o.remove = function() {
			return fs.write('/etc/honk/adblock.list', '');
		};
		o.placeholder = 'doubleclick.net\nads.example.com\ntracker.example.org';

		o = ds.taboption('dns_advanced', form.Flag, 'ad_block', _('广告过滤'),
			_('在到达任何上游之前拒绝广告域名。'));
		o.default = '1';
		o.rmempty = false;

		/* ================= 访问控制 ================= */

		var cv = s.taboption('control', form.SectionValue, '_control', form.NamedSection, 'control', 'honk');
		var cs = cv.subsection;

		o = cs.option(form.ListValue, 'lan_list_mode', _('局域网源地址策略'));
		o.value('0', _('所有局域网客户端都走下面的规则'));
		o.value('1', _('仅列表内的客户端走代理'));
		o.default = '0';
		o.rmempty = false;
		o.description = _('选了“仅列表内的客户端走代理”时，代理列表变成白名单：' +
			'列表之外的客户端一律强制直连，哪怕域名规则本来会让它走代理。');

		o = cs.option(form.DynamicList, 'lan_proxy', _('局域网源地址 → 代理'),
			_('网段或单个地址，按 sip() 匹配。'));
		o.placeholder = '188.181.1.0/24';
		o.rmempty = true;

		o = cs.option(form.DynamicList, 'lan_direct', _('局域网源地址 → 直连'),
			_('优先于所有域名规则，这些客户端不会进入节点。'));
		o.placeholder = '192.168.10.0/24';
		o.rmempty = true;

		o = cs.option(form.DynamicList, 'wan_proxy', _('目标地址 → 代理'),
			_('必须走节点的目标网段，按 dip() 匹配。'));
		o.placeholder = '8.8.8.0/24';
		o.rmempty = true;

		o = cs.option(form.DynamicList, 'wan_direct', _('目标地址 → 直连'));
		o.placeholder = '203.0.113.0/24';
		o.rmempty = true;

		/* ================= 分流控制 ================= */

		o = s.taboption('diversion', form.DummyValue, '_div_hint', null);
		o.rawhtml = true;
		o.cfgvalue = function() {
			return E('div', { 'class': 'cbi-value-description' },
				_('域名列表会生成 domain(suffix: …) 规则，按后缀匹配，' +
				  '所以 qq.com 也覆盖 www.qq.com。一行一个域名。'));
		};

		var dv = s.taboption('diversion', form.SectionValue, '_domain_routes', form.GridSection, 'domain_route', null);
		var dr = dv.subsection;
		dr.addremove = true;
		dr.sortable = true;
		dr.anonymous = true;
		dr.sectiontitle = function(section_id) {
			return uci.get('honk', section_id, 'name') || section_id;
		};

		o = dr.option(form.Flag, 'enabled', _('启用'));
		o.default = '1';
		o.rmempty = false;

		o = dr.option(form.Value, 'name', _('名称'));
		o.placeholder = 'cn_direct';
		o.rmempty = false;

		o = dr.option(form.ListValue, 'action', _('动作'));
		o.value('direct', _('直连'));
		(data.groups || []).forEach(function(g) {
			o.value(g, g);
		});
		o.default = 'direct';
		o.rmempty = false;

		o = dr.option(form.TextValue, '_domains', _('域名'));
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
			return bad.length === 0 || _('域名无效：') + bad[0];
		};

		/* ================= 仪表盘 ================= */

		o = s.taboption('status', form.DummyValue, '_status_text', _('服务'));
		o.rawhtml = true;
		o.cfgvalue = function() {
			var enabled = uci.get('honk', 'config', 'enabled') === '1';
			return E('div', {}, [
				E('p', {}, enabled ? _('配置中已启用。') : _('配置中已禁用。')),
				E('p', { 'class': 'cbi-value-description' },
					_('honk 在重载时写出 /etc/honk/config.dae。要看实时流量、节点延迟' +
					  '和 DNS 统计，装 doona（原生 API）或 zashboard（Clash API）——' +
					  '两者都是 honk 项目提供的一键安装。'))
			]);
		};

		/* 日志观察窗：poll 每 5 秒重读一次，只读 */
		o = s.taboption('status', form.DummyValue, '_log', _('运行日志'));
		o.rawhtml = true;
		o.cfgvalue = function() {
			var box = E('pre', {
				'class': 'cbi-input-textarea',
				'style': 'height:22em;overflow:auto;white-space:pre-wrap;word-break:break-all;' +
					'font-family:monospace;font-size:12px;margin:0;'
			}, data.log || _('（暂无日志）'));
			poll.add(function() {
				return fs.read('/var/log/honk.log').then(function(txt) {
					box.textContent = txt || _('（暂无日志）');
					box.scrollTop = box.scrollHeight;
				}).catch(function() {});
			}, 5);
			return box;
		};

		/* 仪表盘：honk 自己不带 Web UI，第三方要另装 */
		o = s.taboption('status', form.DummyValue, '_dash', _('仪表盘'));
		o.rawhtml = true;
		o.cfgvalue = function() {
			return E('div', { 'class': 'cbi-value-description' }, [
				E('p', {}, _('doona：honk 官方 Web 界面，走原生 API，能看到实时连接与节点延迟。')),
				E('p', {}, _('zashboard：基于 Clash API 的通用界面，观感更接近 Clash 系工具。')),
				E('p', {}, _('两者都不随本插件安装。honk-core 起来之后，' +
					'用 honk 项目提供的安装包自行安装即可；装好后从这里访问对应的本体地址。'))
			]);
		};

		o = s.taboption('status', form.Button, '_reload', _('重新生成配置'));
		o.inputtitle = _('重新生成');
		o.inputstyle = 'apply';
		o.onclick = function() {
			return uci.save().then(function() {
				return uci.apply();
			}).then(function() {
				ui.addNotification(null, E('p', {}, _('配置已应用，honk 已重载。')), 'info');
			});
		};

		/* 自定义路由规则 */
		o = s.taboption('custom', form.Flag, 'custom_rules_enabled', _('启用自定义规则'),
			_('这会整段替换路由规则。开启后，多SSID分流、访问控制、分流控制、IPv6 模式、' +
			  '端口白名单和 QUIC 设置全部失效；兜底那条 fallback 也要你自己写。'));
		o.rmempty = false;

		o = s.taboption('custom', form.TextValue, '_custom_rules', _('路由规则'),
			_('写 routing { } 的内部内容，dae 语法，一行一条规则。' +
			  '存在 /etc/honk/custom.rules 里，不走 UCI。'));
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