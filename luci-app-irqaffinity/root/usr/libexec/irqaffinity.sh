#!/bin/sh
# luci-app-irqaffinity helper. Runs as root via rpcd (and from the init script).
#
# SECURITY: every externally supplied value is validated before it touches a
# path or a file. Do not relax these checks without thinking.
#
# Heterogeneous CPU detection (Intel 12-14th gen P/E, RK3399 A72+A53,
# RK3588 A76+A55, other big.LITTLE parts):
#   1. devicetree compatible  (exact, ARM/Rockchip)
#   2. cpu_capacity           (ARM scaling clocks)
#   3. cpufreq max freq       (x86 inference, 92% of max = performance)
# Every core reports "how" so the UI can state the basis of its guess.

umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

US=$(printf '\037')

E() { printf 'jsonEOF%s\n' "$1"; exit 0; }
BAD() { E "{\"ok\":false,\"error\":\"$1\"}"; }

METHOD="$1"

# ---------------------------------------------------------------- validators
strlen() { printf '%s' "$1" | wc -c | tr -d ' '; }

valid_mask() {
	case "$1" in
		''|*[!0-9a-fA-F]*) return 1 ;;
	esac
	[ "$(strlen "$1")" -le 16 ]
}

valid_iface() {
	case "$1" in
		''|*[!a-zA-Z0-9_]*) return 1 ;;
	esac
	[ -e "/sys/class/net/$1" ]
}

valid_irq() {
	case "$1" in
		''|*[!0-9]*) return 1 ;;
	esac
	[ -e "/proc/irq/$1/smp_affinity" ]
}

json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# ------------------------------------------------- heterogeneous core classes
classify_from_model() {
	case "$1" in
		*cortex-a7*|*cortex-x*|*neoverse-n*|*neoverse-v*)
			echo performance ;;
		*cortex-a3*|*cortex-a5*|*cortex-a51*|*cortex-a52*)
			echo efficiency ;;
		*)
			echo unknown ;;
	esac
}

strip_vendor() { printf '%s' "$1" | sed 's/^[a-z0-9]*,//'; }

# Fields are joined by \037 (unit separator, non-whitespace): TAB would be
# collapsed by read's IFS logic whenever cap/freq/model is empty, shifting
# every later column by one. Do not switch this back to a whitespace char.
# --------------------------------------------------------------- cpu inventory
CPU_TABLE=""
NCPU=0
HAS_DT=0

build_cpus() {
	NCPU=0
	while [ "$NCPU" -lt 256 ]; do
		[ -e "/sys/devices/system/cpu/cpu$NCPU" ] || break
		[ -e "/sys/devices/system/cpu/cpu$NCPU/of_node/compatible" ] && HAS_DT=1
		NCPU=$((NCPU+1))
	done

	maxf=0
	if [ "$HAS_DT" = 0 ]; then
		i=0
		while [ "$i" -lt "$NCPU" ]; do
			f=$(awk '{print $1}' "/sys/devices/system/cpu/cpu$i/cpufreq/cpuinfo_max_freq" 2>/dev/null)
			[ -n "$f" ] || continue
			[ "$f" -gt "$maxf" ] 2>/dev/null && maxf="$f"
			i=$((i+1))
		done
	fi

	CPU_TABLE=""
	i=0
	while [ "$i" -lt "$NCPU" ]; do
		d="/sys/devices/system/cpu/cpu$i"
		model=$(tr '\0' ' ' < "$d/of_node/compatible" 2>/dev/null | awk '{print $1}')
		f=$(awk '{print $1}' "$d/cpufreq/cpuinfo_max_freq" 2>/dev/null)
		cap=$(awk '{print $1}' "$d/cpu_capacity" 2>/dev/null)
		sib=$(awk '{print $1}' "$d/topology/thread_siblings_list" 2>/dev/null)
		cls=unknown
		how=none

		if [ -n "$model" ]; then
			cls=$(classify_from_model "$model")
			how=devicetree
		fi

		if [ "$cls" = unknown ] && [ -n "$cap" ] && [ "$cap" -gt 0 ] 2>/dev/null; then
			cls=pendingcap
			how=capacity
		fi

		if [ "$cls" = unknown ] && [ -n "$f" ] && [ "$maxf" -gt 0 ] 2>/dev/null; then
			thr=$(( maxf * 92 / 100 ))
			if [ "$f" -ge "$thr" ]; then cls=performance; else cls=efficiency; fi
			how=freq
		fi

		if [ -n "$CPU_TABLE" ]; then CPU_TABLE="$CPU_TABLE
"; fi
		CPU_TABLE="$CPU_TABLE$i$US$cls$US$cap$US$f$US$sib$US$model$US$how"
		i=$((i+1))
	done
}

# rows -> JSON array; resolves pendingcap against the largest capacity seen
cpu_json() {
	capmax=$(printf '%s\n' "$CPU_TABLE" | while IFS="$US" read -r id cls cap f sib model how; do
		[ "$cls" = pendingcap ] || continue
		[ -n "$cap" ] || continue
		echo "$cap"
	done | sort -n | tail -n 1)
	[ -n "$capmax" ] || capmax=0

	printf '['
	printf '%s\n' "$CPU_TABLE" | while IFS="$US" read -r id cls cap f sib model how; do
		[ -n "$id" ] || continue
		if [ "$cls" = pendingcap ]; then
			thr=$(( capmax * 90 / 100 ))
			if [ "$cap" -ge "$thr" ] 2>/dev/null; then cls=performance; else cls=efficiency; fi
		fi
		m=$(strip_vendor "$model")
		printf ',{"id":%s,"class":"%s","cap":"%s","freq":"%s","sibling":"%s","model":"%s","how":"%s"}' \
			"$id" "$cls" "$cap" "$f" "$(json_escape "$sib")" "$(json_escape "$m")" "$how"
	done | sed 's/^,//'
	printf ']'
}

# ------------------------------------------------------- interrupt inventory
INTERRUPTS_TABLE=""
build_table() {
	INTERRUPTS_TABLE=$(awk -F: '
		$1 ~ /^[ \t]*[0-9]+/ {
			k=$1; gsub(/[ \t]/,"",k);
			nm=$2; sub(/^[ \t]*/,"",nm); sub(/[ \t].*$/,"",nm);
			printf "%s\037%s\n", k, nm
		}' /proc/interrupts 2>/dev/null)
}

iface_irq_list() {
	iface="$1"
	dev="/sys/class/net/$iface/device"

	# PCIe NICs: msi_irqs gives the exact per-queue set, no name guessing.
	if [ -d "$dev/msi_irqs" ]; then
		for i in $(ls "$dev/msi_irqs" 2>/dev/null); do
			case "$i" in ''|*[!0-9]*) continue ;; esac
			[ -e "/proc/irq/$i/smp_affinity" ] || continue
			nm=$(printf '%s\n' "$INTERRUPTS_TABLE" | awk -F"$US" -v I="$i" '$1==I{print $2}')
			[ -n "$nm" ] || nm="$iface"
			printf "%s$US%s$US%s\n" "$i" "$nm" msi
		done
		return 0
	fi

	printf '%s\n' "$INTERRUPTS_TABLE" | while IFS="$US" read -r irq nm; do
		[ -n "$nm" ] || continue
		[ -e "/proc/irq/$irq/smp_affinity" ] || continue
		if [ "$nm" = "$iface" ]; then
			printf "%s$US%s$US%s\n" "$irq" "$nm" platform
			continue
		fi
		b=$(printf '%s' "$nm" | sed -e 's/[-_].*//' -e 's/[0-9]*$//')
		[ -n "$b" ] || continue
		if [ "$b" = "$iface" ]; then
			printf "%s$US%s$US%s\n" "$irq" "$nm" platform
		fi
	done
	return 0
}

mask_of() { awk '{print $1}' "/proc/irq/$1/smp_affinity" 2>/dev/null; }
list_of() { awk '{print $1}' "/proc/irq/$1/smp_affinity_list" 2>/dev/null; }
saved_of() { [ -f "/etc/irqaffinity.d/$1" ] && head -n1 "/etc/irqaffinity.d/$1"; }

write_irq() {
	valid_irq "$1" || return 1
	echo "$2" > "/proc/irq/$1/smp_affinity" 2>/dev/null
}

# ------------------------------------------------------------------ list
iface_json() {
	out=""
	for d in /sys/class/net/*; do
		[ -e "$d" ] || continue
		iface=$(basename "$d")
		valid_iface "$iface" || continue
		rows=""
		while IFS="$US" read -r irq nm src; do
			[ -n "$irq" ] || continue
			mask=$(mask_of "$irq")
			[ -n "$mask" ] || continue
			clist=$(list_of "$irq")
			sv=$(saved_of "$iface")
			[ -n "$rows" ] && rows="$rows,"
			rows="$rows{\"irq\":\"$(json_escape "$irq")\",\"name\":\"$(json_escape "$nm")\",\"source\":\"$src\",\"mask\":\"$(json_escape "$mask")\",\"cpus\":\"$(json_escape "$clist")\",\"saved\":\"$(json_escape "$sv")\"}"
		done <<SEP
$(iface_irq_list "$iface")
SEP
		[ -n "$out" ] && out="$out,"
		out="$out{\"iface\":\"$(json_escape "$iface")\",\"irqs\":[$rows]}"
	done
	printf '%s' "$out"
}

do_list() {
	build_cpus
	ifs=$(iface_json)
	E "{\"ok\":true,\"cpus\":$NCPU,\"cpu\":$(cpu_json),\"ifaces\":[$ifs]}"
}

# ------------------------------------------------------------------ apply
# rpcd param order: mode irq iface mask   (unused slots arrive as "-")
do_apply() {
	mode="$2"; irq="$3"; iface="$4"; mask="$5"
	valid_mask "$mask" || BAD "bad mask"
	case "$mode" in
		irq)
			valid_irq "$irq" || BAD "bad irq"
			write_irq "$irq" "$mask" || BAD "write failed"
			E "{\"ok\":true,\"applied\":1,\"irq\":\"$irq\",\"mask\":\"$mask\"}"
			;;
		iface)
			valid_iface "$iface" || BAD "bad iface"
			build_table
			n=0
			while IFS="$US" read -r i nm src; do
				[ -n "$i" ] || continue
				write_irq "$i" "$mask" && n=$((n+1))
			done <<SEP
$(iface_irq_list "$iface")
SEP
			[ "$n" -gt 0 ] || BAD "no irqs found for $iface"
			E "{\"ok\":true,\"applied\":$n,\"iface\":\"$iface\",\"mask\":\"$mask\"}"
			;;
		*)
			BAD "bad mode"
			;;
	esac
}

# ------------------------------------------------------------------ save
do_save() {
	iface="$2"; mask="$3"
	valid_iface "$iface" || BAD "bad iface"
	valid_mask "$mask" || BAD "bad mask"
	mkdir -p /etc/irqaffinity.d
	echo "$mask" > "/etc/irqaffinity.d/$iface"
	E "{\"ok\":true,\"saved\":\"$iface\",\"mask\":\"$mask\"}"
}

do_delete() {
	iface="$2"
	valid_iface "$iface" || BAD "bad iface"
	rm -f "/etc/irqaffinity.d/$iface"
	E "{\"ok\":true,\"deleted\":\"$iface\"}"
}

# ---------------------------------------------------------- apply_saved (boot)
do_apply_saved() {
	. /lib/functions.sh 2>/dev/null || exit 0
	enabled=$(uci -q get irqaffinity.@settings[0].enabled)
	[ "$enabled" = 0 ] && exit 0
	build_table

	apply_rule() {
		local cfg="$1" iface mask n i nm src
		config_get iface "$cfg" iface
		config_get mask "$cfg" mask
		valid_iface "$iface" || return 0
		valid_mask "$mask" || return 0
		n=0
		while IFS="$US" read -r i nm src; do
			[ -n "$i" ] || continue
			write_irq "$i" "$mask" && n=$((n+1))
		done <<SEP
$(iface_irq_list "$iface")
SEP
		echo "irqaffinity: $iface -> $mask ($n irqs)"
	}
	config_load irqaffinity
	config_foreach apply_rule rule
}

case "$METHOD" in
	list)         do_list ;;
	apply)        do_apply "$@" ;;
	save)         do_save "$@" ;;
	delete)       do_delete "$@" ;;
	apply_saved)  do_apply_saved ;;
	*)            BAD "usage: list|apply|save|delete|apply_saved" ;;
esac
