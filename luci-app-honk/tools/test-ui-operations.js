// Run with node; exercise operation semantics without a browser or router.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'htdocs/luci-static/resources/hk3.js'), 'utf8');
function load(mock) {
 return new Function('baseclass', 'fs', 'poll', 'rpc', 'ui', '_', 'window', source)(
  {extend: x => x}, mock, {}, {declare: () => () => {}}, {}, x => x,
  {setTimeout: fn => { queueMicrotask(fn); return 1; }});
}
(async () => {
 let reads = 0;
 const api = load({exec: async (_, args) => {
  assert.deepEqual(args, ['operation', 'original-id']);
  if (++reads === 1) throw Error('XHR request aborted by browser');
  return {code: 0, stdout: JSON.stringify({status: 'succeeded', result: 'done'})};
 }});
 assert.equal(await api.waitOperation({operation_id: 'original-id'}), 'done');
 assert.equal(reads, 2);
 const failing = load({exec: async () => ({code: 1, stderr: 'cannot start'})});
 await assert.rejects(failing.applyService(), /cannot start/);
 const workerFail = load({exec: async () => ({code: 0}), read: async p => p.endsWith('/status') ? 'failed' : 'validation failed'});
 await assert.rejects(workerFail.applyService(), /validation failed/);
 const nodeSource = fs.readFileSync(path.join(root, 'htdocs/luci-static/resources/view/hk3/node.js'), 'utf8');
 const body = nodeSource.slice(nodeSource.indexOf('function refreshSubscription('), nodeSource.indexOf('/*', nodeSource.indexOf('function refreshSubscription(')));
 let posts = 0;
 const refresh = new Function('hk3', '_', body + '; return refreshSubscription;')({api: async () => { posts++; throw Error('aborted'); }}, x => x);
 await assert.rejects(refresh('provider'), /更新可能已开始/);
 assert.equal(posts, 1);
 console.log('PASS: operation polling retries original ID; apply errors propagate; interrupted subscription POST is not repeated');
})().catch(e => { console.error(e); process.exitCode = 1; });
