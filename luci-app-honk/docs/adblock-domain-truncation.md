# 广告列表把域名啃掉一半，内核拒绝启动

2026-11-13 · luci-app-honk（ImmortalWrt SNAPSHOT, aarch64_cortex-a53, busybox 1.38.0）

## 现象

界面上「启用 honk」是打开的（`honk.config.enabled=1`），但内核始终不运行：

```
$ sh /usr/share/honk/honk-status.sh
stopped|v0.1.0-beta.6

$ cat /var/run/honk/apply.json
{"status":"validation_failed"}
```

`/etc/init.d/honk start` 没有任何输出，进程也不出现。重启机器同样起不来——
表现像「开机自启没生效」，实际配置生成阶段就已经失败了。

手动前台跑一次内核，才看到真正的死因：

```
ERROR honk_core: fatal error, shutting down: DNS policy contains an empty suffix domain matcher
```

## 排查

**1. 生成的配置里有畸形域名**

`/etc/honk/config.dae` 的 DNS 段是这样一堆：

```
qname(suffix: 0.myik.om, suffix: 0.nt.yjt.om, suffix: 0013., suffix: 0017637.om, ...) -> reject
```

两点异常：

- 域名被啃掉一部分：`myik` 应是 `myikas`，`nt` 应是 `net`，`om` 应是 `com`
- 有的条目直接以点结尾（`0013.`），构成**空后缀**

honk 对空后缀是硬拒绝的，而且拒绝的是**整份配置**，不是那一条规则。

**2. 源文件是好的**

```
$ head -5 /etc/honk/adblock.list
0.myikas.com
0.net.easyjet.com
0.r.msn.com
0.up.qingdaonews.com
000491b06a.com
```

十万行域名，全部正常。所以问题在生成环节，不在数据。

**3. 定位到一行**

`gen_dae.sh` 把每行域名拼进 `suffix:` 之前做过一次清洗：

```sh
ab_d="$(printf '%s' "$ab_d" | tr -d '[:space:]')"
```

## 根因

**busybox 的 `tr` 不展开 `[:space:]` 这个字符类。** 它把这串东西当成普通字符集合，
于是把 `[`、`:`、`s`、`p`、`a`、`c`、`e`、`]` 这些**字面字符**统统删掉了。

现场复现：

```
$ printf '0.myikas.com\n' | tr -d '[:space:]'
0.myik.om

$ printf 'spaces here\n' | tr -d '[:space:]'
 hr
```

第二行最能说明问题：空格没被删，反而是字母 s、p、a、c、e 全没了——
`[:space:]` 被当成了一串普通字符。

正确的写法（busybox 认这几个转义）：

```
$ printf '0.myikas.com\n' | tr -d ' \t\r'
0.myikas.com
```

GNU coreutils 的 `tr` 是支持字符类的，所以这行代码在桌面 Linux 上跑测试完全正常，
**只有到 busybox 上才炸**。这是它一直没被发现的原因。

## 后果链

```
tr 删掉 a/c/e/s/p
  → 十万行域名全部残缺
    → 其中以点结尾的（如 0013.）构成空后缀
      → honk 判定整份 DNS 配置非法
        → 内核拒绝启动
          → 界面显示"未运行"，重启也一样
```

一条字符类写法，卡住了整台机器的代理。

## 修复

改 `tr` 的参数，并加一道校验：坏数据无论如何不许进配置。

```sh
# 不能用 tr -d '[:space:]'：busybox 的 tr 不展开这个字符类，
# 它会按字面把 [ : s p a c e ] 这些字符删掉，域名全废。
ab_d="$(printf '%s' "$ab_d" | tr -d ' \t\r')"
case "$ab_d" in ''|'#'*) continue ;; esac
# 空后缀会让内核拒绝整份配置，只放行看起来是域名的条目。
case "$ab_d" in
  .*|*.|*[!A-Za-z0-9._-]*) continue ;;
  *.*) ;;
  *) continue ;;
esac
```

丢弃的条目：空行、注释、以点开头、以点结尾、含非法字符、没有点的。

## 验证

用一份故意夹带坏数据的临时列表生成：

```
0.myikas.com
example.org
bad.
.bad
# comment
（空行）
ok-domain.co.uk
```

结果：

```
suffix: 0.myikas.com
suffix: example.org
suffix: ok-domain.co.uk
畸形条目：0
```

保留的都是合法域名，`bad.` 和 `.bad` 被丢掉，注释和空行被跳过。

## 教训

**1. POSIX 字符类不能想当然。** `tr`、`grep`、`sed` 对 `[[:space:]]` 的支持不一致：
busybox 的 `grep`/`sed` 认，`tr` 在删除模式下会按字面处理。凡是要在路由器上跑的脚本，
带字符类的 `tr` 都该换成显式字符列表。

**2. 外部数据的清洗不能只做"去空白"。** 域名这类结构化输入，除了空白还得验形状：
有没有点、首尾是不是点、字符集合对不对。下游（这里是内核）对非法值往往是**整体拒绝**，
不是跳过某一条，代价远大于提前过滤。

**3. 状态文件要看细节。** `apply.json` 里的 `validation_failed` 才是线索，
界面上的"未运行"只是结果。这类分阶段的状态（generate / validate / reload / start）
比一个布尔值有用得多。

## 附带影响

装包时 `/etc/config/../honk/adblock.list` 是 conffile，被包的版本覆盖成了 0 字节：

```
-rw-r--r-- 0 Nov 13 22:48 /etc/honk/adblock.list
```

所以修复后当前配置里没有自定义广告规则，只剩 `qname(geosite: category-ads-all)`。
需要恢复的话跑一次 `update-adblock.sh` 重新拉取。
