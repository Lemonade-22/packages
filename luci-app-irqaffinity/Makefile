include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-irqaffinity
PKG_VERSION:=0.1.0
PKG_RELEASE:=1
PKG_PO_VERSION:=0.1.0

LUCI_TITLE:=IRQ affinity control (ethernet, heterogeneous core aware)
LUCI_DEPENDS:=+luci-base +rpcd
LUCI_PKGARCH:=all
LUCI_MAINTAINER:=Lemonade-22
LUCI_URL:=https://github.com/Lemonade-22/luci-app-irqaffinity

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=Lemonade-22

# LuCI treats English as its source language, so LUCI_LANG.en is undefined and
# luci.mk silently ignores po/en (no luci-i18n-*-en package is emitted).
# Our source language is Simplified Chinese, so declare English explicitly.
# (Same trap as luci-app-static-gw.)
LUCI_LANG.en:=English

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
