'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require fs';
'require poll';
'require honk_new';

/*
 * luci-app-honk_new · 节点设置
 *
 * 三块：
 *   节点  —— 手动添加的分享链接，以及当前生效的节点（含延迟/测试）
 *   分组  —— honk 的路由目标只能是 direct/block/组，这里定义组并「应用」成主分组
 *   订阅  —— 订阅地址配置 + 内核实际加载的订阅状态
 *
 * 「应用」的含义是把这个组设成主分组（config.main_group），
 * 不沿用 HomeProxy 「把节点设为主节点」的概念 —— honk 没有单一主节点。
 */
return view.extend({
	load: function() {
		return Promise.all([
			uci.load('honk_new'),
			honk_new.nodes().catch(function() { return []; }),
			honk_new.providers().catch(function() { return []; }),
			honk_new.api('groups').catch(function() { return []; })
		]).then(function(res) {
			var manual = uci.sections('honk_new', 'node').filter(function(n) {
				return !n.subscription && (n.uri || '').length > 0;
			}).map(function(n) {
				return { id: n['.name'], name: n.name || n['.name'], uri: n.uri, enabled: n.enabled };
			});

			var groups = uci.sections('honk_new', 'group').map(function(g) {
				return (g.name || g['.name'] || '').trim();
			}).filter(function(n) { return n.length > 0; });

			return {
				manual: manual,
				runtime: res[1] || [],
				providers: res[2] || [],
				running: res[3] || [],
				groups: groups,
				main: (uci.get('honk_new', 'config', 'main_group') || '').trim()
			};
		});
	},

	render: function(data) {
		var m = new form.Map('honk_new', _('节点设置'),
			_('手动节点、分组定义与订阅。节点由内核解析，这里只负责把选择写进 UCI。'));

		var s = m.section(form.NamedSection, 'config', 'honk_new');
		s.anonymous = true;

		s.tab('nodes', _('节点'));
		s.tab('groups', _('分组'));
		s.tab('subs', _('订阅'));

		/* ================= 节点 ================= */

		var nv = s.taboption('nodes', form.SectionValue, '_manual_nodes', form.GridSection, 'node', _('手动节点'));
		var nodesSec = nv.subsection;
		nodesSec.addremove = true;
		nodesSec.sortable = true;
		nodesSec.anonymous = true;
		nodesSec.sectiontitle = function(section_id) {
			return uci.get('honk_new', section_id, 'name') || section_id;
		};
		// 订阅节点由内核拉取，不进这张表
		nodesSec.filter = function(section_id) {
			return !uci.get('honk_new', section_id, 'subscription');
		};

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
							E('button', { 'class': 'btn cbi-button-action', 'click': ui.createHandlerFn(this, function() {
								var links = String(ta.value || '').split('\n').map(function(x) { return x.trim(); })
									.filter(function(x) { return x.length > 0; });
								if (!links.length) return ui.hideModal();

								var used = {};
								uci.sections('honk_new', 'node').forEach(function(n) { if (n.name) used[n.name] = 1; });

								var added = 0, idx = 0;
								links.forEach(function(link) {
									var name = '', h = link.indexOf('#');
									if (h >= 0) {
										try { name = decodeURIComponent(link.slice(h + 1)); }
										catch (e) { name = link.slice(h + 1); }
									}
									name = name.replace(/[^\w.-]/g, '').slice(0, 24);
									if (!name) name = 'node';
									while (used[name]) name = name.replace(/\d+$/, '') + (++idx);
									used[name] = 1;

									var sid = uci.add('honk_new', 'node');
									uci.set('honk_new', sid, 'enabled', '1');
									uci.set('honk_new', sid, 'name', name);
									uci.set('honk_new', sid, 'uri', link);
									added++;
								});

								return uci.save()
									.then(L.bind(this.map.load, this.map))
									.then(L.bind(this.map.reset, this.map))
									.then(function() {
										ui.addNotification(null, E('p', {}, _('已导入 %d 个节点').format(added)));
										ui.hideModal();
									});
							})}, _('导入'))
						])
					]);
				})
			}, _('导入分享链接')));
			return el;
		};

		var o = nodesSec.option(form.Flag, 'enabled', _('启用'));
		o.default = '1';
		o.rmempty = false;

		o = nodesSec.option(form.Value, 'name', _('名称'));
		o.placeholder = 'hk01';
		o.rmempty = false;

		o = nodesSec.option(form.Value, 'uri', _('分享链接'));
		o.placeholder = 'vless://uuid@host:443?security=tls&sni=host#name';
		o.rmempty = false;

		/* 当前生效的节点（含订阅解析出来的）—— 只读，带延迟和测试 */
		o = s.taboption('nodes', form.DummyValue, '_runtime_nodes', _('当前节点'));
		o.rawhtml = true;
		o.cfgvalue = function() { return renderRuntimeNodes(data); };

		/* ================= 分组 ================= */

		var gv = s.taboption('groups', form.SectionValue, '_groups', form.GridSection, 'group', null);
		var groupsSec = gv.subsection;
		groupsSec.addremove = true;
		groupsSec.sortable = true;
		groupsSec.anonymous = true;
		groupsSec.sectiontitle = function(section_id) {
			return uci.get('honk_new', section_id, 'name') || section_id;
		};
		groupsSec.renderRow = function(section_id) {
			var tr = form.GridSection.prototype.renderRow.apply(this, arguments);
			var name = (uci.get('honk_new', section_id, 'name') || '').trim();
			if (!name) return tr;

			// 「应用」= 把这个组设成主分组。honk 没有单一主节点，路由目标是组。
			var td = E('td', { 'class': 'td cbi-section-actions' }, E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'style': 'padding:2px 10px;font-size:12px;',
				'click': ui.createHandlerFn(this, function(ev) {
					ev.preventDefault();
					uci.set('honk_new', 'config', 'main_group', name);
					return uci.save().then(function() {
						ui.addNotification(null, E('p', {}, _('主分组已设为 %s，保存并应用后生效。').format(name)), 'info');
						var cell = td.querySelector('button');
						if (cell) { cell.textContent = _('已应用'); cell.disabled = true; }
					}).catch(function(e) {
						ui.addNotification(null, E('p', {}, e.message), 'error');
					});
				})
			}, (data.main === name) ? _('已应用') : _('应用')));
			tr.appendChild(td);
			return tr;
		};

		o = groupsSec.option(form.Value, 'name', _('组名'));
		o.placeholder = 'proxy';
		o.validate = function(id, value) {
			return (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) && value !== 'direct' && value !== 'block')
				|| _('组名需使用字母、数字、下划线或连字符，不能使用 direct/block');
		};
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
		(data.manual || []).forEach(function(n) { o.value(n.name, n.name); });
		(data.groups || []).forEach(function(g) { o.value(g, _('[组] ') + g); });
		o.rmempty = true;

		o = groupsSec.option(form.DynamicList, 'providers', _('订阅成员'));
		uci.sections('honk_new', 'subscription').filter(function(x) { return x.enabled === '1'; }).forEach(function(x) {
			var tag = x.tag || x.name || x['.name'];
			o.value(tag, tag);
		});
		o.description = _('自动包含选中订阅的节点。成员和订阅成员均留空时，组包含全部节点。');
		o.rmempty = true;

		o = groupsSec.option(form.Value, 'check_url', _('健康检查地址'));
		o.placeholder = 'http://1.1.1.1';
		o.description = _('用 IP 而不是域名。用域名会陷入「探测要解析、解析要代理、代理要评分」的死锁。');
		o.rmempty = true;

		o = groupsSec.option(form.Value, 'tolerance', _('切换容忍（毫秒）'));
		o.datatype = 'uinteger';
		o.placeholder = '50';
		o.rmempty = true;

		o = groupsSec.option(form.ListValue, 'final', _('兜底'));
		o.value('direct', _('直连'));
		o.value('block', _('阻断'));
		(data.groups || []).forEach(function(g) { o.value(g, _('[组] ') + g); });
		o.default = 'block';
		o.rmempty = false;

		/* 运行中的分组状态 */
		o = s.taboption('groups', form.DummyValue, '_group_runtime', _('运行状态'));
		o.rawhtml = true;
		o.cfgvalue = function() { return honk_new.renderPicking(); };

		/* ================= 订阅 ================= */

		var subv = s.taboption('subs', form.SectionValue, '_subscriptions', form.GridSection, 'subscription', _('订阅配置'));
		var subsSec = subv.subsection;
		subsSec.addremove = true;
		subsSec.sortable = true;
		subsSec.anonymous = true;
		subsSec.sectiontitle = function(section_id) {
			return uci.get('honk_new', section_id, 'name') || section_id;
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
		o.description = _('支持链接列表、Base64、Clash YAML 和 JSON。解析交给内核，失败会显示原因。');

		o = subsSec.option(form.Value, 'tag', _('订阅标识'));
		o.placeholder = 'sub';
		o.description = _('组里用「订阅成员」引用这个名字。留空则用名称。');
		o.rmempty = true;

		o = subsSec.option(form.Value, 'interval', _('自动更新间隔（秒）'));
		o.datatype = 'uinteger';
		o.default = '86400';
		o.description = _('机场换节点不会等一天。更新完要点「保存并应用」才会真正重载。');

		o = subsSec.option(form.Value, 'user_agent', _('订阅 User-Agent'));
		o.rmempty = true;

		o = s.taboption('subs', form.DummyValue, '_providers', _('已生效订阅'));
		o.rawhtml = true;
		o.cfgvalue = function() { return honk_new.renderProviders(); };

		return m.render();
	}
});

/* 当前生效的节点表：名称 / 延迟 / 测试 / 类型 / 地址 / 端口，照 HomeProxy 的列 */
function renderRuntimeNodes(data) {
	var rows = (data.runtime || []).filter(function(n) { return n.protocol !== 'direct' && n.protocol !== 'block'; });

	var table = E('table', { 'class': 'table' },
		E('tr', { 'class': 'tr table-titles' },
			[_('名称'), _('延迟'), _('测试'), _('类型'), _('地址'), _('订阅')].map(function(t) {
				return E('th', { 'class': 'th' }, t);
			})));

	if (!rows.length) {
		table.appendChild(E('tr', { 'class': 'tr' },
			E('td', { 'class': 'td', 'colspan': 6, 'style': 'color:#888' }, _('还没有生效的节点。填好订阅并保存应用后这里会出现。'))));
		return E('div', {}, table);
	}

	rows.slice(0, 200).forEach(function(n) {
		var cell = E('td', { 'class': 'td' }, _('未测'));
		var btn = E('button', { 'class': 'btn', 'style': 'padding:1px 8px;font-size:12px' }, _('测试'));
		var addr = n.address || (n.server || '') + (n.port ? ':' + n.port : '');

		var h = (n.health || []).filter(function(x) { return x.purpose === 'data' && x.state === 'healthy'; })[0];
		if (h && typeof h.latency_ms === 'number') {
			cell.textContent = Math.round(h.latency_ms) + ' ms';
			cell.style.color = 'green';
		}

		btn.addEventListener('click', function(ev) {
			ev.preventDefault();
			if (btn.disabled) return;
			btn.disabled = true;
			cell.textContent = _('测试中…');
			cell.style.color = 'gray';

			honk_new.api('probe', JSON.stringify({ node_id: n.id, timeout_ms: 6000 }))
				.then(function(r) {
					var ms = r && (r.latency_ms != null ? r.latency_ms : (r.result && r.result.latency_ms));
					if (typeof ms === 'number') {
						cell.textContent = Math.round(ms) + ' ms';
						cell.style.color = 'green';
					} else {
						cell.textContent = _('失败');
						cell.style.color = 'red';
					}
				})
				.catch(function() {
					cell.textContent = _('失败');
					cell.style.color = 'red';
				})
				.finally(function() { btn.disabled = false; });
		});

		table.appendChild(E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td' }, n.name || n.id),
			cell,
			E('td', { 'class': 'td' }, btn),
			E('td', { 'class': 'td' }, n.protocol || '-'),
			E('td', { 'class': 'td', 'style': 'font-size:12px' }, addr),
			E('td', { 'class': 'td' }, n.subscription_tag || _('手动'))
		]));
	});

	return E('div', { 'style': 'max-height:32em;overflow:auto' }, table);
}