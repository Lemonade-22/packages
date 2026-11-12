# SPDX-License-Identifier: GPL-2.0-only
#
# luci-app-honk — honk（eBPF 透明代理）的 LuCI 前端。

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-honk
PKG_VERSION:=20261112
PKG_RELEASE:=1

LUCI_TITLE:=LuCI for honk - eBPF transparent proxy
# honk-core 不在标准 feed 里，装完本插件后自行安装（daeuniverse 源或自编），
# 这里不写死依赖，否则整条 CI 会因为找不到包而失败。
LUCI_DEPENDS:=+luci-base
LUCI_PKGARCH:=all

define Package/$(PKG_NAME)/conffiles
/etc/config/honk
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature