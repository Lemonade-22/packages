'use strict';
'require baseclass';
'require fs';
'require poll';
'require rpc';
'require ui';

var connectionCheck = rpc.declare({ object: 'luci.honk_new', method: 'connection_check', params: ['site'], expect: { '': {} } });

/* 只读动作走 honk-read.sh：ACL 把它放在 read 权限里，未登录或只读身份
   也能看状态，但不能刷新订阅、切换节点或重载配置。
   其余动作会改运行时状态，必须落在写权限的 honk-api.sh 上。 */
var READ_ACTIONS = { nodes: 1, providers: 1, groups: 1, group: 1, runtime: 1, config: 1, operation: 1 };

function api() {
	var args = Array.prototype.slice.call(arguments);
	var script = READ_ACTIONS[args[0]] ? '/usr/share/honk_new/honk-read.sh' : '/usr/share/honk_new/honk-api.sh';
	return fs.exec(script, args).then(function(res) {
		var body;
		try { body = JSON.parse(res.stdout || '{}'); }
		catch (e) { throw new Error(_('内核返回了无法识别的响应')); }
		if (res.code !== 0 || body.error)
			throw new Error((body.error && body.error.message) || (res.stderr || '').trim() || _('无法连接 honk'));
		return body;
	});
}
function page(kind, cursor, collected) {
	return api(kind, cursor || '').then(function(body) {
		var rows = (collected || []).concat(Array.isArray(body) ? body : (body[kind] || []));
		return body.next_cursor ? page(kind, body.next_cursor, rows) : rows;
	});
}
function waitOperation(accepted, timeout) {
	if (!accepted.operation_id) return Promise.reject(new Error(_('内核未返回操作编号')));
	var until = Date.now() + (timeout || 60000);
	function check() {
		return api('operation', accepted.operation_id).then(function(op) {
			if (op.status === 'succeeded') return op.result;
			if (op.status === 'failed') throw new Error((op.error || {}).message || _('操作失败'));
			if (Date.now() >= until) throw new Error(_('等待超时，内核操作可能仍在执行，请刷新状态后查看'));
			return new Promise(function(resolve) { window.setTimeout(resolve, 500); }).then(check);
		});
	}
	return check();
}
function health(node, transport, family) {
	var samples = (node.health || []).filter(function(h) {
		return h.transport === transport && h.ip_version === family && h.purpose === 'data';
	}).sort(function(a, b) { return String(b.observed_at || '').localeCompare(String(a.observed_at || '')); });
	var sample = samples[0];
	if (!sample || !sample.observed_at || sample.state === 'unknown') return { label: _('未测'), state: 'unknown', latency: null };
	var valid = sample.state === 'healthy' && typeof sample.latency_ms === 'number';
	return { label: valid ? Math.round(sample.latency_ms) + ' ms' : _('不可用'), state: valid ? 'healthy' : 'unavailable', latency: valid ? sample.latency_ms : null };
}
function renderConnection() {
	var sites = [['baidu', '百度', 'https://www.baidu.com/'], ['bilibili', '哔哩哔哩', 'https://www.bilibili.com/'], ['jd', '京东', 'https://www.jd.com/'], ['google', 'Google', 'https://www.google.com/'], ['github', 'GitHub', 'https://github.com/'], ['youtube', 'YouTube', 'https://www.youtube.com/']];
	var cells = {}, running = false, generation = 0;
	var table = E('table', { 'class': 'table' }, E('tr', { 'class': 'tr table-titles' }, [_('网站'), _('地址'), _('连通性'), _('TLS 延迟')].map(function(t) { return E('th', { 'class': 'th' }, t); })));
	sites.forEach(function(site) {
		var state = E('strong', {}, '-'), latency = E('span', {}, '-');
		cells[site[0]] = { state: state, latency: latency };
		table.appendChild(E('tr', { 'class': 'tr' }, [E('td', { 'class': 'td' }, site[1]), E('td', { 'class': 'td' }, E('a', { href: site[2], target: '_blank', rel: 'noreferrer noopener' }, site[2])), E('td', { 'class': 'td' }, state), E('td', { 'class': 'td' }, latency)]));
	});
	var button = E('button', { 'class': 'btn cbi-button-action', click: function(ev) {
		ev.preventDefault();
		if (running) return;
		running = true; button.disabled = true;
		var current = ++generation;
		Object.keys(cells).forEach(function(k) { cells[k].state.textContent = _('测试中…'); cells[k].state.style.color = 'gray'; cells[k].latency.textContent = '-'; });
		return new Promise(function(resolve) {
			var settled = false;
			function finish(result) { if (!settled) { settled = true; resolve(result); } }
			// 后端最长 16 秒。前端留一点余量，否则代理首包慢的时候
			// 后端还在等，界面已经报"超时"了，看起来像是测试坏了。
			var timer = window.setTimeout(function() { finish({ timed_out: true }); }, 18000);
			connectionCheck('all').then(function(r) { window.clearTimeout(timer); finish(r); }, function() { window.clearTimeout(timer); finish({ failed: true }); });
		}).then(function(result) {
			if (generation !== current) return;
			var rows = {};
			(result.results || []).forEach(function(r) { rows[r.site] = r; });
			Object.keys(cells).forEach(function(k) {
				var r = rows[k] || { timed_out: result.timed_out }, c = cells[k];
				c.state.textContent = r.result ? _('成功') : (r.timed_out ? _('超时') : _('失败'));
				c.state.style.color = r.result ? 'green' : 'red';
				c.latency.textContent = r.result ? r.latency_ms + ' ms' : '-';
			});
		}).finally(function() { if (generation === current) { running = false; button.disabled = false; } });
	} }, _('测试全部'));
	return E('div', {}, [E('div', { style: 'margin-bottom:8px' }, button), table]);
}


/*
 * 让 DummyValue 的内容占满整行。
 * LuCI 的 .cbi-value 是标签 30% / 内容 70% 的两列布局，表格塞在右列会明显
 * 缩进，跟上面的 GridSection 表头对不齐。这里藏掉标签列、内容列拉满。
 */
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

/* 已生效的原生订阅。honk 自己解析订阅，这里只展示内核的实际状态，
   不重复前端那套下载/解析逻辑。 */
function renderProviders() {
	var box = E('div', { style: 'line-height:1.8' }, _('正在读取已生效订阅…'));

	function check() {
		return page('providers').then(function(list) {
			box.innerHTML = '';

			if (!list.length) {
				box.appendChild(E('p', {}, _('当前没有已生效的原生订阅。' +
					'在表格里填好订阅地址并“保存并应用”之后，这里会显示内核实际加载的订阅。')));
				return;
			}

			var table = E('table', { class: 'table' },
				E('tr', { class: 'tr table-titles' },
					[_('名称'), _('类型'), _('节点数'), _('状态'), _('最近错误'), ''].map(function(t) {
						return E('th', { class: 'th' }, t);
					})));

			list.forEach(function(p) {
				var state = E('strong', {}, p.status || _('未知'));
				if (p.status === 'healthy' || p.status === 'ok')
					state.style.color = 'green';
				else if (p.status === 'failed' || p.status === 'error')
					state.style.color = 'red';

				var btn = E('button', { class: 'btn cbi-button-action' }, _('刷新'));
				btn.addEventListener('click', function(ev) {
					ev.preventDefault();
					if (btn.disabled) return;
					btn.disabled = true;
					btn.textContent = _('刷新中…');

					api('provider-refresh', p.id)
						.then(waitOperation)
						.then(function() { return check(); })
						.catch(function(e) {
							ui.addNotification(null, E('p', {}, _('刷新失败：') + e.message), 'error');
						})
						.finally(function() {
							btn.disabled = false;
							btn.textContent = _('刷新');
						});
				});

				table.appendChild(E('tr', { class: 'tr' }, [
					E('td', { class: 'td' }, p.name || p.id),
					E('td', { class: 'td' }, p.kind || '-'),
					E('td', { class: 'td' }, String(p.node_count != null ? p.node_count : '-')),
					E('td', { class: 'td' }, state),
					E('td', { class: 'td', style: 'word-break:break-all;color:#c00' }, p.last_error || ''),
					E('td', { class: 'td' }, btn)
				]));
			});

			box.appendChild(table);
		}).catch(function(e) {
			box.textContent = _('无法读取订阅状态：') + e.message;
		});
	}

	check();
	poll.add(check, 20);
	return fullRow(box);
}

/* 分组与当前选择。GET /groups 只给摘要，成员要单独读 /groups/{id}。 */
function renderPicking() {
	var box = E('div', {}, _('正在读取分组…'));

	function describe(member) {
		return (member.kind === 'group' ? _('[组] ') : '') + (member.name || member.id);
	}

	function detail(g) {
		var pane = E('div', { style: 'margin:6px 0 14px 12px;padding:8px 10px;border-left:3px solid #ddd' }, _('正在读取成员…'));

		function load() {
			return api('group', g.id).then(function(full) {
				pane.innerHTML = '';

				var members = (full.members || []);
				var sel = (full.runtime && full.runtime.selection) || {};
				var picked = {};
				['tcp_member_id', 'udp_member_id'].forEach(function(k) {
					if (sel[k]) picked[sel[k]] = 1;
				});

				var head = E('p', { style: 'margin:0 0 6px' }, [
					_('策略：'),
					E('strong', {}, (g.policy && g.policy.kind) || '-'),
					'   ',
					_('当前选择：')
				]);
				var names = members.filter(function(m) { return picked[m.id]; }).map(describe);
				head.appendChild(E('strong', {}, names.length ? names.join('、') : _('无（按策略自动）')));

				var clear = E('button', { class: 'btn', style: 'margin-left:10px' }, _('清除临时选择'));
				clear.addEventListener('click', function(ev) {
					ev.preventDefault();
					clear.disabled = true;
					api('clear-selection', g.id)
						.then(function() { return load(); })
						.catch(function(e) { ui.addNotification(null, E('p', {}, e.message), 'error'); })
						.finally(function() { clear.disabled = false; });
				});
				head.appendChild(clear);

				pane.appendChild(head);

				if (!members.length) {
					pane.appendChild(E('p', { style: 'margin:6px 0 0;color:#888' }, _('这个组没有直接成员。')));
					return;
				}

				var list = E('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-top:6px' });
				members.forEach(function(m) {
					var chip = E('button', {
						class: 'btn' + (picked[m.id] ? ' cbi-button-action' : ''),
						style: 'font-size:12px'
					}, describe(m));
					chip.addEventListener('click', function(ev) {
						ev.preventDefault();
						if (chip.disabled) return;
						chip.disabled = true;
						api('select', g.id, JSON.stringify({ member_id: m.id, network: 'both' }))
							.then(function() { return load(); })
							.catch(function(e) {
								ui.addNotification(null, E('p', {}, _('切换失败：') + e.message), 'error');
							})
							.finally(function() { chip.disabled = false; });
					});
					list.appendChild(chip);
				});
				pane.appendChild(list);
			}).catch(function(e) {
				pane.textContent = _('无法读取组详情：') + e.message;
			});
		}

		load();
		return pane;
	}

	function check() {
		return api('groups').then(function(groups) {
			box.innerHTML = '';

			if (!groups.length) {
				box.appendChild(E('p', {}, _('还没有定义任何分组。')));
				return;
			}

			groups.forEach(function(g) {
				var row = E('div', { style: 'margin-bottom:10px' }, [
					E('div', {}, [
						E('strong', {}, g.name || g.id),
						E('span', { style: 'color:#888;margin-left:10px' },
							_('成员 ') + (g.member_count != null ? g.member_count : '?') + _(' 个'))
					])
				]);
				row.appendChild(detail(g));
				box.appendChild(row);
			});
		}).catch(function(e) {
			box.textContent = _('无法读取分组：') + e.message;
		});
	}

	check();
	poll.add(check, 30);
	return fullRow(box);
}

/* 让内核重新加载已保存的配置。走原生 API，拿到 operation 才代表真的完成。 */
function reload() {
	return api('reload').then(function(accepted) {
		return waitOperation(accepted, 45000);
	});
}

/* 上一轮应用的结局。init 脚本把结果写进 /var/run/honk_new/。 */
function renderApplyStatus() {
	var box = E('div', { style: 'margin:10px 0;padding:8px 12px;border-radius:4px;' +
		'border:1px solid #ddd;font-size:13px;background:#fafafa' }, '');

	var TEXT = {
		starting: [_('启动中'), '#ff9900'],
		stopped: [_('已停止'), '#888'],
		generate_failed: [_('配置生成失败'), '#d9534f'],
		validation_failed: [_('配置校验未通过，已保留原配置'), '#d9534f'],
		reload_failed: [_('重载失败'), '#d9534f']
	};

	function check() {
		return Promise.all([
			fs.read('/var/run/honk_new/apply.json').catch(function() { return ''; }),
			fs.read('/var/run/honk_new/validation.json').catch(function() { return ''; })
		]).then(function(res) {
			var apply = null, validation = null;
			try { apply = JSON.parse(res[0] || 'null'); } catch (e) { apply = null; }
			try { validation = JSON.parse(res[1] || 'null'); } catch (e) { validation = null; }

			box.innerHTML = '';

			var label, color;
			if (!apply) {
				label = _('还没有应用记录');
				color = '#888';
			} else if (apply.status) {
				var t = TEXT[apply.status];
				label = t ? t[0] : apply.status;
				color = t ? t[1] : '#888';
			} else if (apply.operation_id || apply.state) {
				// reload 成功时 init 写的是原生 API 的返回体
				label = _('配置已生效');
				color = '#19be6b';
			} else {
				label = _('已应用');
				color = '#19be6b';
			}

			box.appendChild(E('span', { style: 'color:' + color + ';font-weight:600' }, label));

			// 校验失败时把内核给的原因贴出来，不要只显示"失败"
			if (validation && validation.valid === false) {
				var why = validation.errors || validation.diagnostics || validation;
				box.appendChild(E('pre', {
					style: 'margin:6px 0 0;white-space:pre-wrap;font-size:12px;color:#a00;max-height:12em;overflow:auto'
				}, typeof why === 'string' ? why : JSON.stringify(why, null, 1)));
			}
		}).catch(function(e) {
			box.textContent = _('无法读取应用状态：') + e.message;
		});
	}

	check();
	poll.add(check, 10);
	return box;
}

return baseclass.extend({ api: api, nodes: function() { return page('nodes'); }, providers: function() { return page('providers'); },
	waitOperation: waitOperation, health: health, renderConnection: renderConnection,
	renderProviders: renderProviders, renderPicking: renderPicking, reload: reload, renderApplyStatus: renderApplyStatus });