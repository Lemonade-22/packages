# SPDX-License-Identifier: GPL-2.0-only
#
# luci-app-honk — honk（eBPF 透明代理）的 LuCI 前端。

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-honk
PKG_VERSION:=20261113
PKG_RELEASE:=1

LUCI_TITLE:=LuCI for honk - eBPF transparent proxy
# honk-core 不在标准 feed 里，装完本插件后自行安装（daeuniverse 源或自编），
# 这里不写死依赖，否则整条 CI 会因为找不到包而失败。
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all

define Package/$(PKG_NAME)/conffiles
/etc/config/honk
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
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature