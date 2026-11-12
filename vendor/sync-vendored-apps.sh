#!/usr/bin/env bash
#
# 把 vendor/vendored-apps.tsv 里列出的独立仓库，整份同步到本仓对应目录。
#
# 硬规矩：只写表里那些顶层目录，其余路径一个字节都不许动。
# 本仓是 VIKINGYFY/packages 的 fork，必须随时能 git pull upstream 不冲突。
#
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

TABLE="vendor/vendored-apps.tsv"
BRANCH="${PACKAGE_BRANCH:-main}"

# 上游 VIKINGYFY/packages 自有的路径。同步脚本一律不读不写不删。
PROTECTED=(
	.github
	.gitattributes
	LICENSE
	README.md
	axonhub
	gecoosac
	luci-app-axonhub
	luci-app-gecoosac
	luci-app-homeproxy
	luci-app-upnp
	luci-app-wolultra
	miniupnpd
	sing-box
)

die() {
	printf '%s\n' "$*" >&2
	exit 1
}

is_under() {
	local path="$1" prefix="$2"
	[[ "$path" == "$prefix" || "$path" == "$prefix"/* ]]
}

is_protected() {
	local path="$1" item
	for item in "${PROTECTED[@]}"; do
		is_under "$path" "$item" && return 0
	done
	return 1
}

# 本仓自己新增的文件：改它们不算越界（比如加一行映射表）。
OWNED=(
	vendor
	AGENTS.md
	.github/workflows/Sync-Vendored-Apps.yml
)

# 任何既不在映射目录、也不在上面的改动都算越界。
mapped=()
guard() {
	local path item ok unexpected=()
	# 三路查询都用 NUL 分隔，并关掉重命名检测：重命名会被拆成删+增两条，路径原样不带引号。
	while IFS= read -r -d '' path; do
		[[ -n "$path" ]] || continue
		ok=0
		for item in "${mapped[@]}" "${OWNED[@]}"; do
			is_under "$path" "$item" && { ok=1; break; }
		done
		(( ok )) || unexpected+=("$path")
	done < <(
		git -c diff.renames=false diff --name-only -z
		git -c diff.renames=false diff --cached --name-only -z
		git ls-files --others --exclude-standard -z
	)
	if (( ${#unexpected[@]} > 0 )); then
		printf '越界：以下路径既不属映射目录，也不属本仓自有文件，已中止且未提交：\n' >&2
		printf '  %s\n' "${unexpected[@]}" >&2
		exit 1
	fi
}

[[ -f "$TABLE" ]] || die "缺少映射表：$TABLE"

while IFS=$'\t' read -r dir url branch || [[ -n "${dir:-}" ]]; do
	dir="${dir%$'\r'}"
	branch="${branch%$'\r'}"
	[[ -n "${dir:-}" && "$dir" != \#* ]] || continue
	[[ -n "${url:-}" && -n "${branch:-}" ]] || die "映射表格式错误，应为 目录<TAB>仓库<TAB>分支：$dir"
	[[ "$dir" != */* && "$dir" != .* ]] || die "目录必须是仓库顶层的单层名称：$dir"
	is_protected "$dir" && die "拒绝同步到上游自有目录：$dir"
	mapped+=("$dir")
done < "$TABLE"

(( ${#mapped[@]} > 0 )) || die "映射表为空"

# 动手之前先查一遍：工作树若已有映射目录之外的改动，直接退出，别把人家没提交的活搅乱。
guard

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

summary=()
declare -A srcs=()
for index in "${!mapped[@]}"; do
	dir="${mapped[index]}"
	row="$(awk -F '\t' -v d="$dir" '$1 == d { print $2 "\t" $3; exit }' "$TABLE")"
	url="${row%%$'\t'*}"
	ref="${row#*$'\t'}"
	src="$work/$index"
	srcs["$dir"]="$src"

	printf '同步 %s <- %s@%s\n' "$dir" "$url" "$ref"
	git -c core.autocrlf=false clone --quiet --depth 1 --branch "$ref" "$url" "$src"
	sha="$(git -C "$src" rev-parse --short=12 HEAD)"
	# 先抽到暂存区，验过再换上去：任何一处不对劲都不该让包目录先被清空。
	stage="$work/stage-$index"
	mkdir -p "$stage"
	git -C "$src" archive --format=tar HEAD | tar -x -C "$stage"
	# 不搬：源仓自己的 CI 与 git 配置；根 README 也不搬，本仓每日维护会删掉它。
	rm -rf -- "$stage/.github" "$stage/.gitignore" "$stage/.gitattributes" "$stage/README.md" "$stage/README.en.md"
	# 源仓 HEAD 若没有 Makefile（空树、分支写错），到这里就停，包目录原样不动。
	[[ -f "$stage/Makefile" ]] || die "源仓 $url 的 $ref 分支里没有 Makefile，已中止，$dir 未改动"
	rm -rf -- "$dir"
	mv -- "$stage" "$dir"
	summary+=("$dir\t$sha\t$url")
done

guard
git add -- "${mapped[@]}"

# Windows 上 tar 落不了 +x，按源仓标了 100755 的清单在索引里补回来。
for package in "${mapped[@]}"; do
	while IFS= read -r entry; do
		[[ -n "$entry" ]] || continue
		git update-index --chmod=+x -- "$package/$entry"
	done < <(git -C "${srcs[$package]}" ls-tree -r HEAD | awk '$1 == "100755" { sub(/^[^\t]*\t/, ""); print }')
done

# 上游编译 CI 会对下面这些目录里的文件强制 755，再做 git diff --exit-code 校验。
# 同步时就地对齐，否则每次同步后的编译都会卡在「验证软件包文件权限」。
for package in "${mapped[@]}"; do
	for sub in root/bin root/sbin root/usr/bin root/usr/sbin root/usr/libexec \
		root/etc/hotplug.d root/etc/init.d root/etc/uci-defaults; do
		[[ -d "$package/$sub" ]] || continue
		while IFS= read -r file; do
			git update-index --chmod=+x -- "$file"
		done < <(find "$package/$sub" -type f)
	done
done

if git diff --cached --quiet; then
	printf '源仓库无变化，不产生提交。\n'
	exit 0
fi

names="$(printf '%s、' "${mapped[@]}")"
names="${names%、}"
git commit --quiet -m "chore: 同步自研插件 ${names}"
guard

for attempt in 1 2 3; do
	git pull --quiet --rebase origin "$BRANCH" || die "rebase 失败，请人工处理"
	guard
	if git push --quiet origin "HEAD:$BRANCH"; then
		break
	fi
	(( attempt < 3 )) || die "推送连续失败三次，请人工处理"
	sleep 5
done

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
	{
		printf '### 插件同步\n\n| 目录 | 上游提交 | 来源 |\n| --- | --- | --- |\n'
		for record in "${summary[@]}"; do
			IFS=$'\t' read -r d s u <<< "$record"
			printf '| `%s` | `%s` | %s |\n' "$d" "$s" "$u"
		done
	} >> "$GITHUB_STEP_SUMMARY"
fi
