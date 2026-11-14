# SPDX-License-Identifier: GPL-2.0-only
#
# luci-app-honk — honk（eBPF 透明代理）的 LuCI 前端。

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-honk
PKG_VERSION:=20261113
PKG_RELEASE:=8

LUCI_TITLE:=LuCI for honk - eBPF transparent proxy (新界面)
# Release 工作流会注入 honk-core；单独源码构建需自行提供兼容内核。
# 非标准 feed 不写死依赖，避免找不到包导致构建失败。
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
[ -n "$${IPKG_INSTROOT}" ] && exit 0
/bin/sh /usr/share/honk/package-setup.sh
exit 0
endef

# 升级走的是另一条钩子，不补的话覆盖安装后目录又没了
define Package/$(PKG_NAME)/postupgrade
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
/bin/sh /usr/share/honk/package-setup.sh
exit 0
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature