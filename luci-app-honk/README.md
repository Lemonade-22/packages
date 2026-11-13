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

照 homeproxy 的做法分三页，不是一个表单塞十个 tab：

### 客户端设置

| Tab | 内容 |
| --- | --- |
| 路由设置 | 开关、**主分组**、路由模式、端口白名单、QUIC、IPv6 四档、LAN/WAN 接口 |
| 多SSID分流 | 每个网段一条 sip 规则，可单独绑出口组和 DNS 上游 |
| DNS | 基础（监听/地址族/ECS/bootstrap）、DNS服务器（国内/国外单选+自定义）、高级（缓存/广告过滤） |
| 访问控制 | LAN 源地址 → 代理/直连；目标网段 → 代理/直连 |
| 分流控制 | 域名列表 → direct / 组；自定义规则整段裸写 routing { } |

### 节点设置

| Tab | 内容 |
| --- | --- |
| 节点 | 手动节点增删改 + 导入分享链接；下方「当前节点」表列出内核实际加载的节点（名称/延迟/测试/类型/地址/订阅） |
| 分组 | 组的策略/成员/订阅成员/检查URL/容忍/final，每行一个「应用」按钮 = 设成主分组；下方显示运行中的分组状态 |
| 订阅 | 订阅地址/标识/间隔/UA + 独立的「已生效订阅」卡片（节点数/状态/更新时间/刷新） |

### 服务状态

只读页：运行状态条、六站连通性、规则资源、运行日志、仪表盘入口。

## 路由优先级（生成顺序）

```
1. pname(NetworkManager, systemd-resolved, dnsmasq, honk-core) -> direct(must)
2. dip(geoip:private) -> direct(must)   内网/回环/链路本地全包
3. dip(224.0.0.0/3) / 255.255.255.255/32 / 'ff00::/8' -> direct
4. l4proto(udp) && dport(123) -> direct  NTP
5. sip(...) -> direct                   访问控制：强制直连
6. sip(...) -> <main_group>             访问控制：强制代理
7. sip(...) -> <ssid target>            多SSID分流
8. domain(geosite: geolocation-cn) -> direct
9. dip(geoip: cn) -> direct
10. QUIC 处理
11. ipversion(6) && dip(geoip:cn) -> direct   仅 block 档
12. ipversion(6) -> block                     仅 block 档
13. domain(suffix: ...) -> action        分流控制
14. dport(<common>) -> <main_group>      端口白名单（routing_port=common 时）
15. fallback
```

**为什么第 1、2 条必须用 `direct(must)`**：普通 `direct` 只是选直连出口，DNS 仍归 honk
接管，管理连接照样被卷进去。`must` 才会立即终结规则搜索、跳过 DNS 控制器。

**为什么用 `dip(geoip:private)` 而不是逐条枚举本机地址**：单臂路由下路由器自己也在被代理
的接口上，早期版本用 `ip -4/-6 addr` 逐个枚举本机 IP 拼 `sip() && dip()`，IPv6 地址一变就
漏一条，honk 报 self-protection 覆盖不全。`geoip:private` 一条覆盖 10/8、172.16/12、
192.168/16、127/8、169.254/16、::1/128、fe80::/10、fc00::/7。

## 自定义规则为什么存在文件里

`custom_rules_enabled=1` 时，整段 `routing { }` 由 `/etc/honk/custom.rules` 逐行替换。
这一页一旦打开，**多SSID分流、访问控制、分流控制、IPv6 模式、端口白名单、QUIC 设置
全部失效**——它们都在同一个 routing 块里，被整段覆盖了。

为什么不放 UCI：option 值不能跨行；改 list 之后 `uci show` 又把整串拍成一行，
生成器跑在路由器的 BusyBox sed 上，没有 `\n` 替换，拆不开。文件最省事。

## honk 的硬约束（踩过的坑）

- **强制直连写 `direct(must)`，不是 `must_direct`。** dae 的语法是后者，honk 不认：

  ```
  pname(dnsmasq) -> must_direct    → ERROR: routing target is not a declared group or builtin
  pname(dnsmasq) -> direct(must)   → OK
  pname(dnsmasq) -> direct         → OK（但不会跳过 DNS 接管）
  ```

  从 daede / dae 的配置抄规则过来时，这一条会让整份配置编译失败。daede 仓库里
  其实也没有 `must_direct`，它用的是普通 `direct`。

- **路由目标只能是 `direct` / `block` / 组**。裸节点名在加载时被拒。所以「主分组」列的是组名，
  不是节点名——honk 没有「主节点」这个概念。
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
- **`Max locked memory` 默认只有 8 MB**，而 `ROUTING_HANDOFF_MAP` 有 65536 项。不够时插入
  失败，表现为 `routing_handoff_insert_failure` 计数上涨、DNS 上游莫名超时。而且**`ulimit`
  写在 `start_service` 里没用**——procd 不继承父 shell 的 rlimit，必须写进它 spawn 的那条
  command 里：`procd_set_param command /bin/sh -c "ulimit -l unlimited; exec ..."`。
- **`ipversion(6) -> block` 会连 `::1` 一起断**。`/etc/resolv.conf` 里同时有 `127.0.0.1` 和
  `::1`，客户端挑到后者就解析超时，表现为「有的站能开、有的站打不开」，极难查。
  现在靠 `dip(geoip:private) -> direct(must)` 兜住回环。
- **`score` 策略配域名 `check_url` 是死锁**：探测要解析 → 解析要走代理 → 代理要评分。
  四步互锁，组永远评零分、回退到 `final`，表现是「节点都在但一条流量都不走代理」。
  用 `urltest` + IP 形式的 `check_url`。
- **端口列表不能带空格**。`dport(22, 80, 443)` 只编译出一条规则（静默丢弃），
  `dport(22,80,443)` 才对。
- **reload 不能改 `native_api`**。加了面板或者删了面板，`ui:` 字段变了，honk 会拒绝热改
  并要求重启。`restart-key.uc` 必须把「面板在不在」算进 key，否则 reload 一直失败却
  不重启，配置永远停在上一次的样子。
- **UCI 存不住空字符串 option**。清空某个字段后 `uci commit` 会把这行删掉，生成器再读
  就是「从未配置过」。需要「明确不设置」的语义得用哨兵值（本项目用 `none`）。

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

升级提示：此版本沿用 luci-app-honk 包名。旧版 honk_new 的 /etc/config/honk_new 及 /etc/honk_new 不会自动迁移；安装前请备份并核对配置。旧版 honk 配置的兼容性也需检查，避免两个服务同时运行。
