# SPDX-License-Identifier: GPL-2.0-only
#
# luci-app-honk — honk（eBPF 透明代理）的 LuCI 前端。

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-honk
PKG_VERSION:=20261113
PKG_RELEASE:=4

LUCI_TITLE:=LuCI for honk - eBPF transparent proxy (新界面)
# honk-core 不在标准 feed 里，装完本插件后自行安装（daeuniverse 源或自编），
# 这里不写死依赖，否则整条 CI 会因为找不到包而失败。
LUCI_DEPENDS:=+luci-base +curl +ca-bundle +ucode +ucode-mod-uci +ucode-mod-fs +jsonfilter +logrotate

# 包里带了 honk-core 二进制，必须跟随目标架构。
# luci.mk 的缺省是 LUCI_PKGARCH=all，把它直接赋给 PKGARCH，于是产物标成
# noarch —— apk 认为它跟架构无关，能装到任何设备上，装上之后二进制跑不起来。
# 这里覆盖成构建目标自己的架构包名（aarch64_cortex-a53 之类）。
LUCI_PKGARCH:=$(ARCH_PACKAGES)

define Package/$(PKG_NAME)/conffiles
/etc/config/honk
/etc/honk/custom.rules
/etc/honk/adblock.list
endef

# 装完立刻把目录补齐。rpcd 的 fs.write 不会自动创建父目录，
# 少了 /etc/honk 就会出现「保存表单时出错：未找到资源」。
define Package/$(PKG_NAME)/postinst
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
if [ ! -e /sys/class/net/br-lan ]; then
	lan_dev="$(uci -q get network.lan.device 2>/dev/null)"
	[ -n "$lan_dev" ] || lan_dev="$(uci -q get network.lan.ifname 2>/dev/null)"
	if [ -z "$lan_dev" ]; then
		for cand in eth1 br0 lan0 eth0; do
			[ -e "/sys/class/net/$cand" ] && { lan_dev="$cand"; break; }
		done
	fi
	[ -n "$lan_dev" ] && uci -q set honk.infra.lan_interface="$lan_dev"
fi
uci -q commit honk 2>/dev/null
exit 0
endef

# 升级走的是另一条钩子，不补的话覆盖安装后目录又没了
define Package/$(PKG_NAME)/postupgrade
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
if [ ! -e /sys/class/net/br-lan ]; then
	lan_dev="$(uci -q get network.lan.device 2>/dev/null)"
	[ -n "$lan_dev" ] || lan_dev="$(uci -q get network.lan.ifname 2>/dev/null)"
	if [ -z "$lan_dev" ]; then
		for cand in eth1 br0 lan0 eth0; do
			[ -e "/sys/class/net/$cand" ] && { lan_dev="$cand"; break; }
		done
	fi
	[ -n "$lan_dev" ] && uci -q set honk.infra.lan_interface="$lan_dev"
fi
uci -q commit honk 2>/dev/null
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature