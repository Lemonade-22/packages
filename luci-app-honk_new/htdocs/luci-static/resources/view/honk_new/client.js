'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require fs';
'require poll';
'require honk_new';

/*
 * luci-app-honk_new · 客户端设置
 *
 * 这一页只写 UCI，真正的 dae 配置由 /etc/init.d/honk_new 的 reload 生成。
 * 路由目标只能是 direct / block / 组，所以这里是「主分组」，不是主节点。
 */
return view.extend({
	load: function() {
		return Promise.all([
			uci.load('honk_new'),
			uci.load('network'),
			uci.load('wireless')
		]).then(function() {
			var groups = uci.sections('honk_new', 'group').map(function(g) {
				return (g.name || g['.name'] || '').trim();
			}).filter(function(n) { return n.length > 0; });

			var ifaces = uci.sections('network', 'interface')
				.map(function(i) { return i['.name']; })
				.filter(function(n) { return /^wifi\d+$/.test(n); })
				.sort();

			return { groups: groups, ifaces: ifaces };
		}).then(function(res) {
			// LAN 接口候选：没有 br-lan 的机型（只有 eth0/eth1）必须能改，
			// 所以把系统里真实存在的接口列出来，别让用户猜。
			return fs.read('/proc/net/dev').then(function(txt) {
				var cands = String(txt || '').split('\n').slice(2).map(function(l) {
					return l.trim().split(':')[0];
				}).filter(function(n) { return n && n !== 'lo' && n !== 'dae0'; });
				res.netdevs = cands;
				return res;
			}).catch(function() { res.netdevs = []; return res; });
		});
	},

	render: function(data) {
		var m = new form.Map('honk_new', _('Honk'),
			_('eBPF 透明代理引擎。本页只写 UCI，' +
			  '真正的配置在重载时生成到 /etc/honk_new/config.dae。'));

		var s = m.section(form.NamedSection, 'config', 'honk_new');
		s.anonymous = true;

		s.tab('routing', _('路由设置'));
		s.tab('ssid', _('多SSID分流'));
		s.tab('dns', _('DNS'));
		s.tab('control', _('访问控制'));
		s.tab('diversion', _('分流控制'));


		var o = s.taboption('routing', form.Flag, 'enabled', _('启用 honk'));
		o.rmempty = false;

		// honk 的路由目标只能是 direct / block / 组，不存在「主节点」这个概念。
		// 这里列的是在「节点设置 → 分组」里定义好的组，选中哪个哪个就是主分组。
		o = s.taboption('routing', form.ListValue, 'main_group', _('主分组'));
		o.value('nil', _('禁用'));
		(data.groups || []).forEach(function(g) {
			o.value(g, g);
		});
		if ((data.groups || []).length === 0) {
			o.description = _('还没有定义任何分组。先去「节点设置 → 分组」建一个，' +
				'再到那张表里点「应用」把它设成主分组。');
		} else {
			o.description = _('选中的组承担所有代理流量。也可以在「节点设置 → 分组」里点「应用」直接切换。');
		}
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
		var sv = s.taboption('routing', form.SectionValue, '_infra', form.NamedSection, 'infra', 'honk_new');
		var ss = sv.subsection;

		// 直接列本机实际存在的接口，免得用户对着空白框猜。
		// 有些机型没有 br-lan 网桥，只有 eth0/eth1 这种裸网口，所以这一项必须能改。
		o = ss.option(form.ListValue, 'lan_interface', _('LAN 接口'),
			_('承载局域网转发流量的接口。留空则只代理路由器本机流量。'));
		o.value('', _('（不设置，只代理本机流量）'));
		(data.netdevs || []).forEach(function(n) { o.value(n, n); });
		// 当前值可能指向一个已经消失的接口（换了网卡配置、拔了 USB 网卡），
		// 不在列表里就补进去，否则下拉会显示空白、用户以为配置丢了。
		var curLan = uci.get('honk_new', 'infra', 'lan_interface');
		if (curLan && (data.netdevs || []).indexOf(curLan) < 0)
			o.value(curLan, curLan + _('（当前值，接口不存在）'));
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
		o.placeholder = '/var/lib/honk_new';
		o.rmempty = true;

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
									uci.sections('honk_new', 'ssid_route').forEach(function(x) {
										if (x.name) existing[x.name] = 1;
									});

									var added = 0;
									boxes.forEach(function(b) {
										if (!b.cb.checked)
											return;
										if (existing[b.ssid])
											return;

										var sid = uci.add('honk_new', 'ssid_route');
										uci.set('honk_new', sid, 'enabled', '1');
										uci.set('honk_new', sid, 'name', b.ssid);
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
			return uci.get('honk_new', section_id, 'name') || section_id;
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
		uci.sections('honk_new', 'dns_upstream').forEach(function(u) {
			if (u.name)
				o.value(u.name, u.name);
		});
		o.rmempty = true;

		/* ================= DNS ================= */

		var dnsv = s.taboption('dns', form.SectionValue, '_dns', form.NamedSection, 'infra', 'honk_new');
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
			var value = uci.get('honk_new', 'infra', role + '_dns');
			if (value !== undefined && value !== null) return value;
			// 只有字段完全不存在（旧安装）才回落到 dns_upstream section。
			// 新版本会写 'none' 占位，所以字段存在即代表用户已明确表过态。
			var old = uci.sections('honk_new', 'dns_upstream').filter(function(s) { return s.role === role && s.enabled === '1'; });
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
			select.write = function(id, value) { uci.set('honk_new', 'infra', key, value || 'none'); };
			var custom = ds.taboption('dns_servers', form.Value, key + '_custom', _('自定义 DNS URI'));
			custom.depends(key, 'custom'); custom.rmempty = false;
			custom.cfgvalue = function() {
				var v = dnsValue(role);
				return uci.get('honk_new', 'infra', key + '_custom') || (v && v !== 'custom' && !choices[v] ? v : '');
			};
			custom.write = function(id, value) { uci.set('honk_new', 'infra', key + '_custom', value); };
			// 正则里不要写转义的斜杠对：luci.mk 打包时的 minifier 会把它当成行注释，
  // 从那里一直截到行尾，产出的 panel.js 报 Invalid regular expression flags。
  // 用 [/][/] 表达同样的意思，minifier 不会误判。
  custom.validate = function(id, value) { return /^(udp|tcp|tls|https):[/][/]/.test(value) || _('请输入完整 DNS URI'); };
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
			  '支持本地文件，如 file:///etc/honk_new/adblock.list'));
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
				return fs.exec('/usr/share/honk_new/update-adblock.sh');
			}).then(function(res) {
				out.textContent = (res.stdout || '') + (res.stderr || '');
				return fs.read('/etc/honk_new/adblock.list').catch(function() { return ''; });
			}).then(function(txt) {
				var n = (txt || '').split('\n').filter(function(x) { return x.trim(); }).length;
				out.textContent += '\n\n当前列表：' + n + ' 条';
			}).catch(function(e) { out.textContent = String(e); });
		};

		/* 自定义广告域名：写文件，生成器按 40 个一组拆成 domain(suffix:) 规则 */
		o = ds.taboption('dns_advanced', form.TextValue, '_adblock_list', _('自定义广告域名'),
			_('一行一个域名，按后缀匹配，所以 example.com 也覆盖 a.example.com。' +
			  '存在 /etc/honk_new/adblock.list，与上面的 geosite 广告分类叠加生效。'));
		o.rows = 10;
		o.monospace = true;
		o.cfgvalue = function() {
			return fs.read('/etc/honk_new/adblock.list').catch(function() { return ''; });
		};
		o.write = function(section_id, value) {
			return fs.write('/etc/honk_new/adblock.list', String(value || ''));
		};
		o.remove = function() {
			return fs.write('/etc/honk_new/adblock.list', '');
		};
		o.placeholder = 'doubleclick.net\nads.example.com\ntracker.example.org';
		/* ================= 访问控制 ================= */

		var cv = s.taboption('control', form.SectionValue, '_control', form.NamedSection, 'control', 'honk_new');
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
			return uci.get('honk_new', section_id, 'name') || section_id;
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
			uci.set('honk_new', section_id, 'domains', list);
		};
		o.cfgvalue = function(section_id) {
			var v = uci.get('honk_new', section_id, 'domains');
			return Array.isArray(v) ? v.join('\n') : (v || '');
		};
		o.validate = function(section_id, value) {
			if (!value)
				return true;
			var bad = (value || '').split('\n').map(function(v) { return v.trim(); })
				.filter(function(v) { return v.length && !/^[A-Za-z0-9*._-]+$/.test(v); });
			return bad.length === 0 || _('域名无效：') + bad[0];
		};


		/* 自定义路由规则：整段替换 routing { } */
		/* 自定义路由规则 */
		o = s.taboption('diversion', form.Flag, 'custom_rules_enabled', _('启用自定义规则'),
			_('这会整段替换路由规则。开启后，多SSID分流、访问控制、分流控制、IPv6 模式、' +
			  '端口白名单和 QUIC 设置全部失效；兜底那条 fallback 也要你自己写。'));
		o.rmempty = false;

		o = s.taboption('diversion', form.TextValue, '_custom_rules', _('路由规则'),
			_('写 routing { } 的内部内容，dae 语法，一行一条规则。' +
			  '开关关闭时这里显示的是当前实际生效的规则，只读；开启后你写的内容会整段替换它们。' +
			  '内容存在 /etc/honk_new/custom.rules 里，不走 UCI。'));
		o.rows = 22;
		o.monospace = true;
		// 不隐藏：关掉开关时也要看得见现在跑的是什么，只是不能改
		o.cfgvalue = function() {
			return fs.read('/etc/honk_new/custom.rules').catch(function() { return ''; }).then(function(txt) {
				if ((txt || '').trim().length)
					return txt;

				// 没写过自定义规则，就把生成出来的 routing 块摊开给人看。
				// 这些是各路设置合出来的结果，不是用户输入的，所以只读展示。
				return fs.read('/etc/honk_new/config.dae').then(function(dae) {
					var m = String(dae || '').match(/^routing[ \t]*\{([\s\S]*?)^\}/m);
					if (!m) return '';
					return m[1].replace(/^[ \t]{4}/gm, '').replace(/^\n+/, '').replace(/[ \t]+$/, '');
				}).catch(function() { return ''; });
			});
		};
		o.renderWidget = function() {
			var w = form.TextValue.prototype.renderWidget.apply(this, arguments);
			var ta = w.querySelector('textarea');
			if (!ta) return w;

			var box = ta;
			while (box && box.tagName !== 'FORM') box = box.parentNode;
			var sync = function() {
				var on = uci.get('honk_new', 'config', 'custom_rules_enabled') === '1';
				ta.readOnly = !on;
				ta.style.background = on ? '' : '#f2f2f2';
				ta.style.color = on ? '' : '#666';
			};
			sync();
			// 开关就在同一张表单里，切一下 UCI 的待提交值立刻变，这里跟着同步
			if (box && !box.__honkCustomBound) {
				box.__honkCustomBound = true;
				box.addEventListener('change', function(ev) {
					if (ev.target && ev.target.getAttribute('name') === 'custom_rules_enabled')
						sync();
				});
			}
			return w;
		};
		o.write = function(section_id, value) {
			return fs.write('/etc/honk_new/custom.rules', String(value || ''));
		};
		o.remove = function() {
			return fs.write('/etc/honk_new/custom.rules', '');
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