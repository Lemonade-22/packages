#!/usr/bin/ucode
// UCI lists must be read as arrays: display names may contain spaces.
import { cursor } from 'uci';

const uci = cursor(ARGV[0] || '/etc/config');
uci.load('honk_new');
function sections(kind) {
	let rows = [];
	uci.foreach('honk_new', kind, (row) => push(rows, row));
	return rows;
}
function quote(value) {
	value = '' + value;
	if (match(value, /[\r\n]/)) die('Names and links must occupy one line\n');
	if (index(value, "'") < 0) return "'" + value + "'";
	if (index(value, '"') < 0) return '"' + value + '"';
	die('Encode quotes in links; names cannot contain both quote styles\n');
}
function list(value) { return type(value) === 'array' ? value : (value ? [value] : []); }
const groups = sections('group'), nodes = sections('node');
let group_names = {}, providers = {}, node_names = {};
for (let g in groups) {
	g.name ||= g['.name'];
	if (!match(g.name, /^[A-Za-z_][A-Za-z0-9_-]*$/) || g.name in ['direct', 'block'])
		die('Group names must use letters, numbers, underscores or hyphens\n');
	if (group_names[g.name]) die('Duplicate group name: ' + g.name + '\n');
	group_names[g.name] = g;
}
print('subscription {\n');
for (let s in sections('subscription')) {
	if (s.enabled !== '1' || !s.url) continue;
	const tag = s.tag || s.name || s['.name'];
	if (providers[tag]) die('Duplicate subscription tag: ' + tag + '\n');
	if (!match(s.url, /^https?:\/\//)) die('Subscription URLs must use HTTP or HTTPS\n');
	providers[tag] = true;
	const interval = s.interval || '86400';
	if (!match(interval, /^[0-9]+$/)) die('Subscription interval must be seconds\n');
	const route = s.outbound || 'direct';
	if (route !== 'direct' && route !== 'routing' && !group_names[route])
		die('Unknown subscription outbound\n');
	printf('    %s: %s {\n        interval: %ss\n        cache: true\n        route: %s\n', quote(tag), quote(s.url), interval, route);
	// user_agent 是预设下拉，选 custom 时真正的值在 user_agent_custom
	let ua = (s.user_agent === 'custom') ? (s.user_agent_custom || '') : (s.user_agent || '');
	if (ua) printf('        ua: %s\n', quote(ua));
	print('    }\n');
}
print('}\nnode {\n');
for (let n in nodes) {
	// Keep old imported records on disk as a backup, but the provider owns its nodes.
	if (n.subscription || n.enabled !== '1' || !n.uri || !n.name) continue;
	if (node_names[n.name] || group_names[n.name] || n.name in ['direct', 'block'])
		die('Node names must be unique and distinct from group names\n');
	if (!match(n.uri, /^(vless|vmess|trojan|hysteria2?|hy2|tuic|ss|anytls|juicity|socks5):\/\//i))
		die('Unsupported node scheme; SSR is not supported by honk\n');
	node_names[n.name] = true;
	printf('    %s: %s\n', quote(n.name), quote(n.uri));
}
print('}\ngroup {\n');
for (let g in groups) {
	const policy = g.policy || 'urltest';
	if (!(policy in ['selector', 'urltest', 'score', 'loadbalance', 'fallback'])) die('Unknown group policy\n');
	printf('    %s {\n', g.name);

	// 订阅节点里常混着「剩余流量」「套餐到期」这类占位节点：
	// 连接参数是真的，但根本连不上，自动选优会挑到它们。
	// 三种模式，跟 HomeProxy 的过滤器一致：
	//   disabled  不过滤
	//   blacklist 命中关键词的丢掉
	//   whitelist 只保留命中关键词的
	//
	// honk 里多条 filter: 行是 OR，&& 是 AND，|| 不支持（实测解析成空集）。
	// 所以白名单要拆成每个关键词一行；黑名单的排除条件必须 && 挂到每一行上，
	// 只挂第一行的话，后面的行会把被排除的节点又带回来。
	const mode = g.filter_nodes || 'disabled';
	const kws = [];
	for (let w in list(g.filter_keywords)) {
		if (length(w) === 0) continue;
		push(kws, w);
	}

	let neg = '';
	if (mode === 'blacklist') {
		for (let w in kws)
			neg += ' && !name(keyword: ' + quote(w) + ')';
	}

	let lines = [];
	if (mode === 'whitelist' && length(kws) > 0) {
		// 白名单：这个组只含命中关键词的节点，不再看成员和订阅
		for (let w in kws)
			push(lines, 'name(keyword: ' + quote(w) + ')');
	} else {
		for (let member in list(g.members)) {
			if (member === g.name) die('A group cannot contain itself\n');
			push(lines, (group_names[member] ? 'group(' : 'name(') + quote(member) + ')');
		}
		for (let tag in list(g.providers)) {
			if (!providers[tag]) die('Group refers to a disabled or missing subscription\n');
			push(lines, 'subtag(' + quote(tag) + ')');
		}
	}

	// honk 对没有任何 filter 的组按「包含全部节点」处理。那不是我们要的默认：
	// 新建一个组、还没选成员，它就已经把整份订阅吞进去了。
	if (length(lines) === 0)
		push(lines, "name('__honk_no_members__')");

	for (let e in lines)
		printf('        filter: %s%s\n', e, neg);

	printf('        policy: %s\n', policy);
	if (g.check_url) printf('        check_url: %s\n', quote(g.check_url));
	if (g.tolerance) {
		if (!match(g.tolerance, /^[0-9]+$/)) die('Group tolerance must be milliseconds\n');
		printf('        tolerance: %s\n', g.tolerance);
	}
	const final = g.final || 'block';
	if (!(final in ['direct', 'block']) && !group_names[final]) die('Unknown group fallback\n');
	printf('        final: %s\n    }\n', final);
}
print('}\n');

// Check group cycles before the caller promotes the complete candidate.
let visiting = {}, visited = {};
function visit(name) {
	if (visiting[name]) die('Circular group reference: ' + name + '\n');
	if (visited[name]) return;
	visiting[name] = true;
	const g = group_names[name];
	for (let member in list(g.members)) if (group_names[member]) visit(member);
	if (group_names[g.final]) visit(g.final);
	delete visiting[name];
	visited[name] = true;
}
for (let name in group_names) visit(name);
const main = uci.get('honk_new', 'config', 'main_group');
if (main && main !== 'nil' && !group_names[main]) die('Main group does not exist\n');
