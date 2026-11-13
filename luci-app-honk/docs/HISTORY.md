## 2026-11-13 r7：操作反馈与资源更新收尾

- 订阅 POST 不因浏览器中断重复发送，已受理操作沿用原编号查询，轮询逐步退避。
- 资源下载及服务应用改成短请求启动后台任务；同类任务执行中再次点击附着到原任务。
- 应用失败传递到界面；重新生成按钮实际执行生成、校验及应用。启动后确认原生 API 就绪。
- 安装/升级共用初始化脚本，已有监听接口不覆盖；新安装按设备选择。
- 分组成员按需展开，隐藏标签暂停轮询；日志支持暂停/复制，向上翻阅不强制滚底。
- 六站并行测试每站最多 8 秒，保留 curl 错误码；节点标题明确 TCP/IPv4 测试范围。
- GeoIP 更新保持 CN/private 来源，两个文件均下载成功才替换；资源状态读取实际目录，修正时间单位。
- 广告规则合并多个下载源，去重后检查非空，再替换；下载失败保留旧数据。
- 增加生成器、广告更新、连接测试解析、后台任务去重及前端异步操作回归检查。
- 仅完成代码和本地检查；路由器上的真实 LuCI/eBPF/节点性能仍需实测。

# luci-app-honk 开发记录

## 一、目标

honk 是 dae 系的一个 eBPF 透明代理内核，只有命令行和一坨 dae 语法配置。
**目标**：给它做一个 LuCI 管理界面，交互和观感参照 homeproxy。

约束：

- **不能用 homeproxy 的名字**。代码、菜单、包名、日志，一律叫 honk。
- 配置只写 UCI，真正的 dae 配置在启动/重载时由脚本生成到 /etc/honk/config.dae。
- 复用现有 OpenWrt 包体系，能进自己的 CI 编成 apk。

## 二、整体结构

    luci-app-honk/
    ├── Makefile                              包定义
    ├── htdocs/luci-static/resources/view/honk/
    │   ├── panel.js                          实际加载的界面
    │   └── client.js                         同内容，历史遗留
    ├── root/
    │   ├── etc/config/honk                   UCI 默认值
    │   ├── etc/init.d/honk                   procd 启动脚本
    │   └── usr/share/honk/
    │       ├── gen_dae.sh                    UCI → dae 语法
    │       ├── update-subs.sh                订阅下载解析
    │       ├── update-geo.sh                 geodata 更新
    │       ├── update-adblock.sh             广告规则更新
    │       ├── probe.sh                      连通性测试
    │       ├── dash-status.sh                面板探测
    │       ├── honk-api.sh                   原生 API 封装
    │       ├── honk-status.sh                运行状态
    │       └── geo/                          geoip.dat / geosite.dat
    └── tools/check-uci-sections.py           UCI section 重名检查

关键设计：**界面永远不直接写 dae 配置**。所有选项存 UCI，gen_dae.sh 负责翻译。
好处是界面可以随便改结构，配置格式只有一个出口。

## 三、里程碑

### 1. 从零搭界面

十个标签页：路由设置 / DNS / 节点与分组 / 订阅 / 选优 / 多SSID分流 /
访问控制 / 分流控制 / 自定义规则 / 运行状态。

参考 homeproxy 的布局：标题 + 副标题 + 状态行 + 选项卡。

### 2. geo 数据

按作者要求从 Loyalsoldier/geoip 取，默认注入 GeoIP:CN 的小文件，不要塞全量。

### 3. 多SSID分流

passwall 风格：每条规则 = 一个 SSID 来源网段 → 出口组。
生成 sip(源网段) -> 组 规则，排在"大陆直连"之前，所以网段优先。

界面上有个「读取无线网络」按钮，从 /etc/config/wireless 读出本机 SSID。

### 4. DNS 页

最初想做多选 + 缓存，作者几次纠正后定型为 **MosDNS 那样**：

- 基础设置 / DNS服务器 / 高级设置 三个子页
- 国内 DNS、国外 DNS **各自只能选一个**
- 选「— 自定义 —」时露出输入框
- 上游表格整个删掉，只靠这两个下拉

### 5. 节点与订阅

- 节点：直接存分享链接，honk 原生就吃这个格式
- 订阅：兼容纯链接 / base64 / Clash YAML 三种格式
- 协议覆盖 vless / vmess / trojan / hysteria2 / tuic / ss / ssr / anytls / juicity / socks5

### 6. 搬到 packages 仓库 + CI

从 OpenWRT-CI_Self 移到 Lemonade-22/packages，单独开 workflow 编译。
后来又把 **honk-core 二进制也打进包里**，按架构从官方 release 取。

### 7. honk-core 集成

装完自动建目录（/etc/honk、/var/lib/honk/state），
启动时挂 bpffs、生成配置、procd 拉起。

### 8. doona 面板

官方 Zakkaus/doona 有现成 apk，装上后 native_api.ui 指过去就能用。
运行状态页从"写死一句说明"改成实探：装了什么显示什么，给按钮不给裸地址。

## 四、踩过的坑

### LuCI 框架

**option.description 只接受字符串。** 传 ('文字' + E('em', ...)) 会渲染成
[object HTMLElement]，必须用数组 [ '文字', E('em', ...) ]。

**空 title 会让标题列塌掉。** taboption(..., ' ') 或 '' 时，主题的 tooltip
图标会掉到按钮左上方。要给正常标题。

**主题给非空 cbi-value-description 加绝对定位图标。** 规则是：

    .cbi-value-description:not(:empty)::before {
        position: absolute;
        inset-inline-start: calc(var(--help-indent) * -1);
    }

自己的内容别借用这个 class，用普通 div 就绕开了。
注意：**一个空格也算非空**（:empty 看的是"数据长度为零"）。

**fs.exec() 要两个参数。** fs.exec('/path/x.sh nodes') 会报"未找到资源"，
必须 fs.exec('/path/x.sh', ['nodes'])。

**ACL 里 exec 权限容易丢。** 用字符串替换改 JSON 时静默失败过两次，
后来改成解析成对象再改再序列化。

**luci.mk 打包时会 minify .js。** 44 KB 源码装上去是 34 KB / 21 行。

### UCI

**section 名不能含 @ [ ]。** 用 uci show 解析出的匿名 section 引用
（如 @subscription[0]）直接拼 section 名会得到 Invalid argument。

**重复的 section 名会静默毁掉整个应用。** 同一个名字既是 node 又是
domain_route 时，uci show honk 直接报错，菜单项消失或整站 500。
踩过三次，后来写了 tools/check-uci-sections.py。

### honk / dae 语法

**qname(domain(...)) 是错的。** 正确写法 qname(suffix: a, suffix: b)，
前者会被 honk 判为 trailing-matcher-text 然后**丢掉整条规则**。

**native_api 必须显式 enabled: true。** 只写 listen 监听器压根不启动，
日志里连提都不提一句。

**地区数据靠 DAE_LOCATION_ASSET 环境变量。** 不是 assets.geodata 的 URL，
也不是任何配置字段。手动测试时漏掉这个变量，会误判成"honk 不读本地文件"。

**direct 不等于"强制直连"。** 普通 direct 只是选直连出口，
DNS 仍归 honk 接管，管理连接照样被卷进去。要 direct(must) ——
它才会立即终结规则搜索、跳过 DNS 控制器。

**sip(整段lan) -> direct 会废掉代理。** 那样连 LAN 设备去外网的流量也直连了。
正确是 sip(lan) && dip(路由器IP) && !dport(53) -> direct(must)。

**score 策略 + 域名 check_url 是死锁。**
score 靠探测 check_url 评分 → 探测 gstatic 要解析 → 解析要走代理 →
代理要靠 score 选节点。四步互锁，评分永远为零，组回退到 final: direct，
表现是"节点都在、延迟正常，但一条流量都不走代理"。
改成 urltest + IP 形式的 check_url 就通了。

**端口列表不能带空格。** dport(22, 80, 443) 会只编译出一条规则（静默丢弃），
dport(22,80,443) 才对。

### 订阅解析

**节点名在 # 后面，是 percent-encoded。** 要自己解码，
busybox 的 awk 没有 strtonum，用 sed 转 \xNN 再交给 printf %b。

**vmess 的名字藏在 base64 的 ps 字段里**，还过了一层 JSON 转义（\uXXXX）。
交给 ucode 处理：json(b64dec(...))。

**订阅商会在前面塞信息占位节点**（剩余流量 / 套餐到期），
连接参数跟真节点完全一样。按 # 之前的部分去重，名字优先取非信息那版。

### 打包与运行

**CONFIG_KERNEL_* 在 .config 里是静默失效的**，得通过
Scripts/kernel_compat.py 注册到 config/Config-kernel.in。

**procd_set_param logfile 不保证创建文件。** 这台固件上完全不工作，
改用 sh -c 'exec ... >>/var/log/x.log 2>&1'。

**关掉开关不等于停服务。** 原实现是 reload_service 里 is_enabled || return 0，
既不停进程也不摘 S99 自启。要显式 stop + disable。

**apk 装新包时会顺手清掉"没人依赖"的包。** 装 doona 时把
luci-app-honk 连同 flock / ucode-mod-math / unzip 一起删了。

### 操作事故

**rm -rf /tmp/* 会毁掉 ubus。** /var/run 和 /var/lock 都是 /tmp 的软链，
删掉之后 ubusd 的 socket 目录消失，所有 ubus 调用失败，
session_retrieve() 拿到 null，整个 LuCI 500。
更阴的是 procd 配的 ubus 以 ubus 用户运行，重建目录时属主给的是 root，
它会一直起不来，累计失败三千多次后 procd 放弃。

**浏览器缓存会骗人。** LuCI 给资源加的 ?v= 是全局版本号，
改文件它不变，浏览器一直用本地副本。改完后端一定要先 curl 服务端
确认返回内容，再判断是不是缓存。为了绕开这个，view 路径从
honk/client 改成了 honk/panel。

## 五、当前状态

在 某设备（qualcommax/ipq60xx，内核 6.18.60，ImmortalWRT SNAPSHOT）上：

| 项目 | 状态 |
| --- | --- |
| 代理功能 | **可用**。google / youtube 200，国内直连正常 |
| DNS | honk 透明解析，加密上游走代理 |
| geo 分流 | 生效（本地 dat 已正确加载） |
| 节点 | 按来源订阅分表显示 |
| doona | 已安装，但 native_api 只监听回环，外部打不开 |
| 日志 | 可用（/var/log/honk.log） |
| 开机自启 | 关着（S99honk 已删） |

## 六、订阅迁移：会踩的坑

新生成器不再加载带 `subscription` 字段的旧导入节点（第 48 行 `if (n.subscription ...) continue`），
避免和 honk 原生订阅重复。但**组的成员是按节点名引用的**，旧组的成员全都指向这些节点。

实测确认的两件事：

**一、节点名是一致的。** honk-core 的 `share_link.rs`：

```rust
// VMess
name: self.ps.filter(|name| !name.is_empty()).unwrap_or_else(|| format!("vmess-{}", host))
// 其余协议
node.name = url.fragment().map(percent_decode_str)
    .or_else(|| query.get("remark"))
    .unwrap_or_else(|| format!("{}-{}", url.scheme(), node.host));
```

VMess 取 `ps`，其他取 `#` 后那段，URL 解码——跟导入脚本用的是同一个字段。
所以 `filter: name('某节点名')` 能匹配上订阅解析出来的节点。

**二、组为空时的后果比想象中轻。** 用官方 beta.6 二进制在 mock 模式跑：

```
INFO Group 'proxy' resolved 0 node(s)
INFO Router ready with 0 compiled routes
```

honk **不报错**，但会把引用这个组的规则**静默丢掉**。
后果是代理不生效、流量退回直连，而不是断网。危险的是它一句话都不说。

**所以迁移时要注意**：升级后先看运行状态页的分组是否 `resolved N node(s)`，
N 为 0 就说明成员名对不上，得把组的成员改成 `subtag(订阅名)` 或者重新选。

## 七、待办

1. **doona 打不开**。非回环监听必须带认证，二选一：
   secret: '<16+ 字节随机>' 或 password_auth: true。
2. **client.js 和 panel.js 重复**。是绕缓存的临时手段，长期应该合并。
3. **CI 产物落后**。远端源码是最新的，但最近发的 apk 不含这些修复。
4. **update-geo.sh 残留 .tmp**。下载完没改名成正式文件，白占 16 MB。
5. **geo 的 assets.geodata 从未真正触发下载**。本地文件一直在，
   那条兜底路径没被验证过。

## 八、一条教训

这一路「改了没生效」出现了七八次，绝大多数不是代码问题，而是：

- 改了本地但忘了同步到设备
- 手动跑测试时环境变量跟 init 脚本不一致
- 浏览器缓存

**每次都是先怀疑代码，绕一大圈。** 后来的做法是：改完先 curl 服务端
确认实际返回的内容，再判断要不要怀疑代码。

## 后续界面调整（本地待验证）

原单页 client/panel 重复的待办属于旧版历史；新界面采用 hk3/client、node、status 三页。节点测试改为原生异步探测并等待结果，批量测试位于订阅节点列表。统一运行及配置应用状态，接口失败单独提示。以上改动尚需目标设备验证。
