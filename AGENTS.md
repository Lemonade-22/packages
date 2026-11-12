# 给后续 AI 的硬规矩

本仓是 [VIKINGYFY/packages](https://github.com/VIKINGYFY/packages) 的 fork。目标只有一个：**随时能 `git pull upstream` 同步，且不破坏上游内容。**

违反下面任何一条，先把活停下问人，别自作聪明。

## 一、上游的东西一个字节都不许改

以下路径属于上游，禁止修改、删除、重命名、移动：

```
.github/**            除 Sync-Vendored-Apps.yml 这一个新文件
.gitattributes  LICENSE  README.md
axonhub  gecoosac  luci-app-axonhub  luci-app-gecoosac
luci-app-homeproxy  luci-app-upnp  luci-app-wolultra
miniupnpd  sing-box
```

新增文件可以，改已有文件不行。上游哪天自己也建了 `AGENTS.md`，那以合并结果为准，别抢着覆盖。

## 二、允许写的地方，只有这些

| 路径 | 谁能改 |
| --- | --- |
| `luci-app-static-gw/**` | 只由同步脚本写，**不要手改** |
| `luci-app-irqaffinity/**` | 只由同步脚本写，**不要手改** |
| `vendor/**` | 映射表、同步脚本，随意改 |
| `.github/workflows/Sync-Vendored-Apps.yml` | 同步 workflow |
| `AGENTS.md` | 本文件 |

那两个插件目录是独立仓库的快照。要改代码，去源仓改，下次同步会整目录覆盖，在本仓改等于白改。

## 三、提交纪律

- 只许 `git add -- <具体路径>`。**禁止 `git add -A` / `git add .` / `git commit -a`**，也不许 `git checkout -- .`、`git reset --hard` 这类会把上游文件卷进去的命令。
- 提交信息沿用 `chore: 同步自研插件 <目录>` 这种风格。
- 同步脚本自带越界检查：改动一旦落到映射目录之外，脚本直接中止、不提交。别想着绕过它。

## 四、加新插件

1. 在 `vendor/vendored-apps.tsv` 加一行：`目录<TAB>仓库地址<TAB>分支`。
2. 目录名必须是单层、且不在上面那张上游清单里，否则脚本拒绝。
3. 跑 `bash vendor/sync-vendored-apps.sh`，或在 Actions 里手跑「同步自研插件」。

## 五、同步上游

```bash
git remote add upstream https://github.com/VIKINGYFY/packages.git   # 只需一次
git fetch upstream
git merge upstream/main
```

用 merge，不要 rebase 掉本仓自己的提交。本仓只做"新增"，所以合并应当无冲突；一旦有冲突，说明有人动了上游文件，按第一条查。

## 六、两个已知的坑

- 上游每日维护（`.github/scripts/maintain-repository.sh`）会**删掉包目录根部的 README**。所以同步脚本不搬 README，你也别往那两个目录放。
- 上游建包发现规则是"两层路径上的 `*/Makefile`"。往包目录里再套一层带 Makefile 的子包，CI 永远扫不到。需要多包就各自开一个顶层目录。
