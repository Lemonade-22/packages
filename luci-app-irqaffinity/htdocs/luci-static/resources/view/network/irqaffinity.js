'use strict';
'require base';
'require view';
'require dom';
'require ui';
'require rpc';
'require poll';

// Keep in sync with PKG_VERSION in the package Makefile. Shown on the page so
// it is always obvious which build the browser actually loaded (stale caches
// otherwise give very confusing bug reports).
const APP_VERSION = '0.1.0';

/* ------------------------------------------------------------------ i18n ---
 * Source language is Simplified Chinese. po/en/luci-app-irqaffinity.po is the
 * translation source; this map mirrors it so a standalone app still renders
 * English when the browser asks for it (LuCI's per-app i18n domain is not
 * guaranteed to be loaded here). When adding a string, add it to BOTH.
 */
const EN_MAP = {
  '中断绑核': 'IRQ affinity',
  '网卡中断绑定到指定 CPU 核心': 'Pin NIC interrupt handling to specific CPU cores',
  '本机构核心拓扑': 'Local core topology',
  '性能核': 'Performance cores',
  '能效核': 'Efficiency cores',
  '未识别': 'Unclassified',
  '同构核心：本机所有核心同一类型，无需区分，均摊即可。': 'Homogeneous CPU: every core is the same type, so just spread queues evenly.',
  '识别依据': 'Detection basis',
  '选择指引': 'How to choose',
  '网口': 'Interface',
  '中断号': 'IRQ',
  '中断名称': 'Interrupt',
  '来源': 'Source',
  '当前核心': 'Current cores',
  '当前掩码': 'Mask',
  '绑定到': 'Bind to',
  '操作': 'Action',
  '应用': 'Apply',
  '保存': 'Save',
  '删除保存': 'Forget saved',
  '刷新': 'Refresh',
  '自动刷新': 'Auto refresh',
  '该网口没有识别到队列中断': 'no queue interrupts detected',
  '至少选择一个核心（掩码全 0 无效）': 'Select at least one core (an all-zero mask is invalid)',
  '核心编号超过 63，后端不接受': 'Core index above 63 is rejected by the backend',
  '已应用': 'Applied',
  '已保存，开机重放': 'Saved; replayed at boot',
  '已删除保存项': 'Saved rule removed',
  '读取失败': 'Read failed',
  '个中断': 'interrupts',
  '个核心': 'cores'
};

const GUIDE_LINES = [
  '单条流始终只由一个核心处理：绑核换来的是确定性和更低的抖动，不会提高单流峰值带宽。',
  '转发中断优先绑性能核（P 核 / A72 / A76 一类）；把收包中断压到能效核，会在高负载时放大延迟抖动。',
  '能效核留给后台服务、日志、DNS 一类低优先级负载，别和网口中断抢同一个核。',
  '多队列网卡（来源 msi）应把各队列分散到不同性能核；单队列平台（来源 platform）只有一个中断，选一串核没有意义。',
  '不要把网口中断和无线驱动中断绑到同一个核，除非你确认那个核有余量。',
  '全 0 掩码无效，内核会直接拒绝，至少选一个核心。'
];
const GUIDE_HT = '超线程兄弟核（如 0 与 8）共享同一物理核的执行单元：把两条高流量队列分别绑到兄弟核，约等于绑到同一个核，不能当成两份算力。';
const GUIDE_BIG = '大核数量很少的芯片（如 RK3399 只有 2 个 A72）优先把队列落在大核上，不要为了摊平而摊到 A53。';

function localeIsEn() {
  var l = (document.documentElement.getAttribute('lang') || navigator.language || 'zh');
  return String(l).slice(0, 2) === 'en';
}
function T(s) { return localeIsEn() ? (EN_MAP[s] || s) : s; }

/* ------------------------------------------------------------------- rpc --- */
const callList = rpc.declare({
  object: 'irqaffinity', type: 'list', expect: { ok: true }
});
const callApply = rpc.declare({
  object: 'irqaffinity', type: 'apply',
  params: [ 'mode', 'irq', 'iface', 'mask' ], expect: { ok: true }
});
const callSave = rpc.declare({
  object: 'irqaffinity', type: 'save',
  params: [ 'iface', 'mask' ], expect: { ok: true }
});
const callForget = rpc.declare({
  object: 'irqaffinity', type: 'delete',
  params: [ 'iface' ], expect: { ok: true }
});

/* core list -> hex mask, no BigInt (nibble table, backend caps at 16 chars) */
function coresToMask(cores) {
  if (!cores.length) return null;
  var max = Math.max.apply(null, cores);
  if (max > 63) return null;
  var nib = [], i;
  for (i = 0; i < 16; i++) nib[i] = 0;
  for (i = 0; i < cores.length; i++)
    nib[Math.floor(cores[i] / 4)] |= (1 << (cores[i] % 4));
  var s = '';
  for (i = 15; i >= 0; i--) s += nib[i].toString(16);
  s = s.replace(/^0+/, '');
  return s.length ? s : null;
}

function fmtFreq(khz) {
  var n = parseInt(khz, 10);
  return (isNaN(n) || n <= 0) ? '' : String(Math.round(n / 100) / 10) + ' MHz';
}

const CLASS_LABEL = { performance: '性能核', efficiency: '能效核', unknown: '未识别' };
const CLASS_BADGE = { performance: 'success', efficiency: 'warning', unknown: 'neutral' };

/* shared page state, so the refresh path has somewhere to live */
var page = { data: null, mount: null, auto: false };

/* ---------------------------------------------------------------- topology */
function renderTopology(cpu) {
  var groups = { performance: [], efficiency: [], unknown: [] };
  cpu.forEach(function(c) { (groups[c.class] || groups.unknown).push(c); });

  var homogeneous = !(groups.performance.length && groups.efficiency.length);
  var boxes = [];

  [ 'performance', 'efficiency', 'unknown' ].forEach(function(k) {
    if (!groups[k].length) return;
    var chips = groups[k].map(function(c) {
      var bits = [];
      if (c.model) bits.push(c.model);
      if (c.freq) bits.push(fmtFreq(c.freq));
      if (c.sibling && c.sibling !== String(c.id)) bits.push('HT ' + c.sibling);
      return dom('span', {
        'class': 'badge ' + CLASS_BADGE[k],
        title: T('识别依据') + ': ' + c.how
      }, '#' + c.id + (bits.length ? ' · ' + bits.join(' / ') : ''));
    });
    boxes.push(dom('div', { style: 'margin:.3em 0' },
      [ dom('strong', {}, T(CLASS_LABEL[k]) + ' (' + groups[k].length + T('个核心') + '): '), ' ' ].concat(chips)));
  });

  if (homogeneous)
    boxes.push(dom('div', { class: 'alert-message warning' },
      T('同构核心：本机所有核心同一类型，无需区分，均摊即可。')));

  return dom('div', {}, [ dom('h3', {}, T('本机构核心拓扑')) ].concat(boxes));
}

/* ---------------------------------------------------------------- guidance */
function renderGuide(cpu) {
  var hasHT = cpu.some(function(c) { return c.sibling && c.sibling !== String(c.id); });
  var mixed = cpu.some(function(c) { return c.class === 'performance' }) &&
              cpu.some(function(c) { return c.class === 'efficiency' });
  var lines = GUIDE_LINES.slice();
  if (hasHT) lines.push(GUIDE_HT);
  if (mixed) lines.push(GUIDE_BIG);

  return dom('div', {}, [
    dom('h3', {}, T('选择指引')),
    dom('ul', {}, lines.map(function(s) { return dom('li', {}, T(s)); }))
  ]);
}

/* ------------------------------------------------------------------- table */
function renderIfaceTable(data) {
  var rows = [];

  data.ifaces.forEach(function(iface) {
    rows.push(dom('tr', { class: 'thead' },
      dom('td', { colspan: '7' },
        dom('strong', {}, iface.iface + ' (' + iface.irqs.length + ' ' + T('个中断') + ')'))));

    if (!iface.irqs.length) {
      rows.push(dom('tr', {}, dom('td', { colspan: '7' },
        dom('em', {}, T('该网口没有识别到队列中断')))));
      return;
    }

    iface.irqs.forEach(function(irq) {
      var chips = data.cpu.map(function(c) {
        var b = dom('button', {
          'class': 'btn btn-mini cbi-button-neutral',
          'data-core': String(c.id),
          style: 'margin:1px'
        }, '#' + c.id);
        b.addEventListener('click', function(ev) {
          ev.preventDefault();
          var on = b.className.indexOf('cbi-button-apply') >= 0;
          b.className = 'btn btn-mini ' + (on ? 'cbi-button-neutral' : 'cbi-button-apply');
        });
        return b;
      });

      function selected() {
        var out = [];
        chips.forEach(function(b) {
          if (b.className.indexOf('cbi-button-apply') >= 0)
            out.push(parseInt(b.getAttribute('data-core'), 10));
        });
        return out;
      }

      var hint = dom('span', { class: 'small' }, '');
      function flash(msg, good) {
        hint.className = 'small ' + (good ? 'text-success' : 'text-danger');
        hint.textContent = msg;
      }

      function pickMask() {
        var cs = selected();
        if (!cs.length) { flash(T('至少选择一个核心（掩码全 0 无效）'), false); return null; }
        var m = coresToMask(cs);
        if (m === null) { flash(T('核心编号超过 63，后端不接受'), false); return null; }
        return m;
      }

      var btnApply = dom('button', { class: 'btn cbi-button-apply' }, T('应用'));
      btnApply.addEventListener('click', function(ev) {
        ev.preventDefault();
        var mask = pickMask();
        if (mask === null) return;
        btnApply.classList.add('btn-loading');
        callApply('irq', String(irq.irq), '-', mask).then(function(res) {
          if (res && res.ok) { flash(T('已应用') + ' #' + irq.irq + ' → ' + mask, true); reload(); }
          else flash((res && res.error) || T('读取失败'), false);
        }).catch(function(e) { flash(String(e), false); })
          .then(function() { btnApply.classList.remove('btn-loading'); });
      });

      var btnSave = dom('button', { class: 'btn cbi-button-save' }, T('保存'));
      btnSave.addEventListener('click', function(ev) {
        ev.preventDefault();
        var mask = pickMask();
        if (mask === null) return;
        callSave(iface.iface, mask).then(function(res) {
          if (res && res.ok) flash(T('已保存，开机重放') + ' ' + iface.iface + ' → ' + mask, true);
          else flash((res && res.error) || T('读取失败'), false);
        }).catch(function(e) { flash(String(e), false); });
      });

      var btnForget = dom('button', { class: 'btn cbi-button-reset' }, T('删除保存'));
      if (!irq.saved) btnForget.style.display = 'none';
      btnForget.addEventListener('click', function(ev) {
        ev.preventDefault();
        callForget(iface.iface).then(function(res) {
          if (res && res.ok) { flash(T('已删除保存项'), true); reload(); }
          else flash((res && res.error) || T('读取失败'), false);
        }).catch(function(e) { flash(String(e), false); });
      });

      var maskCell = [ dom('code', {}, irq.mask) ];
      if (irq.saved) { maskCell.push(' / '); maskCell.push(dom('code', {}, irq.saved)); }

      rows.push(dom('tr', {}, [
        dom('td', { 'class': 'left' }, iface.iface),
        dom('td', {}, irq.irq),
        dom('td', {}, [ irq.name, dom('br'), dom('small', {}, irq.source) ]),
        dom('td', {}, irq.cpus || '—'),
        dom('td', {}, maskCell),
        dom('td', {}, chips),
        dom('td', {}, [ btnApply, ' ', btnSave, ' ', btnForget, dom('br'), hint ])
      ]));
    });
  });

  return dom('div', { class: 'table-wrapper' },
    dom('table', { class: 'table' }, [
      dom('tr', { class: 'thead' }, [
        dom('th', { class: 'left' }, T('网口')),
        dom('th', {}, T('中断号')),
        dom('th', {}, T('中断名称')),
        dom('th', {}, T('当前核心')),
        dom('th', {}, T('当前掩码')),
        dom('th', {}, T('绑定到')),
        dom('th', {}, T('操作'))
      ])
    ].concat(rows)));
}

/* ------------------------------------------------------------------ render */
function paint() {
  if (!page.mount || !page.data) return;
  page.mount.innerHTML = '';
  page.mount.appendChild(renderTopology(page.data.cpu));
  page.mount.appendChild(renderGuide(page.data.cpu));
  page.mount.appendChild(renderIfaceTable(page.data));
}

function reload() {
  return callList().then(function(res) {
    if (!res || !res.ok) {
      if (page.mount) {
        page.mount.innerHTML = '';
        page.mount.appendChild(dom('div', { class: 'alert-message error' },
          T('读取失败') + ': ' + String((res && res.error) || 'rpc failed')));
      }
      return;
    }
    page.data = res;
    paint();
  }).catch(function(e) {
    if (page.mount) {
      page.mount.innerHTML = '';
      page.mount.appendChild(dom('div', { class: 'alert-message error' },
        T('读取失败') + ': ' + String(e)));
    }
  });
}

/* -------------------------------------------------------------------- view */
return view.extend({
  render: function() {
    var auto = dom('input', { type: 'checkbox', id: 'irqauto' });
    auto.addEventListener('change', function() {
      page.auto = !!auto.checked;
      if (page.auto) { poll.add(reload); poll.start(5); }
      else poll.stop();
    });

    var btnRefresh = dom('button', { class: 'btn cbi-button-refresh' }, T('刷新'));
    btnRefresh.addEventListener('click', function(ev) { ev.preventDefault(); reload(); });

    page.mount = dom('div', {}, dom('p', { class: 'loading' }, '…'));

    return dom('div', { class: 'cbi-value' }, [
      dom('h3', {}, T('中断绑核') + ' v' + APP_VERSION),
      dom('div', { class: 'cbi-value-field', style: 'margin-bottom:.6em' }, [
        btnRefresh, '  ', auto, ' ', dom('label', { for: 'irqauto' }, T('自动刷新'))
      ]),
      dom('p', {}, T('网卡中断绑定到指定 CPU 核心')),
      page.mount
    ]);
  },

  handleSave: function() { return null; },
  handleApply: function() { return null; },

  load: function() { return reload(); }
});
