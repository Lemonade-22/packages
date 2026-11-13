'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require fs';
'require poll';
'require hk3';

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
			hk3.nodes().catch(function() { return []; }),
			hk3.providers().catch(function() { return []; }),
			hk3.api('groups').catch(function() { return []; })
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

		// 照 HomeProxy 图11 的做法：每个订阅单独一个 tab。
		// tab 名优先用订阅名，没起名就用 URL 主机名，再不行用链接前 24 个字符。
		// 「节点」里再分一排 tab：手动节点 + 每个订阅。
		var subTabs = [];
		(data.providers || []).forEach(function(p) {
			if (p.kind === 'inline') return;   // 手动节点不重复列
			subTabs.push({ id: 'sub' + subTabs.length, label: subLabel(p, subTabs.length), tag: p.name || p.id });
		});

		s.tab('nodes', _('节点'));
		s.tab('groups', _('分组'));
		s.tab('subs', _('订阅'));

		/* ================= 节点 ================= */

		// 「节点」里面再分一排 tab：手动节点 + 每个订阅。
		// 用 SectionValue 的 subsection 声明，跟 DNS 那边（基础/DNS服务器/高级）同一个套路，
		// 是 LuCI 原生支持的嵌套 tab，不用自己画。
		var pane = s.taboption('nodes', form.SectionValue, '_nodepane', form.NamedSection, 'config', 'honk_new');
		var ns = pane.subsection;

		ns.tab('manual', _('手动节点'));
		subTabs.forEach(function(t) { ns.tab(t.id, t.label); });

		var nv = ns.taboption('manual', form.SectionValue, '_manual_nodes', form.GridSection, 'node', null);
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

		// 每个订阅的节点表，放在它自己的 tab 里
		subTabs.forEach(function(t) {
			var opt = ns.taboption(t.id, form.DummyValue, '_nodes_' + t.id, null);
			opt.rawhtml = true;
			opt.cfgvalue = function() { return renderProviderNodes(data, t.tag); };
		});

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

		// 成员要包含「当前生效的节点」，也就是内核实际解析出来的那些。
		// 只列手动节点是不够的：订阅节点的名字由内核在运行时决定，UCI 里没有，
		// 用户全是订阅节点时这个下拉会是空的，根本没法配组。
		// 成员要包含「当前生效的节点」，也就是内核实际解析出来的那些。
		// 只列手动节点是不够的：订阅节点的名字由内核在运行时决定，UCI 里没有，
		// 用户全是订阅节点时这个下拉会是空的，根本没法配组。
		//
		// 排序按「订阅 → 节点名升序」。DynamicList 不是原生 select，不支持
		// optgroup，所以组名写在选项文字前面，看的时候能一眼分开。
		o = groupsSec.option(form.DynamicList, 'members', _('成员'));

		var byTag = {};
		(data.runtime || []).forEach(function(rt) {
			if (rt.protocol === 'direct' || rt.protocol === 'block') return;
			if (!rt.name) return;
			var tg = rt.subscription_tag || '';
			(byTag[tg] = byTag[tg] || []).push(rt.name);
		});

		// 手动节点排最前，然后按订阅出现的顺序，每组内部按名称升序
		var order = [''];
		(data.providers || []).forEach(function(p) {
			if (p.kind === 'inline') return;
			var tg = p.name || p.id;
			if (order.indexOf(tg) < 0) order.push(tg);
		});
		// 兜底：运行时里有、但 providers 没列出来的 tag
		Object.keys(byTag).forEach(function(tg) {
			if (order.indexOf(tg) < 0) order.push(tg);
		});

		order.forEach(function(tg) {
			var names = (byTag[tg] || []).slice().sort(function(a, b) {
				return String(a).localeCompare(String(b), 'zh-Hans-CN');
			});
			names.forEach(function(nm) {
				o.value(nm, tg ? (tg + ' / ' + nm) : (_('手动') + ' / ' + nm));
			});
		});

		(data.groups || []).forEach(function(g) { o.value(g, _('[组] ') + g); });
		o.rmempty = true;
		o.description = _('选节点或别的组。留空表示这个组暂时不含任何成员（不会自动包含全部节点）。');

		o = groupsSec.option(form.DynamicList, 'providers', _('订阅成员'));
		uci.sections('honk_new', 'subscription').filter(function(x) { return x.enabled === '1'; }).forEach(function(x) {
			var tag = x.tag || x.name || x['.name'];
			o.value(tag, tag);
		});
		o.description = _('自动包含选中订阅的节点。成员和订阅成员均留空时，组包含全部节点。');
		o.rmempty = true;

		// 机场常在订阅里塞「剩余流量」「套餐到期」这类占位节点，连接参数是真的
		// 但连不上，自动选优会挑到它们。这里按节点名过滤。
		o = groupsSec.option(form.ListValue, 'filter_nodes', _('过滤节点'));
		o.value('disabled', _('不过滤'));
		o.value('blacklist', _('黑名单：丢弃命中关键词的'));
		o.value('whitelist', _('白名单：只保留命中关键词的'));
		o.default = 'blacklist';
		o.rmempty = false;

		o = groupsSec.option(form.DynamicList, 'filter_keywords', _('过滤关键词'));
		o.placeholder = '剩余流量';
		o.description = _('按节点名做子串匹配，不区分大小写。白名单模式下只留命中的节点，' +
			'黑名单模式下丢弃命中的节点。留空等于不过滤。');
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
		o.cfgvalue = function() { return hk3.renderPicking(); };

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

		// 机场按 UA 返回不同格式。留空就用 honk 自己的 honk/<版本>；
		// 兼容面最广的是 clash.meta —— 出 Clash YAML 的机场基本都认它。
		o = subsSec.option(form.ListValue, 'user_agent', _('订阅 User-Agent'));
		o.value('', _('默认（honk/<版本>）'));
		o.value('clash.meta', 'clash.meta');
		o.value('mihomo', 'mihomo');
		o.value('clash', 'clash');
		o.value('sing-box', 'sing-box');
		o.value('v2rayN', 'v2rayN');
		o.value('v2rayNG', 'v2rayNG');
		o.value('Shadowrocket', 'Shadowrocket');
		o.value('QuantumultX', 'Quantumult X');
		o.value('Surge', 'Surge');
		o.value('Stash', 'Stash');
		o.value('custom', _('— 自定义 —'));
		o.rmempty = true;
		o.description = _('机场按 UA 决定返回哪种格式。不确定就用默认，或者选 clash.meta —— ' +
			'支持 Clash YAML 的机场都认它。');

		o = subsSec.option(form.Value, 'user_agent_custom', _('自定义 User-Agent'));
		o.depends('user_agent', 'custom');
		o.placeholder = 'clash.meta';
		o.rmempty = true;

		o = s.taboption('subs', form.DummyValue, '_providers', _('已生效订阅'));
		o.rawhtml = true;
		o.cfgvalue = function() { return hk3.renderProviders(); };

		return m.render().then(function(el) {
			hk3.mountStatusBanner(el);

			// fullRow 在 cfgvalue 里执行时元素还没进 DOM，往上找不到 .cbi-value，
			// 宽度那一步只能等渲染完再做。不设的话表格被 <output> 固定成 400px，
			// 右边留一大片空白。
			Array.prototype.forEach.call(el.querySelectorAll('.cbi-value > output'), function(out) {
				out.style.flex = '1 1 auto';
				out.style.width = '100%';
				out.style.minWidth = '0';
			});

			// m.render() 只生成表单本身，主题的 .cbi-page-actions 是在这之后
			// 才挂上去的，所以这里立刻找是找不到的，得等一帧。
			window.setTimeout(function() { mountTestAll(el); }, 0);
			return el;
		});
	}
});

/*
 * 让一个 DummyValue 的内容占满整行。
 * LuCI 的 .cbi-value 是两列布局（标签 30% / 内容 70%），表格塞在右列里会
 * 明显缩进，跟上面 GridSection 的表头对不齐。这里把标签列藏掉、内容列拉满。
 */
function fullRow(node) {
	node.style.width = '100%';

	// 往上找到 .cbi-value 那一行，把标签列收掉、内容列拉满。
	// 内容是 DummyValue 渲染出来的，它落在 <output> 里，而不是 .cbi-value-field，
	// 所以不能只处理那一个 class —— 得把它下面的直接子元素都铺开。
	var row = node;
	while (row && !(row.classList && row.classList.contains('cbi-value')))
		row = row.parentNode;

	if (row) {
		var title = row.querySelector('.cbi-value-title');
		if (title) title.style.display = 'none';

		Array.prototype.forEach.call(row.children, function(child) {
			if (child === title) return;
			child.style.width = '100%';
			child.style.marginLeft = '0';
			child.style.flex = '1 1 auto';
			child.style.minWidth = '0';
		});
	}
	return node;
}

/*
 * 页面底部左侧的「测试所有节点」，测的是当前显示的那个列表 ——
 * 在「手动节点」下就测手动的，在「V6B」下就测 V6B 的。
 *
 * 串行而不并发：71 个节点同时探，路由器的 conntrack 和出口会被打满，
 * 结果全变超时，反而看不出哪个节点是好的。
 */
function mountTestAll(el) {
	// .cbi-page-actions 不在 #cbi-honk_new 里面，是主题在 map 外面单独放的，
	// 所以不能从 el 往下找。
	var actions = document.querySelector('.cbi-page-actions');
	if (!actions) {
		// 主题可能还没把按钮区挂上，再等一轮
		window.setTimeout(function() { mountTestAll(el); }, 200);
		return;
	}

	// 固定宽度：进度文字比标题短，不固定的话旁边「保存」「重置」会跟着左右跳。
	var btn = E('button', {
		'class': 'btn cbi-button',
		'style': 'margin-right:8px;min-width:9.5em;text-align:center;' +
		         'font-variant-numeric:tabular-nums'
	}, _('测试所有节点'));

	var running = false;

	btn.addEventListener('click', function(ev) {
		ev.preventDefault();
		if (running) return;

		// 只取当前可见的那个列表里的测试按钮
		var panes = Array.prototype.slice.call(el.querySelectorAll('[id^="cbi-honk_new-config-_nodes_"]'));
		var pane = panes.filter(function(p) { return p.offsetParent !== null; })[0];
		if (!pane) return;

		var probes = Array.prototype.slice.call(pane.querySelectorAll('button.honk-probe'));
		if (!probes.length) return;

		running = true;
		var i = 0;
		var label = btn.textContent;

		btn.disabled = true;
		btn.textContent = _('测试中 0/') + probes.length;

		function step() {
			if (i >= probes.length) {
				running = false;
				btn.disabled = false;
				btn.textContent = label;
				return;
			}
			btn.textContent = _('测试中 ') + (i + 1) + '/' + probes.length;

			// 单行按钮自己知道怎么测，这里只管按顺序点，等它把结果写回单元格
			var cell = probes[i].parentNode.previousSibling;
			var before = cell ? cell.textContent : '';
			probes[i].click();
			i++;

			var waited = 0;
			(function poll() {
				var now = cell ? cell.textContent : '';
				// 单元格离开「测试中…」就算有结果了；最多等 12 秒
				if ((now !== before && now.indexOf(_('测试中')) < 0) || waited > 60) {
					step();
				} else {
					waited++;
					setTimeout(poll, 200);
				}
			})();
		}

		step();
	});

	actions.insertBefore(btn, actions.firstChild);
}

/*
 * 点表头排序。没测过的节点永远排在最后——不管是升序还是降序，
 * 把「未测」当成最小延迟混在第一名里毫无意义。
 */
function bindSort(table) {
	var LAT = function(v) { return v === 'Infinity' ? Infinity : parseFloat(v); };

	Array.prototype.forEach.call(table.querySelectorAll('th[data-sortkey]'), function(th) {
		var key = th.getAttribute('data-sortkey');
		var arrow = th.querySelector('.honk-sort-arrow');

		th.addEventListener('click', function(ev) {
			ev.preventDefault();
			var dir = arrow.getAttribute('data-dir') === 'asc' ? 'desc' : 'asc';

			Array.prototype.forEach.call(table.querySelectorAll('.honk-sort-arrow'), function(a) {
				a.setAttribute('data-dir', '');
				a.textContent = '⇅';
			});
			arrow.setAttribute('data-dir', dir);
			arrow.textContent = dir === 'asc' ? '▲' : '▼';

			var rows = Array.prototype.slice.call(table.querySelectorAll('tr')).filter(function(tr) {
				return tr.hasAttribute('data-' + key);
			});

			rows.sort(function(a, b) {
				if (key === 'latency') {
					var la = LAT(a.getAttribute('data-latency'));
					var lb = LAT(b.getAttribute('data-latency'));
					if (la === lb) return 0;
					if (la === Infinity) return 1;      // 未测的沉底
					if (lb === Infinity) return -1;
					return (la - lb) * (dir === 'asc' ? 1 : -1);
				}
				var c = String(a.getAttribute('data-' + key))
					.localeCompare(String(b.getAttribute('data-' + key)), 'zh-Hans-CN');
				return c * (dir === 'asc' ? 1 : -1);
			});

			// 已经排好序，按顺序重新 append 即可——append 会移动节点，不会复制
			rows.forEach(function(tr) { tr.parentNode.appendChild(tr); });
		});
	});
}

/*
 * 订阅 tab 的标题：优先订阅名，其次 URL 主机名，最后截断链接本身。
 * 机场经常不起名，那就用主机名区分——dasho.pqjc.site 比"订阅 2"有用得多。
 */
function subLabel(p, i) {
	var name = (p.name || '').trim();
	if (name && name !== 'inline') return name;
	var u = String(p.url_redacted || p.url || '');
	var m = u.match(/^[a-z]+:\/\/([^/?#]+)/i);
	if (m && m[1]) return m[1];
	if (u) return u.slice(0, 24);
	return _('订阅 ') + (i + 1);
}

/* 某个订阅的节点表：名称 / 延迟 / 测试 / 类型 / 地址，照 HomeProxy 的列 */
function renderProviderNodes(data, tag) {
	var rows = (data.runtime || []).filter(function(n) {
		if (n.protocol === 'direct' || n.protocol === 'block') return false;
		// 没有 tag 时给空订阅显示全部，有 tag 就只显示这个订阅的
		return !tag || n.subscription_tag === tag;
	});

	// 只有两列有意义：延迟和测试。类型/地址/订阅在单订阅 tab 里是冗余的，
	// 但保留「类型」方便一眼看出协议，其余两列去掉。
	// separate + spacing 0：让边框长在单元格自己身上，sticky 表头才不会丢边框。
	// 用 collapse 的话边框归 table，一旦 th 提升成 sticky 就看不见了。
	var table = E('table', { 'class': 'table',
		'style': 'width:100%;border-collapse:separate;border-spacing:0' },
		E('tr', { 'class': 'tr table-titles' },
			[{ t: _('名称'), k: 'name' }, { t: _('延迟'), k: 'latency' },
			 { t: _('测试'), k: null }, { t: _('类型'), k: 'type' }].map(function(col) {
				// 表头吸顶：往下滚时它得钉住，否则会跟着内容走、看着像错位到数据行中间。
				//
				// 边框用真实 border，不用 box-shadow 补。collapse 模式下边框归 table
				// 所有，提升成 sticky 的 th 借不到自己那一条，滚动时整行变空白 ——
				// 阴影只是把症状盖住。表格已改成 separate + border-spacing 0，
				// 边框重新长在 th 身上，sticky 时自然跟着走。
				var st = 'position:sticky;top:0;z-index:2;' +
					'background:var(--background-color-high,#fff);' +
					'border-bottom:1px solid rgba(0,0,0,.14);' +
					'border-top:1px solid rgba(0,0,0,.14);';
				if (col.k) st += 'cursor:pointer;user-select:none;white-space:nowrap';

				if (col.k === 'latency') st += ';width:110px';
				var th = E('th', { 'class': 'th', 'style': st }, col.t);
				if (col.k) {
					th.setAttribute('data-sortkey', col.k);
					th.appendChild(E('span', {
						'class': 'honk-sort-arrow',
						'data-dir': '',
						'style': 'margin-left:6px;color:#999;font-size:11px'
					}, '⇅'));
				}
				return th;
			})));

	if (!rows.length) {
		table.appendChild(E('tr', { 'class': 'tr' },
			E('td', { 'class': 'td', 'colspan': 4, 'style': 'color:#888' },
				_('这个订阅还没有解析出节点。点「订阅」页的刷新，失败原因会显示在那里。'))));
		return E('div', {}, table);
	}

	rows.slice(0, 200).forEach(function(n) {
		// 固定宽度：单元格内容在「未测 / 测试中… / 223 ms」之间切换，
		// 自适应宽度会让整列跟着一抽一抽。
		var cell = E('td', { 'class': 'td', 'style': 'width:110px;font-variant-numeric:tabular-nums' }, _('未测'));
		var btn = E('button', { 'class': 'btn honk-probe', 'style': 'padding:1px 8px;font-size:12px',
			'data-node': n.id }, _('测试'));
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

			hk3.api('probe', JSON.stringify({ node_id: n.id, timeout_ms: 6000 }))
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

		var tr = E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td' }, n.name || n.id),
			cell,
			E('td', { 'class': 'td' }, btn),
			E('td', { 'class': 'td' }, n.protocol || '-')
		]);
		// 排序用的原始值。延迟用数字，没测过的记成 Infinity 好让它排最后。
		tr.setAttribute('data-name', n.name || n.id);
		tr.setAttribute('data-type', n.protocol || '');
		tr.setAttribute('data-latency',
			(h && typeof h.latency_ms === 'number') ? String(Math.round(h.latency_ms)) : 'Infinity');
		table.appendChild(tr);
	});

	bindSort(table);
	return fullRow(E('div', { 'style': 'width:100%;max-height:32em;overflow:auto;position:relative' }, table));
}