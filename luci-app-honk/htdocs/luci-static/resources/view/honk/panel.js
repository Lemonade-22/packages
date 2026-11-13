'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require fs';
'require poll';
'require honk';

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
			uci.load('wireless'),
			fs.exec('/usr/share/honk/log-tail.sh').then(function(r) { return r.stdout; }).catch(function() { return ''; }),
			honk.nodes().catch(function() { return []; })
		]).then(function(res) {
			var groups = uci.sections('honk', 'group').map(function(g) {
				return (g.name || g['.name'] || '').trim();
			}).filter(function(n) { return n.length > 0; });

			var nodes = uci.sections('honk', 'node').filter(function(n) {
				return !n.subscription && n.enabled === '1' && (n.uri || '').length > 0;
			}).map(function(n) {
				return { id: n['.name'], name: n.name || n['.name'], uri: n.uri };
			});

			var ifaces = uci.sections('network', 'interface')
				.map(function(i) { return i['.name']; })
				.filter(function(n) { return /^wifi\d+$/.test(n); })
				.sort();

			return { groups: groups, nodes: nodes.concat(res[4] || []), ifaces: ifaces, log: res[3] || '' };
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
		s.tab('subs', _('订阅'));
		s.tab('picking', _('选优'));
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

		var nv = s.taboption('nodes', form.SectionValue, '_manual_nodes', form.GridSection, 'node', _('手动节点'));
		var nodesSec = nv.subsection;
		nodesSec.addremove = true;
		nodesSec.sortable = true;
		nodesSec.anonymous = true;
		nodesSec.filter = function(id) { return !uci.get('honk', id, 'subscription'); };
		nodesSec.sectiontitle = function(id) { return uci.get('honk', id, 'name') || id; };
		o = s.taboption('nodes', form.DummyValue, '_native_hint', _('订阅节点'));
		o.cfgvalue = function() { return _('订阅节点由内核解析，在“选优”页查看与测试。旧版导入记录保留在 UCI 中作为备份，不重复加载。'); };

		/* 批量导入：honk 直接吃分享链接，不需要像 sing-box 那样逐字段解析 */
		nodesSec.renderSectionAdd = function() {
			var el = form.GridSection.prototype.renderSectionAdd.apply(this, arguments);

			el.appendChild(E('button', {
				'class': 'cbi-button cbi-button-action',
				'style': 'margin-left:8px;',
				'click': ui.createHandlerFn(this, function() {
					var ta = E('textarea', {
						'class': 'cbi-input-textarea',
						'style': 'width:100%;height:14em;font-family:monospace;font-size:12px;',
						'placeholder': 'vless://uuid@host:443?security=tls&sni=host#hk01\n' +
						               'hysteria2://pass@host:8443?sni=host#us01'
					});

					ui.showModal(_('导入分享链接'), [
						E('p', {}, _('一行一条。节点名取自链接末尾 # 后面的部分，没有就自动编号。')),
						ta,
						E('div', { 'class': 'right' }, [
							E('button', { 'class': 'btn', 'click': ui.hideModal }, _('取消')),
							' ',
							E('button', {
								'class': 'btn cbi-button-action',
								'click': ui.createHandlerFn(this, function() {
									var links = String(ta.value || '').split('\n')
										.map(function(x) { return x.trim(); })
										.filter(function(x) { return x.length > 0; });
									if (!links.length)
										return ui.hideModal();

									var used = {};
									uci.sections('honk', 'node').forEach(function(n) {
										if (n.name) used[n.name] = 1;
									});

									var added = 0, idx = 0;
									links.forEach(function(link) {
										var name = '';
										var h = link.indexOf('#');
										if (h >= 0) {
											try { name = decodeURIComponent(link.slice(h + 1)); }
											catch (e) { name = link.slice(h + 1); }
										}
										name = name.replace(/[\r\n]/g, '').trim();
										if (!name) name = 'node';
										while (used[name]) name = name.replace(/\d+$/, '') + (++idx);
										used[name] = 1;

										var sid = uci.add('honk', 'node');
										uci.set('honk', sid, 'enabled', '1');
										uci.set('honk', sid, 'name', name);
										uci.set('honk', sid, 'uri', link);
										added++;
									});

									return uci.save()
										.then(L.bind(this.map.load, this.map))
										.then(L.bind(this.map.reset, this.map))
										.then(function() {
											ui.addNotification(null, E('p', {},
												_('已导入 %d 个节点').format(added)));
											ui.hideModal();
										});
								})
							}, _('导入'))
						])
					]);
				})
			}, _('导入分享链接')));

			return el;
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

		/* ================= 订阅 ================= */
		o = s.taboption('subs', form.DummyValue, '_subs_hint', null);
		o.rawhtml = true;
		o.cfgvalue = function() {
			return E('div', { 'class': 'cbi-value-description' },
				_('填写订阅后先保存并应用，再更新已生效订阅。由 honk 原生解析链接、Base64、Clash YAML 和支持的 JSON 订阅；解析失败会显示错误。'));
		};

		var subv = s.taboption('subs', form.SectionValue, '_subscriptions', form.GridSection, 'subscription', null);
		var subsSec = subv.subsection;
		subsSec.addremove = true;
		subsSec.sortable = true;
		subsSec.anonymous = true;
		subsSec.sectiontitle = function(section_id) {
			return uci.get('honk', section_id, 'name') || section_id;
		};

		o = subsSec.option(form.Flag, 'enabled', _('启用'));
		o.default = '1';
		o.rmempty = false;

		o = subsSec.option(form.Value, 'name', _('名称'));
		o.placeholder = '机场A';
		o.rmempty = false;

		o = subsSec.option(form.Value, 'url', _('订阅地址'));
		o.placeholder = 'https://example.com/sub?token=xxx';
		o.datatype = 'url';
		o.rmempty = false;

		o = subsSec.option(form.Value, 'tag', _('订阅标识'));
		o.placeholder = 'sub';
		o.rmempty = true;

		o = subsSec.option(form.Value, 'interval', _('自动更新间隔（秒）'));
		o.datatype = 'uinteger'; o.default = '86400';
		o = subsSec.option(form.Value, 'user_agent', _('订阅 User-Agent'));
		o.rmempty = true;
		o = s.taboption('subs', form.DummyValue, '_fetch_subs', _('已生效订阅'));
		o.rawhtml = true;
		o.cfgvalue = function() { return honk.renderProviders(); };

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
		o.validate = function(id, value) { return (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) && value !== 'direct' && value !== 'block') || _('组名需使用字母、数字、下划线或连字符，不能使用 direct/block'); };
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

		o = groupsSec.option(form.DynamicList, 'providers', _('订阅成员'));
		uci.sections('honk', 'subscription').filter(function(s) { return s.enabled === '1'; }).forEach(function(s) {
			var tag = s.tag || s.name || s['.name']; o.value(tag, tag);
		});
		o.description = _('自动包含选中订阅的节点。成员和订阅成员均留空时，组包含全部节点。');
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
		o.default = 'block';
		o.rmempty = false;

		/* ================= 多SSID分流 ================= */

		// 标题留空会让标题列塌成一条，tooltip 图标单独掉到按钮左上方。
		// 给个正常标题，图标就和文字对齐了。
		// description 必须真空串：CSS :empty 里一个空格也算内容，会触发主题的 help 图标
		o = s.taboption('ssid', form.DummyValue, '_ssid_hint', _('无线网络'), '');
		o.rawhtml = true;
		o.cfgvalue = function() {
			var btn = E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'style': 'margin-right:8px',
				'click': ui.createHandlerFn(this, function(ev) {
					ev.preventDefault();
					var ifaces = uci.sections('wireless', 'wifi-iface') || [];
					if (!ifaces.length) {
						ui.addNotification(null, E('p', {}, _('没读到无线接口：本机可能没有无线驱动，' +
							'或者 /etc/config/wireless 里没有 wifi-iface。')), 'warning');
						return;
					}

					// 每行一个勾选框，默认全选
					var boxes = ifaces.map(function(w) {
						var dev = uci.get('wireless', w['.name'], 'ifname') ||
							uci.get('wireless', w['.name'], 'network') || w['.name'];
						var cb = E('input', { 'type': 'checkbox', 'checked': 'checked' });
						var row = E('label', { 'style': 'display:block;padding:2px 0' }, [
							cb,
							' ',
							E('strong', {}, w.ssid || '(无 SSID)'),
							E('span', { 'style': 'color:#888;margin-left:8px' }, dev)
						]);
						return { cb: cb, ssid: w.ssid || w['.name'], dev: dev, cfg: w };
					});

					ui.showModal(_('读取到的无线网络'), [
						E('p', {}, _('勾选要生成分流规则的 SSID。已在列表里的会跳过。')),
						E('div', { 'style': 'max-height:18em;overflow:auto' }, boxes.map(function(b) { return b.cb.parentNode; })),
						E('div', { 'class': 'right' }, [
							E('button', { 'class': 'btn', 'click': ui.hideModal }, _('取消')),
							' ',
							E('button', {
								'class': 'btn cbi-button-action',
								'click': ui.createHandlerFn(this, function() {
									var existing = {};
									uci.sections('honk', 'ssid_route').forEach(function(x) {
										if (x.name) existing[x.name] = 1;
									});

									var added = 0;
									boxes.forEach(function(b) {
										if (!b.cb.checked)
											return;
										if (existing[b.ssid])
											return;

										var sid = uci.add('honk', 'ssid_route');
										uci.set('honk', sid, 'enabled', '1');
										uci.set('honk', sid, 'name', b.ssid);
										// interface 不填：那个字段要的是 network 里的 wifiN 接口名，
										// 跟 wireless 的 ifname 不是一回事，硬填会写错。
										added++;
									});

									if (!added) {
										ui.addNotification(null, E('p', {}, _('没有新增：选中的要么没勾，要么已经在列表里了。')), 'info');
										return ui.hideModal();
									}

									return uci.save()
										.then(L.bind(this.map.load, this.map))
										.then(L.bind(this.map.reset, this.map))
										.then(function() {
											ui.addNotification(null, E('p', {},
												_('已添加 %d 条，源网段还需要你自己填。').format(added)), 'info');
											ui.hideModal();
										});
								})
							}, _('添加'))
						])
					]);
				})
			}, _('读取无线网络'));

			var had = uci.sections('wireless', 'wifi-iface') || [];
			// 不用 cbi-value-description：主题会给非空的它加一个绝对定位的 help 图标，
			// 在这里会飘到按钮左上方。普通 div 没这个问题。
			return E('div', { 'style': 'line-height:1.7' }, [
				E('div', { 'style': 'margin-bottom:8px' }, [ btn ]),
				E('p', {}, _('一行一个 SSID 网段。每行生成一条 sip(<源网段>) 出口规则；' +
					'填了 DNS 上游时，还会在 dns.routing.request 里生成对应的 sip() 规则。' +
					'这些规则排在大陆直连规则之前，所以网段总是优先。')),
				E('p', {}, had.length
					// 字符串 + DOM 会变成 "[object HTMLElement]"，必须用数组
					? [
						_('本机无线网络：'),
						E('em', {}, had.map(function(w) { return (w.ssid || w['.name']); }).join('、'))
					]
					: _('本机没有读到无线接口——可能是 WIFI-NO 固件（无无线驱动）。' +
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

		o = ssr.option(form.ListValue, 'interface', _('接口'));
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

		function dnsValue(role) {
			var value = uci.get('honk', 'infra', role + '_dns');
			if (value !== undefined && value !== null) return value;
			// 只有字段完全不存在（旧安装）才回落到 dns_upstream section。
			// 新版本会写 'none' 占位，所以字段存在即代表用户已明确表过态。
			var old = uci.sections('honk', 'dns_upstream').filter(function(s) { return s.role === role && s.enabled === '1'; });
			return old.length ? old[0].uri || '' : 'none';
		}
		[['cn', CN_DNS, _('国内 DNS')], ['remote', REMOTE_DNS, _('国外 DNS')]].forEach(function(spec) {
			var role = spec[0], choices = spec[1], key = role + '_dns';
			var select = ds.taboption('dns_servers', form.ListValue, key, spec[2]);
			Object.keys(choices).forEach(function(k) { select.value(k, choices[k]); });
			// "不设置"必须写成哨兵值。UCI 不会保存空字符串 option，
			// 写空串等于把这行删掉，生成器还以为用户在用旧版 section 配置，
			// 于是清空之后旧上游又冒出来。
			select.value('custom', _('— 自定义 —')); select.value('none', _('（不设置）'));
			select.rmempty = false;
			select.cfgvalue = function() { var v = dnsValue(role); return v && !choices[v] ? 'custom' : v; };
			select.write = function(id, value) { uci.set('honk', 'infra', key, value || 'none'); };
			var custom = ds.taboption('dns_servers', form.Value, key + '_custom', _('自定义 DNS URI'));
			custom.depends(key, 'custom'); custom.rmempty = false;
			custom.cfgvalue = function() {
				var v = dnsValue(role);
				return uci.get('honk', 'infra', key + '_custom') || (v && v !== 'custom' && !choices[v] ? v : '');
			};
			custom.write = function(id, value) { uci.set('honk', 'infra', key + '_custom', value); };
			custom.validate = function(id, value) { return /^(udp|tcp|tls|https):\/\//.test(value) || _('请输入完整 DNS URI'); };
		});

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

		o = ds.taboption('dns_advanced', form.Flag, 'ad_block', _('DNS 广告过滤'),
			_('在到达任何上游之前拒绝广告域名。'));
		o.default = '1';
		o.rmempty = false;

		/* 规则来源：跟 mosdns 一样用 DynamicList——每项一个可编辑输入框，
		   底部下拉追加预设。值就是 URL 本身，也可以直接回车输入。 */
		o = ds.taboption('dns_advanced', form.DynamicList, 'ad_block_source', _('广告过滤规则来源'),
			_('从下拉选预设，或直接输入列表 URL 回车。留空表示只用上面的 geosite 分类。' +
			  '支持本地文件，如 file:///etc/honk/adblock.list'));
		o.value('geosite.dat', 'v2ray-geosite（内置分类）');
		o.value('https://anti-ad.net/domains.txt', 'anti-AD');
		o.value('https://adrules.top/adblock.txt', 'AdRules');
		o.value('https://raw.githubusercontent.com/privacy-protection-tools/anti-AD/master/anti-ad-domains.txt', 'anti-AD（GitHub）');
		o.value('https://raw.githubusercontent.com/Cats-Team/AdRules/main/mosdns_adrules.txt', 'Cats-Team/AdRules');
		o.value('https://raw.githubusercontent.com/neodevpro/neodevhost/master/domain', 'NEO DEV HOST');
		o.depends('ad_block', '1');
		o.rmempty = true;

		o = ds.taboption('dns_advanced', form.Button, '_fetch_adblock', _('更新规则'));
		o.inputtitle = _('立即更新');
		o.inputstyle = 'apply';
		o.depends('ad_block', '1');
		o.onclick = function() {
			var out = E('pre', {
				'class': 'cbi-input-textarea',
				'style': 'height:12em;overflow:auto;white-space:pre-wrap;font-family:monospace;font-size:12px;'
			}, _('正在更新…'));
			ui.showModal(_('更新广告规则'), [out, E('div', { 'class': 'right' },
				E('button', { 'class': 'btn', 'click': ui.hideModal }, _('关闭')))]);
			return uci.save().then(function() {
				return fs.exec('/usr/share/honk/update-adblock.sh');
			}).then(function(res) {
				out.textContent = (res.stdout || '') + (res.stderr || '');
				return fs.read('/etc/honk/adblock.list').catch(function() { return ''; });
			}).then(function(txt) {
				var n = (txt || '').split('\n').filter(function(x) { return x.trim(); }).length;
				out.textContent += '\n\n当前列表：' + n + ' 条';
			}).catch(function(e) { out.textContent = String(e); });
		};

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

		o = s.taboption('picking', form.DummyValue, '_picking', _('节点状态与选择'));
		o.rawhtml = true;
		o.cfgvalue = function() { return honk.renderPicking(); };

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

		o = s.taboption('status', form.DummyValue, '_probe', _('连通性'));
		o.rawhtml = true;
		o.cfgvalue = function() { return honk.renderConnection(); };

		/* 资源：geo 数据在不在、多大、什么时候更新的 */
		o = s.taboption('status', form.DummyValue, '_res', _('规则资源'));
		o.rawhtml = true;
		o.cfgvalue = function() {
			var files = [
				['geoip.dat', _('GeoIP 数据（CN + private）')],
				['geosite.dat', _('GeoSite 数据')]
			];
			var table = E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, _('文件')),
					E('th', { 'class': 'th' }, _('状态')),
					E('th', { 'class': 'th' }, _('大小')),
					E('th', { 'class': 'th' }, _('更新时间'))
				])
			]);

			var updBtn = E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'click': ui.createHandlerFn(this, function(ev) {
					ev.preventDefault();
					var out = E('pre', {
						'class': 'cbi-input-textarea',
						'style': 'height:12em;overflow:auto;white-space:pre-wrap;font-family:monospace;font-size:12px;'
					}, _('正在下载 GeoIP / GeoSite…'));
					ui.showModal(_('更新规则资源'), [out, E('div', { 'class': 'right' },
						E('button', { 'class': 'btn', 'click': ui.hideModal }, _('关闭')))]);
					return fs.exec('/usr/share/honk/update-geo.sh').then(function(res) {
						out.textContent = (res.stdout || '') + (res.stderr || '');
						if (res.code !== 0) throw new Error(res.stderr || _('规则下载失败'));
						return honk.reload();
					}).then(function() {
						out.textContent += '\n\nhonk 已重载。';
					}).catch(function(e) { out.textContent = String(e); });
				})
			}, _('更新全部'));

			return Promise.all(files.map(function(item) {
				return fs.stat('/usr/share/honk/geo/' + item[0])
					.catch(function() { return null; });
			})).then(function(stats) {
				files.forEach(function(item, i) {
					var st = stats[i];
					table.appendChild(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td' }, item[1]),
						E('td', { 'class': 'td' },
							st ? E('span', { 'style': 'color:green' }, _('就绪'))
							   : E('span', { 'style': 'color:red' }, _('缺失'))),
						E('td', { 'class': 'td' },
							st ? (Math.round(st.size / 1024) + ' KB') : '-'),
						E('td', { 'class': 'td' },
							(st && st.mtime) ? new Date(st.mtime).toLocaleString() : '-')
					]));
				});
				if (!stats.some(Boolean))
					table.appendChild(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td', 'colspan': 4 },
							_('一个都没有。geo 规则会静默失效，honk 只打 WARN 不会报错。'))
					]));
				return E('div', {}, [
					E('div', { 'style': 'margin-bottom:8px' }, [ updBtn ]),
					table
				]);
			});
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
				return fs.exec('/usr/share/honk/log-tail.sh').then(function(res) {
					var txt = res.stdout;
					box.textContent = txt || _('（暂无日志）');
					box.scrollTop = box.scrollHeight;
				}).catch(function() {});
			}, 5);
			return box;
		};

		/* 仪表盘：装了什么就显示什么入口。
		   doona 挂在 native API 端口，zashboard 一类挂 Clash API 端口。 */
		o = s.taboption('status', form.DummyValue, '_dash', _('仪表盘'));
		o.rawhtml = true;
		o.cfgvalue = function() {
			var box = E('div', { 'style': 'line-height:1.8' }, _('正在检测…'));

			// 面板入口做成按钮，不把地址裸露出来
			function panelButton(label, href) {
				var btn = E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'style': 'margin-left:10px'
				}, label);
				btn.addEventListener('click', function(ev) {
					ev.preventDefault();
					window.open(href, '_blank', 'noopener,noreferrer');
				});
				return btn;
			}

			function line(color, label, btnLabel, href, extra) {
				var parts = [ E('span', { 'style': 'color:' + color + ';font-weight:600' }, label) ];
				if (href)
					parts.push(panelButton(btnLabel, href));
				if (extra)
					parts.push('  ', E('span', { 'style': 'color:#888' }, extra));
				return E('p', { 'style': 'margin:0;display:flex;align-items:center;flex-wrap:wrap;gap:6px' }, parts);
			}

			function check() {
				return fs.exec('/usr/share/honk/dash-status.sh').then(function(res) {
					var parts = String(res.stdout || '').trim().split('|');
					var kind = parts[0] || '';
					var url = (parts[1] || '').trim();

					box.innerHTML = '';
					switch (kind) {
					case 'doona':
						box.appendChild(line('#19be6b', _('doona 已安装'), _('Doona'), url));
						break;
					case 'zashboard':
						box.appendChild(line('#19be6b', _('zashboard 已安装'), _('Zashboard'), url));
						break;
					case 'metacubexd':
						box.appendChild(line('#19be6b', _('metacubexd 已安装'), _('MetaCubeXD'), url));
						break;
					case 'yacd':
						box.appendChild(line('#19be6b', _('yacd 已安装'), _('YACD'), url));
						break;
					case 'doona-installed':
						box.appendChild(line('#ff9900', _('doona 已安装'), _('Doona'), url,
							_('honk 没在运行，点开是空的。')));
						break;
					case 'nopanel':
						box.appendChild(line('gray', _('没有 Web 面板'), null, null,
							_('装了 doona 或 zashboard 后这里会出现入口。')));
						break;
					default:
						box.appendChild(line('gray', _('无法检测'), null, null,
							_('honk-core 没在运行，或者 native API 没开。')));
					}

					// 两个面板都装的情况很少，但装了就把另一个也列出来
					if (kind === 'doona' || kind === 'doona-installed') {
						box.appendChild(E('p', { 'style': 'margin:4px 0 0;color:#888' },
							_('zashboard：基于 Clash API 的第三方面板，需另装且 honk-core 带 clash-api。')));
					}
				}).catch(function(e) {
					box.textContent = String(e);
				});
			}

			check();
			poll.add(check, 15);
			return box;
		};

		o = s.taboption('status', form.Button, '_reload', _('重新生成配置'));
		o.inputtitle = _('重新生成');
		o.inputstyle = 'apply';
		o.onclick = function() {
			return honk.reload().then(function() {
				ui.addNotification(null, E('p', {}, _('已重新载入已保存的配置。未保存的表单请使用“保存并应用”。')), 'info');
			}).catch(function(e) { ui.addNotification(null, E('p', {}, e.message), 'error'); });
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

		
		/* 顶部运行状态条，照 HomeProxy 的做法：先判断有没有装、有没有在跑，
		   再决定文字和颜色。没装的时候提示去装，而不是空着。 */
		var _statusBanner = E('div', {
			'style': 'padding:8px 0;margin:0 0 10px;font-weight:600;font-size:14px;' +
			         'font-style:italic;color:#d9534f;border-bottom:1px solid #ddd;'
		}, _('正在读取 honk 状态…'));

		function refreshBanner() {
			return fs.exec('/usr/share/honk/honk-status.sh').then(function(res) {
				var line = String(res.stdout || '').trim();
				var parts = line.split('|');
				var state = parts[0] || 'missing';
				var ver = (parts[1] || '').trim();
				var label = ver ? 'honk-core ' + ver : 'honk-core';

				if (state === 'running') {
					_statusBanner.style.color = '#19be6b';
					_statusBanner.textContent = label + ' ' + _('运行中');
				} else if (state === 'stopped') {
					_statusBanner.style.color = '#ed4014';
					_statusBanner.textContent = label + ' ' + _('未运行');
				} else {
					_statusBanner.style.color = '#ff9900';
					_statusBanner.textContent = _('honk-core 未安装');
				}
			}).catch(function(e) {
				_statusBanner.style.color = '#ff9900';
				_statusBanner.textContent = _('无法读取状态：') + e;
			});
		}

		var applyStatus = honk.renderApplyStatus();
		refreshBanner();
		poll.add(refreshBanner, 10);

		return m.render().then(function(el) {
			// HomeProxy 的排版：标题 → 副标题 → 状态行 → 选项卡。
			// 所以在副标题后面插入，而不是整页最前面。
			el.appendChild(applyStatus);
			var anchor = el.querySelector('.cbi-map-descr');
			if (anchor && anchor.nextSibling)
				el.insertBefore(_statusBanner, anchor.nextSibling);
			else if (anchor)
				el.appendChild(_statusBanner);
			else
				el.insertBefore(_statusBanner, el.firstChild);
			return el;
		});
	}
});