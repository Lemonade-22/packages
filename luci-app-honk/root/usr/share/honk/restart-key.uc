#!/usr/bin/ucode
import { cursor } from 'uci';
import { readfile } from 'fs';
const uci = cursor();
let settings = {};
for (let key in ['data_dir', 'lan_interface', 'wan_interface', 'bind', 'native_api', 'native_api_port', 'geo_asset_dir'])
	settings[key] = uci.get('honk', 'infra', key);
settings.ssid = [];
uci.foreach('honk', 'ssid_route', (s) => {
	if (s.enabled === '1' && s.interface) push(settings.ssid, s.interface);
});
// native_api.ui 不是 UCI 字段，它取决于 /usr/share/doona 在不在。
// 装上或删掉 doona 都会改变这一项，而 honk 拒绝热改 native_api，
// 不把它算进 key 的话 reload 会一直报 "changed fields require process restart"
// 却又不触发重启，配置永远停在上一次的样子。
settings.panel = readfile('/usr/share/doona/index.html') !== null ? 'doona' : '';
print(sprintf('%J', settings));
