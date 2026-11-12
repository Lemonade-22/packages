include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-static-gw
PKG_VERSION:=1.1.3
PKG_RELEASE:=1
PKG_PO_VERSION:=1.1.3

LUCI_TITLE:=Static Address Binding (per-host gateway/DNS)
LUCI_DEPENDS:=+luci-base +rpcd-mod-luci
LUCI_PKGARCH:=all
LUCI_MAINTAINER:=Lemonade-22
LUCI_URL:=https://github.com/Lemonade-22/luci-app-static-gw

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=Lemonade-22

# LuCI treats English as its source language, so LUCI_LANG.en is undefined and
# luci.mk silently ignores po/en (no luci-i18n-*-en package is emitted).
# Our source language is Simplified Chinese, so declare English explicitly.
LUCI_LANG.en:=English

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature

