#!/bin/sh
[ -d /etc/honk ] || mkdir -p /etc/honk
[ -f /etc/honk/custom.rules ] || touch /etc/honk/custom.rules
[ -f /etc/honk/adblock.list ] || touch /etc/honk/adblock.list
mkdir -p /var/lib/honk/state
chmod 700 /var/lib/honk/state
# luci.mk 把 root/usr/share/ 下的文件按 644 装，而 rpcd 的 fs.exec 要求可执行。
# 订阅刷新、连通性测试、资源更新全靠这些脚本，少了 x 位整页都报"未找到资源"。
chmod 755 /usr/share/honk/*.sh 2>/dev/null
mkdir -p /var/run/honk
chmod 755 /var/run/honk 2>/dev/null
# 有些机型没有 br-lan 网桥，只有 eth0/eth1 这种裸网口。
# 默认值写死 br-lan 的话，这些机器装完 honk 会报找不到接口、什么都不代理。
# 装包时按 network 配置和实际网卡挑一个，用户之后仍可在界面上改。
if [ -z "$(uci -q get honk.infra.lan_interface)" ]; then
	lan_dev="$(uci -q get network.lan.device 2>/dev/null)"
	[ -n "$lan_dev" ] || lan_dev="$(uci -q get network.lan.ifname 2>/dev/null)"
	if [ -z "$lan_dev" ]; then
		for cand in br-lan eth1 br0 lan0 eth0; do
			[ -e "/sys/class/net/$cand" ] && { lan_dev="$cand"; break; }
		done
	fi
	[ -n "$lan_dev" ] && uci -q set honk.infra.lan_interface="$lan_dev"
fi
uci -q commit honk 2>/dev/null
