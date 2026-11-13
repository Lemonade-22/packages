'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require fs';
'require poll';
'require hk3';

/*
 * luci-app-honk · 节点设置
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
			uci.load('honk'),
			hk3.nodes().catch(function(e) { return { error: e.message || String(e) }; }),
			hk3.providers().catch(function(e) { return { error: e.message || String(e) }; }),
			hk3.api('groups').catch(function(e) { return { error: e.message || String(e) }; })
		]).then(function(res) {
			var manual = uci.sections('honk', 'node').filter(function(n) {
				return !n.subscription && (n.uri || '').length > 0;
			}).map(function(n) {
				return { id: n['.name'], name: n.name || n['.name'], uri: n.uri, enabled: n.enabled };
			});

			var groups = uci.sections('honk', 'group').map(function(g) {
				return (g.name || g['.name'] || '').trim();
			}).filter(function(n) { return n.length > 0; });

			return {
				manual: manual,
				runtime: Array.isArray(res[1]) ? res[1] : [],
				providers: Array.isArray(res[2]) ? res[2] : [],
				running: Array.isArray(res[3]) ? res[3] : [],
				loadErrors: [res[1], res[2], res[3]]
			.filter(function(x) { return x && x.error; })
			.map(function(x) { return x.error; })
			.filter(function(e, i, a) { return a.indexOf(e) === i; }),
		// 内核没运行时三个请求都会撞同一个连接失败，那不是"数据读错了"。
		// 状态横幅已经写了未运行，界面不该再刷三条红字。
		offline: [res[1], res[2], res[3]].some(function(x) {
			return x && x.error && /Failed to connect|Connection refused|:9527/i.test(x.error);
		}),
				groups: groups,
				main: (uci.get('honk', 'config', 'main_group') || '').trim()
			};
		});
	},

	render: function(data) {
		var m = new form.Map('honk', _('节点设置'),
			_('手动节点、分组定义与订阅。节点由内核解析，这里只负责把选择写进 UCI。'));

		var s = m.section(form.NamedSection, 'config', 'honk');
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
		var pane = s.taboption('nodes', form.SectionValue, '_nodepane', form.NamedSection, 'config', 'honk');
		var ns = pane.subsection;

		ns.tab('manual', _('手动节点'));
		subTabs.forEach(function(t) { ns.tab(t.id, t.label); });

		var nv = ns.taboption('manual', form.SectionValue, '_manual_nodes', form.GridSection, 'node', null);
		var nodesSec = nv.subsection;
		nodesSec.addremove = true;
		nodesSec.sortable = true;
		nodesSec.anonymous = true;
		nodesSec.sectiontitle = function(section_id) {
			return uci.get('honk', section_id, 'name') || section_id;
		};
		// 订阅节点由内核拉取，不进这张表
		nodesSec.filter = function(section_id) {
			return !uci.get('honk', section_id, 'subscription');
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
								uci.sections('honk', 'node').forEach(function(n) { if (n.name) used[n.name] = 1; });

								var added = 0, idx = 0;
								links.forEach(function(link) {
									var name = '', h = link.indexOf('#');
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
	// 表里塞太多列就挤成一团，说明行还会把表撑高一倍。
	// 只留组名/策略/成员，其余进编辑弹窗。
	groupsSec.nodescriptions = true;
		groupsSec.sortable = true;
		groupsSec.anonymous = true;
		groupsSec.sectiontitle = function(section_id) {
			return uci.get('honk', section_id, 'name') || section_id;
		};
		// 正确的钩子是 renderRowActions(section_id, more_label, trEl)：
		// GridSection 拼行时调它取「操作」那一格，再 append 到 tr 上。
		// 之前覆盖的 renderRow 根本不存在，所以「应用」按钮一直没出现过。
		groupsSec.renderRowActions = function(section_id) {
			var td = form.GridSection.prototype.renderRowActions.apply(this, arguments);
			var name = (uci.get('honk', section_id, 'name') || '').trim();
			if (!name || !td) return td;

			// 「应用」= 把这个组设成主分组。honk 没有单一主节点，路由目标是组。
			var actionBtn = E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'style': 'padding:2px 10px;font-size:12px;margin-right:4px;'
			}, (data.main === name) ? _('已应用') : _('应用'));

			// E() 传 'click' 在这个 LuCI 版本里不生效，必须 addEventListener
			actionBtn.addEventListener('click', function(ev) {
					ev.preventDefault();
					uci.set('honk', 'config', 'main_group', name);
					return uci.save().then(function() {
						ui.addNotification(null, E('p', {}, _('主分组已设为 %s，保存并应用后生效。').format(name)), 'info');
				actionBtn.textContent = _('已应用');
				actionBtn.disabled = true;
			}).catch(function(e) {
				ui.addNotification(null, E('p', {}, e.message), 'error');
			});
		});

			var host = td.querySelector('div') || td;
			host.insertBefore(actionBtn, host.firstChild);
			return td;
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
    o.modalonly = true;
		uci.sections('honk', 'subscription').filter(function(x) { return x.enabled === '1'; }).forEach(function(x) {
			var tag = x.tag || x.name || x['.name'];
			o.value(tag, tag);
		});
		o.description = _('自动包含选中订阅的节点。成员和订阅成员均留空时，组包含全部节点。');
		o.rmempty = true;

		// 机场常在订阅里塞「剩余流量」「套餐到期」这类占位节点，连接参数是真的
		// 但连不上，自动选优会挑到它们。这里按节点名过滤。
		o = groupsSec.option(form.ListValue, 'filter_nodes', _('过滤节点'));
    o.modalonly = true;
		o.value('disabled', _('不过滤'));
		o.value('blacklist', _('黑名单：丢弃命中关键词的'));
		o.value('whitelist', _('白名单：只保留命中关键词的'));
		o.default = 'blacklist';
		o.rmempty = false;

		o = groupsSec.option(form.DynamicList, 'filter_keywords', _('过滤关键词'));
    o.modalonly = true;
		o.placeholder = '剩余流量';
		o.description = _('按节点名做子串匹配，不区分大小写。白名单模式下只留命中的节点，' +
			'黑名单模式下丢弃命中的节点。留空等于不过滤。');
		o.rmempty = true;

		o = groupsSec.option(form.Value, 'check_url', _('健康检查地址'));
    o.modalonly = true;
		o.placeholder = 'http://1.1.1.1';
		o.description = _('用 IP 而不是域名。用域名会陷入「探测要解析、解析要代理、代理要评分」的死锁。');
		o.rmempty = true;

		o = groupsSec.option(form.Value, 'tolerance', _('切换容忍（毫秒）'));
    o.modalonly = true;
		o.datatype = 'uinteger';
		o.placeholder = '50';
		o.rmempty = true;

		o = groupsSec.option(form.ListValue, 'final', _('兜底'));
    o.modalonly = true;
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
	// 同上：表格只留 启用/名称/地址，标识/间隔/UA 都在编辑弹窗里改
	subsSec.nodescriptions = true;
		subsSec.sortable = true;
		subsSec.anonymous = true;
		subsSec.sectiontitle = function(section_id) {
			return uci.get('honk', section_id, 'name') || section_id;
		};

		// 内核按 tag（留空就用名称）给订阅起名字，这里按同一个键找回 provider id。
		subsSec.renderRowActions = function(section_id) {
			var td = form.GridSection.prototype.renderRowActions.apply(this, arguments);
			var tag = (uci.get('honk', section_id, 'tag') || '').trim();
			var name = (uci.get('honk', section_id, 'name') || '').trim();
			var key = tag || name;
			if (!key || !td) return td;

			var actionBtn = E('button', {
				'class': 'btn cbi-button',
				'style': 'padding:2px 10px;font-size:12px;margin-right:4px;'
			}, _('更新'));

			actionBtn.addEventListener('click', function(ev) {
					ev.preventDefault();
					if (actionBtn.disabled) return;
					actionBtn.disabled = true;
					actionBtn.textContent = _('更新中…');
					hk3.providers().then(function(list) {
						var hit = (list || []).filter(function(p) {
							return p.kind !== 'inline' && (p.name === key || p.id === key);
						})[0];
						if (!hit) throw new Error(_('内核里还没有这条订阅，先点「保存并应用」'));
						return hk3.api('provider-refresh', hit.id).then(hk3.waitOperation);
					}).then(function() {
						ui.addNotification(null, E('p', {}, _('订阅已更新：') + key), 'info');
						actionBtn.textContent = _('已更新');
					}).catch(function(e) {
						ui.addNotification(null, E('p', {}, _('更新失败：') + hk3.describeError(e)), 'error');
						actionBtn.disabled = false;
				actionBtn.textContent = _('更新');
			});
		});

			var host = td.querySelector('div') || td;
			host.insertBefore(actionBtn, host.firstChild);
			return td;
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
    o.modalonly = true;
		o.placeholder = 'sub';
		o.description = _('组里用「订阅成员」引用这个名字。留空则用名称。');
		o.rmempty = true;

		o = subsSec.option(form.Value, 'interval', _('自动更新间隔（秒）'));
    o.modalonly = true;
		o.datatype = 'uinteger';
		o.default = '86400';
		o.description = _('机场换节点不会等一天。更新完要点「保存并应用」才会真正重载。');

		// 机场按 UA 返回不同格式。留空就用 honk 自己的 honk/<版本>；
		// 兼容面最广的是 clash.meta —— 出 Clash YAML 的机场基本都认它。
		o = subsSec.option(form.ListValue, 'user_agent', _('订阅 User-Agent'));
    o.modalonly = true;
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
    o.modalonly = true;
		o.depends('user_agent', 'custom');
		o.placeholder = 'clash.meta';
		o.rmempty = true;

		o = s.taboption('subs', form.DummyValue, '_providers', _('已生效订阅'));
		o.rawhtml = true;
		o.cfgvalue = function() { return hk3.renderProviders(); };

		return m.render().then(function(el) {
			hk3.mountStatusBanner(el);
			hk3.layoutFullRows(el);
			if (data.loadErrors.length && !data.offline)
				ui.addNotification(null, E('p', {}, _('运行时数据读取失败：') + data.loadErrors.join('; ')), 'error');

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
			window.setTimeout(function() { mountPageActions(el); }, 0);
			return el;
		});
	}
});

/*
 * 让一个 DummyValue 的内容占满整行。
 * LuCI 的 .cbi-value 是两列布局（标签 30% / 内容 70%），表格塞在右列里会
 * 明显缩进，跟上面 GridSection 的表头对不齐。这里把标签列藏掉、内容列拉满。
 */

/*
 * 页面底部左侧的「测试所有节点」，测的是当前显示的那个列表 ——
 * 在「手动节点」下就测手动的，在「V6B」下就测 V6B 的。
 *
 * 串行而不并发：71 个节点同时探，路由器的 conntrack 和出口会被打满，
 * 结果全变超时，反而看不出哪个节点是好的。
 */

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
 * 机场经常不起名，那就用主机名区分——sub.example.com 比"订阅 2"有用得多。
 */
/*
 * 页面底部操作区里的「测试所有节点」，测当前显示的那个列表 ——
 * 在「手动节点」下就测手动的，在某个订阅下就测那个订阅的。
 *
 * 串行不并发：几十个节点一起探会把 conntrack 和出口打满，全变超时。
 * 靠每行按钮自己挂的 runProbe() 串起来，不轮询文字。
 */
/*
 * 页面底部操作区里跟 tab 相关的按钮：
 *   「测试所有节点」只在「节点」页有用，
 *   「更新所有订阅」只在「订阅」页有用。
 *
 * .cbi-page-actions 在 tab 面板外面（主题在 map 之后才挂上去的），
 * 所以既要从 document 找，也得自己跟着 tab 显隐。
 */
function mountPageActions(el) {
	var actions = document.querySelector('.cbi-page-actions');
	if (!actions) {
		// 主题还没把按钮区挂上，等一轮
		window.setTimeout(function() { mountPageActions(el); }, 200);
		return;
	}

	// 顶层 tab 是包含「节点」的那个 menu，二级 tab 里没有这两个字
	var topMenu = Array.prototype.slice.call(el.querySelectorAll('.cbi-tabmenu'))
		.filter(function(ul) {
			return Array.prototype.some.call(ul.querySelectorAll('li a'), function(a) {
				return a.textContent.trim() === _('节点');
			});
		})[0];

	function activeTab() {
		if (!topMenu) return '';
		var a = topMenu.querySelector('li.cbi-tab a');
		return a ? a.textContent.trim() : '';
	}

	/* ---- 测试所有节点 ---- */
	if (!actions.querySelector('.honk-test-all')) {
		// 固定宽度：进度文字比标题短，不固定的话旁边按钮会跟着左右跳
		var testBtn = E('button', {
			'class': 'btn cbi-button honk-test-all',
			'style': 'margin-right:8px;min-width:9.5em;text-align:center;font-variant-numeric:tabular-nums'
		}, _('测试所有节点'));

		var testLabel = testBtn.textContent;
		testBtn.addEventListener('click', function(ev) {
			ev.preventDefault();
			if (testBtn.disabled) return;

			// 只取当前可见的那个列表
			var panes = Array.prototype.slice.call(el.querySelectorAll('[id^="cbi-honk-config-_nodes_"]'));
			var pane = panes.filter(function(p) { return p.offsetParent !== null; })[0];
			if (!pane) return;

			var probes = Array.prototype.slice.call(pane.querySelectorAll('button.honk-probe'));
			if (!probes.length) return;

			var i = 0;
			testBtn.disabled = true;
			testBtn.textContent = _('测试中 0/') + probes.length;

			function next() {
				if (i >= probes.length) {
					testBtn.disabled = false;
					testBtn.textContent = testLabel;
					return;
				}
				testBtn.textContent = _('测试中 ') + (++i) + '/' + probes.length;
				// 每行按钮自己会探，这里串起来，等它完成再下一个
				Promise.resolve(probes[i - 1].runProbe()).then(next, next);
			}
			next();
		});

		actions.insertBefore(testBtn, actions.firstChild);
	}

	/* ---- 更新所有订阅 ---- */
	if (!actions.querySelector('.honk-update-all')) {
		var updBtn = E('button', {
			'class': 'btn cbi-button honk-update-all',
			'style': 'margin-right:8px;min-width:9.5em;text-align:center;font-variant-numeric:tabular-nums'
		}, _('更新所有订阅'));

		var updLabel = updBtn.textContent;
		updBtn.addEventListener('click', function(ev) {
			ev.preventDefault();
			if (updBtn.disabled) return;
			updBtn.disabled = true;
			updBtn.textContent = _('读取订阅…');

			hk3.providers().then(function(list) {
				// inline 是手动节点的虚拟 provider，刷新它是无意义的
				var subs = (list || []).filter(function(p) { return p.kind !== 'inline'; });
				if (!subs.length) throw new Error(_('内核里还没有任何订阅，先点「保存并应用」'));

				var i = 0;
				function next() {
					if (i >= subs.length) {
						updBtn.disabled = false;
						updBtn.textContent = updLabel;
						ui.addNotification(null, E('p', {}, _('订阅已全部更新')), 'info');
						return;
					}
					var p = subs[i++];
					updBtn.textContent = _('更新中 ') + i + '/' + subs.length;
					return hk3.api('provider-refresh', p.id).then(hk3.waitOperation).then(next, function(e) {
						// 一条失败不该拖住后面的
						ui.addNotification(null, E('p', {}, _('更新失败：') + (p.name || p.id) + ' — ' + hk3.describeError(e)), 'error');
						return next();
					});
				}
				return next();
			}).catch(function(e) {
				updBtn.disabled = false;
				updBtn.textContent = updLabel;
				ui.addNotification(null, E('p', {}, _('更新失败：') + hk3.describeError(e)), 'error');
			});
		});

		var testBtn2 = actions.querySelector('.honk-test-all');
		actions.insertBefore(updBtn, testBtn2 ? testBtn2.nextSibling : actions.firstChild);
	}

	/* ---- 跟着 tab 显隐 ---- */
	function syncVisibility() {
		var tab = activeTab();
		var testBtn = actions.querySelector('.honk-test-all');
		var updBtn = actions.querySelector('.honk-update-all');
		if (testBtn) testBtn.style.display = (tab === _('节点')) ? '' : 'none';
		if (updBtn) updBtn.style.display = (tab === _('订阅')) ? '' : 'none';
	}

	if (topMenu) {
		Array.prototype.forEach.call(topMenu.querySelectorAll('li a'), function(a) {
			a.addEventListener('click', function() {
				// LuCI 在点击里改 li 的 class，等它改完再读
				window.setTimeout(syncVisibility, 0);
			});
		});
	}

	syncVisibility();
}

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
	// 主题给 .table 设了 12px 圆角 + 上边框，这两样都在滚动容器里帮倒忙：
	// 圆角把四角的边框裁成透明，上边框画在 table 上、th 吸顶滚走后它留在原地，
	// 看起来就是「横线要滚到头才出现」。这里把 table 自己的框和圆角全清掉，
	// 边框只由单元格提供 —— separate 下每个 th/td 都能带自己的边框。
	var table = E('table', { 'class': 'table',
		'style': 'width:100%;border-collapse:separate;border-spacing:0;' +
		         'border:0;border-radius:0;background:transparent' },
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

	rows.forEach(function(n) {
		// 固定宽度：单元格内容在「未测 / 测试中… / 223 ms」之间切换，
		// 自适应宽度会让整列跟着一抽一抽。
		var cell = E('td', { 'class': 'td', 'style':
			'width:110px;font-variant-numeric:tabular-nums;' +
			'border-bottom:1px solid rgba(0,0,0,.08);padding:8px 10px' }, _('未测'));
		var btn = E('button', { 'class': 'btn cbi-button honk-probe',
			'data-node': n.id }, _('测试'));
		var addr = n.address || (n.server || '') + (n.port ? ':' + n.port : '');

		var h = hk3.health(n, 'tcp', 'ipv4');
		cell.textContent = h.label;
		cell.title = _('TCP / IPv4 数据探测');
		if (h.state === 'healthy') cell.style.color = 'green';
		else if (h.state === 'unavailable') cell.style.color = 'red';
		btn.runProbe = function() {
			if (btn.disabled) return Promise.resolve();
			btn.disabled = true; cell.textContent = _('测试中…'); cell.style.color = 'gray';
			return hk3.api('probe', JSON.stringify({ target: { type: 'node', node_id: n.id }, kind: 'http', transport: ['tcp'], ip_version: 'ipv4', warmth: 'cold' }))
				.then(hk3.waitOperation).then(function(result) {
					var sample = (result.results || [])[0];
					if (!sample) throw new Error(_('内核未返回测试结果'));
					var ok = sample.state === 'healthy' && typeof sample.latency_ms === 'number';
					cell.textContent = ok ? Math.round(sample.latency_ms) + ' ms' : (sample.state === 'unavailable' ? _('不可用') : _('未测'));
					cell.style.color = ok ? 'green' : 'red';
					cell.title = _('TCP / IPv4 HTTP 测试') + (sample.error ? ': ' + sample.error : '');
					tr.setAttribute('data-latency', ok ? String(sample.latency_ms) : 'Infinity');
				}).catch(function(e) { cell.textContent = _('测试失败'); cell.style.color = 'red'; cell.title = e.message || String(e); })
				.finally(function() { btn.disabled = false; });
		};
		btn.addEventListener('click', function(ev) { ev.preventDefault(); btn.runProbe(); });

		// separate 模式下每个单元格得自己带边框，不然行线全没了
		var TD = 'border-bottom:1px solid rgba(0,0,0,.08);padding:8px 10px';
		var tr = E('tr', { 'class': 'tr' }, [
			E('td', { 'class': 'td', 'style': TD }, n.name || n.id),
			cell,
			E('td', { 'class': 'td', 'style': TD }, btn),
			E('td', { 'class': 'td', 'style': TD }, n.protocol || '-')
		]);
		// 排序用的原始值。延迟用数字，没测过的记成 Infinity 好让它排最后。
		tr.setAttribute('data-name', n.name || n.id);
		tr.setAttribute('data-type', n.protocol || '');
		tr.setAttribute('data-latency',
			h.latency != null ? String(h.latency) : 'Infinity');
		table.appendChild(tr);
	});

	bindSort(table);
	// 批量测试按钮不放在这里，改挂在页面底部的操作区（见 mountTestAll），
	// 跟「保存并应用」「保存」「重置」排在一起。
	return hk3.fullRow(E('div', {}, [
		E('p', { 'style': 'margin:0 0 6px;color:#888' }, _('节点数：') + rows.length),
		E('div', { 'style': 'width:100%;max-height:32em;overflow:auto;position:relative' }, table)
	]));
}