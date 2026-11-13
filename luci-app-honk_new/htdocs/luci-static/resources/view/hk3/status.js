'use strict';
'require view';
'require form';
'require uci';
'require ui';
'require fs';
'require poll';
'require hk3';

/*
 * luci-app-honk_new · 服务状态
 *
 * 只读页：没有任何可保存的配置，只有连接测试、资源更新和日志。
 * 照 HomeProxy 的做法垂直堆叠独立卡片，每张卡片自带动作按钮。
 */
/* 让 DummyValue 的内容占满整行，否则表格被 30% 宽的标签列挤到右边 */
function fullRow(node) {
	var p = node;
	while (p && !(p.classList && p.classList.contains('cbi-value')))
		p = p.parentNode;
	if (p) {
		var t = p.querySelector('.cbi-value-title');
		if (t) t.style.display = 'none';
		var f = p.querySelector('.cbi-value-field');
		if (f) { f.style.marginLeft = '0'; f.style.width = '100%'; }
	}
	return node;
}

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

		// taboption 必须指向一个已经声明的 tab，否则直接抛异常、整页白屏。
		// 拆文件时这一段是从单页版搬过来的，但 tab 声明留在了 client.js。
		s.tab('status', _('运行状态'));

		/* ================= 仪表盘 ================= */

		var o = s.taboption('status', form.DummyValue, '_status_text', _('服务'));
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
		o.cfgvalue = function() { return hk3.renderConnection(); };

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
						return hk3.reload();
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
			return hk3.reload().then(function() {
				ui.addNotification(null, E('p', {}, _('已重新载入已保存的配置。未保存的表单请使用“保存并应用”。')), 'info');
			}).catch(function(e) { ui.addNotification(null, E('p', {}, e.message), 'error'); });
		};


		
		var applyStatus = hk3.renderApplyStatus();

		return m.render().then(function(el) {
			el.appendChild(applyStatus);
			hk3.mountStatusBanner(el);
			return el;
		});
	}
});