# 浏览器反复退回 LuCI 登录页：会话被自己清掉

某次调试 · ImmortalWrt SNAPSHOT

调试 honk 页面时，Chrome 扩展驱动浏览器始终进不去后台：登录成功后下一次跳转又被弹回登录页。
页面本身没问题，是**调试动作把服务端会话表清空了**，而浏览器还攥着一枚失效的 cookie。

## 现象

- `chrome_navigate` 打开 `/cgi-bin/luci/admin/services/honk/node`，页面永远是登录页
  （`input[name="luci_username"]` 存在）。
- 填 `root` + 空密码登录，**当次**能进；下一次跳转（哪怕是同一页面加 `?fresh=2`）又回到登录页。
- 控制台反复出现：

  ```
  RPCError: RPC call to uci/get failed with error -32002: Access denied
  RPCError: RPC call to file/list failed with error -32002: Access denied
  ```

- **同一时刻在路由器本机用 curl 带自己的 cookie jar 访问同一个 URL，返回 200 和正常页面**
  （页面里 `节点设置` 出现 3 次，没有"需要授权"字样）。

服务端是好的，浏览器那份会话是坏的。

## 排查

**1. 先怀疑 ACL**

以为是权限没加载，多次 `/etc/init.d/rpcd restart`。这是后面所有麻烦的开始。

**2. 用 curl 隔离**

```sh
curl -s -c c.txt -d "luci_username=root&luci_password=" http://127.0.0.1/cgi-bin/luci/
curl -s -b c.txt -o node.html -w "%{http_code}\n" http://127.0.0.1/cgi-bin/luci/admin/services/honk/node
```

结果 `200`，页面内容正确。**ACL、页面、服务端全部排除。**

**3. 换 origin 验证**

给 `br-lan` 临时加一个地址：

```sh
ip addr add 192.168.1.89/24 dev br-lan
```

用 `http://192.168.1.89/...` 访问 —— 登录一次后立刻正常，页面渲染、状态横幅都在。
测完删掉：`ip addr del 192.168.1.89/24 dev br-lan`。

同一个浏览器对 `192.168.1.1` 始终失败，对 `.89` 一次就通。差别只在 cookie。

## 根因

### ① 重启 rpcd 会清空会话表

rpcd 把会话放在内存里，**每次重启都清空**。而触发重启的不只是显式命令：

- `/etc/init.d/rpcd restart`
- `uci commit rpcd` —— rpcd 自己订阅了 uci 配置，commit 会**顺带重启它**

于是形成循环：

```
登录成功
  → 我执行一次 restart / uci commit rpcd
    → 服务端会话表没了
      → 浏览器还带着旧的 sysauth cookie
        → 每次请求被拒 → LuCI 显示登录页
          → 我再登录 → 再被自己踢掉
```

### ② 会话 30 秒过期 + 慢轮询

```
$ ps w | grep sbin/rpcd
/sbin/rpcd -s /var/run/ubus/ubus.sock -t 30

$ cat /etc/config/rpcd
config rpcd
        option timeout 30
```

OpenWrt 默认是 300 秒，这个镜像是 30。工具链每一步（navigate → 等渲染 → evaluate）
本身要几秒到几十秒，一次"打开页面再检查"就可能跨过过期点，表现为"刚登录完又要求登录"。

### ③ 为什么换个 IP 就好了

Cookie 按 origin 存。旧 origin 上那枚失效的 `sysauth` 一直跟着发；换一个从未登录过的
origin 就是干净的 cookie jar，所以立刻正常。

## 排除过的可能

| 猜测 | 结论 |
|---|---|
| 插件或页面有 bug | 否。curl 带有效 cookie 时 200；换 origin 后渲染、按钮、横幅全正常 |
| ACL 文件损坏 | 否。`jsonfilter` 校验通过，`ubus call luci.honk connection_check` 正常返回 |
| 主机名解析到了别的设备 | 无关。同网段另一台设备占了那个地址，一度被误当成目标机去测，属操作失误 |
| 无痕窗口能救 | 用户开了无痕，但 `chrome_tabs` 返回 0 个标签 —— **扩展默认看不到无痕窗口**，需在扩展详情里开「在无痕模式下启用」 |

## 附带发现的缓存坑（独立问题）

uhttpd 对 `/luci-static/*` 不返回 `Cache-Control`，而资源 URL 是
`hk3.js?v=<luci版本>-<apk数据库mtime>`。热修 `/www` 下的文件**不会改变这个 `?v=`**，
浏览器就一直吃旧缓存：

- 磁盘上 17996 字节，`curl` 取到的也是 17996，浏览器拿的却是 13420 的旧压缩版。
- 表现：改了代码、页面行为没变，怎么刷新都像没生效。

处理办法：

```sh
touch /lib/apk/db/installed      # 让 ?v 跳一格，所有资源 URL 一起换
rm -f /tmp/luci-indexcache*
```

页面 HTML 本身也会被启发式缓存，在 URL 后加任意查询参数（如 `?fresh=2`）可强制取新 HTML。

## 建议

1. **调试 UI 期间不要重启 rpcd。** 要改 ACL 就等浏览器验证做完再重启；重启后必须重新登录。
2. **认证问题先用 curl + cookie jar 在路由器本机验证**，能立刻区分「服务端拒绝」和「浏览器 cookie 脏了」。
3. 需要干净会话时，**临时给 `br-lan` 加一个 IP 别名当新 origin**，比清 cookie 可靠；用完删掉。
4. 或者给扩展开「允许无痕」，直接驱动无痕窗口。
5. rpcd 的 30 秒超时是镜像默认值，不是插件设的。要改就明确改并说明，别在调试过程中悄悄动 ——
   每改一次都可能多触发一次重启，把正在验证的会话再踢掉一遍。
