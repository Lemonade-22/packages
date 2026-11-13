'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require fs';
'require poll';
'require honk_new';

/*
 * luci-app-honk_new · 服务状态
 *
 * 只读页：没有任何可保存的配置，只有连接测试、资源更新和日志。
 * 照 HomeProxy 的做法垂直堆叠独立卡片，每张卡片自带动作按钮。
 */
return view.extend({
	load: function() {
		return Promise.all([
			uci.load('honk_new'),
			fs.exec('/usr/share/honk_new/log-tail.sh').then(function(r) { return r.stdout; }).catch(function() { return ''; })
		]).then(function(res) {
			return { log: res[1] || '' };
		});
	},

	render: function(data) {
		var m = new form.Map('honk_new', _('服务状态'),
			_('运行情况、连通性、规则资源和日志。这一页不写配置。'));

		var s = m.section(form.NamedSection, 'config', 'honk_new');
		s.anonymous = true;

		/* ================= 仪表盘 ================= */

		o = s.taboption('status', form.DummyValue, '_status_text', _('服务'));
		o.rawhtml = true;
		o.cfgvalue = function() {
			var enabled = uci.get('honk_new', 'config', 'enabled') === '1';
			return E('div', {}, [
				E('p', {}, enabled ? _('配置中已启用。') : _('配置中已禁用。')),
				E('p', { 'class': 'cbi-value-description' },
					_('honk 在重载时写出 /etc/honk_new/config.dae。要看实时流量、节点延迟' +
					  '和 DNS 统计，装 doona（原生 API）或 zashboard（Clash API）——' +
					  '两者都是 honk 项目提供的一键安装。'))
			]);
		};

		o = s.taboption('status', form.DummyValue, '_probe', _('连通性'));
		o.rawhtml = true;
		o.cfgvalue = function() { return honk_new.renderConnection(); };

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
					return fs.exec('/usr/share/honk_new/update-geo.sh').then(function(res) {
						out.textContent = (res.stdout || '') + (res.stderr || '');
						if (res.code !== 0) throw new Error(res.stderr || _('规则下载失败'));
						return honk_new.reload();
					}).then(function() {
						out.textContent += '\n\nhonk 已重载。';
					}).catch(function(e) { out.textContent = String(e); });
				})
			}, _('更新全部'));

			return Promise.all(files.map(function(item) {
				return fs.stat('/usr/share/honk_new/geo/' + item[0])
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
				return fs.exec('/usr/share/honk_new/log-tail.sh').then(function(res) {
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
				return fs.exec('/usr/share/honk_new/dash-status.sh').then(function(res) {
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
			return honk_new.reload().then(function() {
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

		
		/* 顶部运行状态条，照 HomeProxy 的做法：先判断有没有装、有没有在跑，
		   再决定文字和颜色。没装的时候提示去装，而不是空着。 */
		var _statusBanner = E('div', {
			'style': 'padding:8px 0;margin:0 0 10px;font-weight:600;font-size:14px;' +
			         'font-style:italic;color:#d9534f;border-bottom:1px solid #ddd;'
		}, _('正在读取 honk 状态…'));

		function refreshBanner() {
			return fs.exec('/usr/share/honk_new/honk-status.sh').then(function(res) {
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

		var applyStatus = honk_new.renderApplyStatus();
		refreshBanner();
		poll.add(refreshBanner, 10);

		return m.render().then(function(el) {
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
