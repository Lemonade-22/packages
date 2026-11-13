#!/usr/bin/ucode
import { cursor } from 'uci';
const uci = cursor();
let settings = {};
for (let key in ['data_dir', 'lan_interface', 'wan_interface', 'bind', 'native_api', 'native_api_port', 'geo_asset_dir'])
	settings[key] = uci.get('honk', 'infra', key);
settings.ssid = [];
uci.foreach('honk', 'ssid_route', (s) => {
	if (s.enabled === '1' && s.interface) push(settings.ssid, s.interface);
});
print(sprintf('%J', settings));
