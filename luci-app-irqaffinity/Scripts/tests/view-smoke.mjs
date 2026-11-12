
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const SRC = fs.readFileSync(process.argv[2], 'utf8');

// ---- minimal DOM/LuCI stubs --------------------------------------------
class N {
  constructor(tag, attrs, kids) {
    this.tagName = tag; this.style = {}; this.attrs = {}; this.children = []; this.handlers = {};
    this.className = ''; this.textContent = '';
    if (attrs) for (const k in attrs) this.setAttribute(k, attrs[k]);
    if (this.attrs['class']) this.className = this.attrs['class'];
    if (kids != null) this.append(kids);
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  append(x) {
    if (Array.isArray(x)) x.forEach(e => this.append(e));
    else if (x != null && x !== false && x !== '') this.children.push(x instanceof N ? x : Object.assign(new N('#text'), { textContent: String(x) }));
  }
  addEventListener(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); }
  click() { (this.handlers.click || []).forEach(fn => fn({ preventDefault(){} })); }
  appendChild(n) { this.children.push(n); return n; }
  set innerHTML(v) { if (v === '') this.children = []; }
  get innerHTML() { return ''; }
  set classList(v) {}
  get classList() { const self = this; return {
    add: c => { if (self.className.indexOf(c) < 0) self.className += ' ' + c; },
    remove: c => { self.className = self.className.split(' ').filter(x => x !== c).join(' '); },
    contains: c => self.className.indexOf(c) >= 0 }; }
  text(s) { this.textContent = s; }
}
const dom = (tag, attrs, kids) => new N(tag, attrs, kids);
// text passthrough
const _orig = dom;
function domx(tag, attrs, kids){ const n = _orig(tag, attrs, null); n.append(kids); return n; }

const document = { documentElement: { getAttribute: () => 'zh-CN' } };
const navigator = { language: 'zh-CN' };
const base = {};
const ui = {};
let declared = {};
const rpc = { declare(spec){ const f = (...a) => { f.lastArgs = a; return Promise.resolve(f._resp || {}); }; f.spec = spec; f._resp = null; f.lastArgs = null; declared[spec.type] = f; return f; } };
const poll = { add(){}, start(){}, stop(){} };
const view = { extend(o){ return o; } };

function load() {
  const fn = new Function('document','navigator','dom','base','ui','rpc','poll','view', SRC);
  return fn(document, navigator, domx, base, ui, rpc, poll, view);
}

let fail = 0;
function ok(name, cond, extra){ if (cond) console.log('ok   ' + name); else { console.log('FAIL ' + name + (extra?'  '+extra:'')); fail++; } }

// ---- coresToMask, extracted verbatim from the shipped file
const maskSrc = SRC.match(/function coresToMask[\s\S]*?\n}/)[0];
const coresToMask = new Function(maskSrc + '; return coresToMask;')();
const cases = [
  [[0], '1'], [[1], '2'], [[0,1], '3'], [[3], '8'], [[0,2], '5'],
  [[0,1,2,3], 'f'], [[4,5,6,7], 'f0'], [[31], '80000000'],
  [[32], '100000000'], [[63], '8000000000000000'], [[0,63], '8000000000000001'],
  [[], null], [[64], null], [[0,64], null]
];
cases.forEach(([in_, want]) => {
  const got = coresToMask(in_);
  ok('coresToMask ' + JSON.stringify(in_) + ' -> ' + got, got === want, 'want ' + want);
});

// ---- render with an RK3588-ish dataset
const RK = { ok: true, cpus: 8, cpu: [
  {id:0,class:'performance',cap:'',freq:'2400000',sibling:'0',model:'cortex-a76',how:'devicetree'},
  {id:1,class:'performance',cap:'',freq:'2400000',sibling:'1',model:'cortex-a76',how:'devicetree'},
  {id:2,class:'performance',cap:'',freq:'2400000',sibling:'2',model:'cortex-a76',how:'devicetree'},
  {id:3,class:'performance',cap:'',freq:'2400000',sibling:'3',model:'cortex-a76',how:'devicetree'},
  {id:4,class:'efficiency',cap:'',freq:'1800000',sibling:'4',model:'cortex-a55',how:'devicetree'},
  {id:5,class:'efficiency',cap:'',freq:'1800000',sibling:'5',model:'cortex-a55',how:'devicetree'},
  {id:6,class:'efficiency',cap:'',freq:'1800000',sibling:'6',model:'cortex-a55',how:'devicetree'},
  {id:7,class:'efficiency',cap:'',freq:'1800000',sibling:'7',model:'cortex-a55',how:'devicetree'}
], ifaces: [
  {iface:'eth0', irqs:[
    {irq:'42',name:'eth0-TX0',source:'msi',mask:'01',cpus:'0',saved:'2'},
    {irq:'43',name:'eth0-RX0',source:'msi',mask:'02',cpus:'1',saved:''}]},
  {iface:'lo', irqs:[]}
]};

const v = load();
ok('view exposes render/load', typeof v.render === 'function' && typeof v.load === 'function');

let root;
try { root = v.render(); ok('render() did not throw', true); }
catch(e){ ok('render() did not throw', false, e.stack.split('\n').slice(0,2).join(' | ')); }

try { declared.list._resp = RK; await v.load(); ok('load() with RK3588 data did not throw', true); }
catch(e){ ok('load() with RK3588 data did not throw', false, e.stack.split('\n').slice(0,3).join(' | ')); }

// find the mount node: last child of the returned container
const mount = root.children[root.children.length - 1];
function walk(n, acc){ if (n instanceof N) { n.children.forEach(c => walk(c, acc)); if (typeof n.textContent === 'string' && n.textContent) acc.push(n.textContent); if (typeof n.attrs === 'object' && n.attrs['data-core']) acc.push('CORE' + n.attrs['data-core']); } return acc; }
const texts = walk(mount, []);
const all = texts.join(' ');
ok('topology shows both clusters', all.includes('性能核') && all.includes('能效核'));
ok('topology names the cores', all.includes('cortex-a76') && all.includes('cortex-a55'));
ok('no homogeneous warning when mixed', !all.includes('同构核心'));
ok('guidance rendered', all.includes('单条流始终只由一个核心处理'));
ok('irq rows rendered', all.includes('42') && all.includes('eth0-TX0'));
ok('one core chip per cpu per irq row', (all.match(/CORE/g)||[]).length === 16, String((all.match(/CORE/g)||[]).length));
ok('saved mask visible', all.includes('01') && all.includes('2'));

// click chip #4 on first row -> apply -> assert rpc payload
const firstRowChips = [];
(function find(n){ if (n instanceof N) { if (n.attrs && n.attrs['data-core'] && firstRowChips.length < 9) firstRowChips.push(n); n.children.forEach(find); } })(mount);
const chip4 = firstRowChips.find(c => c.attrs['data-core'] === '4');
chip4.click();
ok('chip toggles to active', chip4.className.includes('cbi-button-apply'));

const applyBtn = (() => { let out; (function f(n){ if(out) return; if (n instanceof N) { if (n.className && n.className.includes('cbi-button-apply') && n.children.some(c => c.textContent === '应用')) { out = n; return; } n.children.forEach(f); } })(mount); return out; })();
ok('apply button found', !!applyBtn);
declared.apply._resp = { ok: true, applied: 1 };
declared.list._resp = RK;
try { applyBtn.click(); } catch(e) { ok('apply click', false, e.message); }
await new Promise(r => setTimeout(r, 30));
declared.apply._resp = { ok: true };
declared.apply.lastArgs = null;
applyBtn.click();
await new Promise(r => setTimeout(r, 30));
ok('apply sends mode=irq, irq=42, mask=10 (core4)',
   JSON.stringify(declared.apply.lastArgs) === JSON.stringify(['irq','42','-','10']),
   JSON.stringify(declared.apply.lastArgs));

// no selection -> must warn, no rpc
declared.apply.lastArgs = null;
const plainRow = (() => { let out; (function f(n){ if(out) return; if (n instanceof N) { if (n.className && n.className.includes('cbi-button-apply') && n.children.some(c => c.textContent === '应用')) { out = n; return; } n.children.forEach(f); } })(mount); return out; })();
// reset chip4 selection then press apply with nothing selected
chip4.className = 'btn btn-mini cbi-button-neutral';
plainRow.children.forEach(c => { if (c.attrs && c.attrs['data-core']) c.className = 'btn btn-mini cbi-button-neutral'; });
declared.apply.lastArgs = null;
try { plainRow.click(); } catch(e){}
await new Promise(r => setTimeout(r, 20));
ok('empty selection does not reach rpc', declared.apply.lastArgs === null, JSON.stringify(declared.apply.lastArgs));

// Intel-ish dataset with HT siblings + all-same-freq edge case
const INTEL = { ok:true, cpus:20, cpu: Array.from({length:20},(_,i)=>({
    id:i, class:i<16?'performance':'efficiency', cap:'', freq:i<16?'5200000':'3900000',
    sibling: i<16 ? (i)+','+(i+16>19?i:i) : String(i), model:'', how:'freq'
  })), ifaces:[{iface:'eth0',irqs:[{irq:'120',name:'igb',source:'msi',mask:'1',cpus:'0',saved:''}]}] };
try { declared.list._resp = INTEL; await v.load(); ok('Intel-like dataset renders', true); }
catch(e){ ok('Intel-like dataset renders', false, e.message); }
const t2 = walk(root.children[root.children.length-1], []).join(' ');
ok('HT guidance appears when siblings present', t2.includes('超线程兄弟核'));

// homogeneous box -> warning shown
const HOMO = { ok:true, cpus:4, cpu: Array.from({length:4},(_,i)=>({id:i,class:'performance',cap:'',freq:'1500000',sibling:String(i),model:'cortex-a55',how:'devicetree'})), ifaces:[] };
declared.list._resp = HOMO; await v.load();
const t3 = walk(root.children[root.children.length-1], []).join(' ');
ok('homogeneous warning shown when no efficiency cores', t3.includes('同构核心'));

// error path
declared.list._resp = { ok:false, error:'permission denied' };
await v.load();
const t4 = walk(root.children[root.children.length-1], []).join(' ');
ok('rpc error surfaces on page', t4.includes('permission denied'));

console.log('---');
console.log(fail ? fail + ' FAILED' : 'ALL PASS');
process.exit(fail ? 1 : 0);
