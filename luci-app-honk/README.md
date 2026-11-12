# luci-app-honk

honk（Rust + eBPF 透明代理）的 LuCI 前端。界面骨架借 VIKINGYFY 的 homeproxy，
**但这不是 homeproxy**：配置源、进程、生成器、路由模型全部是 honk 自己的。

```
/etc/config/honk          ← LuCI 唯一写入口
        ↓ /usr/share/honk/gen_dae.sh
/etc/honk/config.dae      ← honk-core 的默认 -c 路径
        ↓
honk-core（TC eBPF 数据面）
```

## 页面

| Tab | 内容 |
| --- | --- |
| 路由设置 | 开关、主节点（组）、路由模式、端口白名单、QUIC、IPv6 四档、接口 |
| DNS · 基础 | 监听、地址族、ECS、bootstrap、上游表（名称/Server/角色/出站） |
| DNS · 高级 | 缓存条目、缓存 TTL、serve-stale、持久化、剥 HTTPS/SVCB、广告过滤 |
| 节点与组 | 节点分享链接；组的策略/成员/检查URL/容忍/final |
| 多SSID分流 | 每个网段一条 sip 规则，可单独绑出口组和 DNS 上游 |
| 访问控制 | LAN 源地址 → 代理/直连；目标网段 → 代理/直连 |
| 分流控制 | 域名列表 → direct / 组 |
| 自定义规则 | 整段裸写 routing { } 内部 |
| 状态 | 开关状态 + 一键重新生成 |

## 路由优先级（生成顺序）

```
1. ipversion(6) -> direct|block     仅 direct / block_global 两档放这里
2. sip(...) -> direct               访问控制：强制直连，压过一切
3. sip(...) -> <main_group>         访问控制：强制代理
4. sip(...) -> <ssid target>        多SSID分流
5. domain(geosite: geolocation-cn) -> direct
6. dip(geoip: cn) -> direct
7. ipversion(6) -> block            block 档（CN 例外）放这里
8. domain(suffix: ...) -> action    分流控制
9. dip(...) -> direct|<group>       目标策略
10. dport(<common>) -> <main_group> 端口白名单
11. fallback
```

## 自定义规则为什么存在文件里

`custom_rules_enabled=1` 时，整段 `routing { }` 由 `/etc/honk/custom.rules` 逐行替换。
这一页一旦打开，**多SSID分流、访问控制、分流控制、IPv6 模式、端口白名单、QUIC 设置
全部失效**——它们都在同一个 routing 块里，被整段覆盖了。

为什么不放 UCI：option 值不能跨行；改 list 之后 `uci show` 又把整串拍成一行，
生成器跑在路由器的 BusyBox sed 上，没有 `\n` 替换，拆不开。文件最省事。

## honk 的硬约束（踩过的坑）

- **路由目标只能是 `direct` / `block` / 组**。裸节点名在加载时被拒。所以「主节点」列的是组名。
- **没有 IPv6 开关**。eBPF 把 v4/v6 一起抓走，走哪全看规则；`ipversion(6)` 是匹配器不是开关。
- **`optimistic_cache_ttl` / `optimistic_stale_reply_ttl` 只吃裸数字**。写 `600s` 不会报错，
  会静默回退到 60 / 30。文档说接受 `s` 后缀，实测不接受。
- **`lan_interface` 不能整体加引号**。`lan_interface: 'a, b'` 触发 `legacy-list-quoting` 警告，
  必须裸写 `lan_interface: a, b`。
- **geo 资源缺失只警告不报错**。`geoip.dat` / `geosite.dat` 不在时 `geosite:` / `geoip:` 匹配器
  全部静默失效，规则看起来还在但什么都不匹配。init 里主动检查。
- **`/var/lib/honk/state` 权限必须 700**，否则 honk 拒绝启动（`state database path is unsafe`）。
- **每个组的每个叶节点常驻一条连接**。30 个 SSID 各配独立组 = 30×N 条，512MB 机器会吃穿。
  默认应复用少数几个组。

## 生成器的两个坑

- **不能开 `set -e`**。全篇都是「读一个可能不存在的 UCI 字段」，`uci get` 失败让命令替换返回非零，
  `-e` 会在第一个可选字段处掐断整个生成，而且不留半成品文件，排查时毫无线索。
- **`form.TextValue` 写多值要直用全局 `uci.set(cfg, sid, opt, array)`**，不要碰 `this.map.data`。

## geo 数据

| 文件 | 来源 | 大小 |
| --- | --- | --- |
| `geoip.dat` | Loyalsoldier/geoip `geoip-only-cn-private.dat` | 137 KB |
| `geosite.dat` | v2fly/domain-list-community `dlc.dat` | 2.4 MB |

geosite 没有官方 CN-only 小版本，Loyalsoldier 只产 IP 数据。规则实际上只用到
`geolocation-cn` 和 `category-ads-all` 两个分类，理论可裁剪到几十 KB，需要一个
protobuf 裁剪工具，暂未实现。

## 怎么装 honk-core 本身

本插件只提供前端。honk-core 不在 OpenWrt/ImmortalWrt 官方源里，要另装：

```sh
# 1) 导入 daeuniverse 的签名公钥
wget -O /etc/apk/keys/daeuniverse.pem https://openwrt.daeuniverse.org/public-key.pem

# 2) 加软件源（25.12 及以上；本插件面向 6.12+ 内核）
. /etc/openwrt_release
FEED="https://openwrt.daeuniverse.org/$(echo $DISTRIB_RELEASE | cut -d. -f1-2)"
echo "$FEED/packages.adb" >> /etc/apk/repositories.d/daeuniverse.list
apk update

# 3) 装本体
apk add honk
```

BTF 这块：官方 OpenWrt 内核不含 BTF，要一并装 `vmlinux-btf`；ImmortalWrt 内核自带
BTF（本仓库 `CONFIG_KERNEL_DEBUG_INFO_BTF=y` 已开），装空包 `vmlinux-btf-builtin`
即可，honk 启动时读 `/sys/kernel/btf/vmlinux`。

## 需要内核支持

honk 走 TCX，要 `CONFIG_NET_XGRESS`（不是 dae 用的 `NET_CLS_BPF`）。另外需要
`CONFIG_CGROUP_BPF`、`CONFIG_DEBUG_INFO_BTF`、cgroup v2 和已挂载的 `/sys/fs/bpf`。