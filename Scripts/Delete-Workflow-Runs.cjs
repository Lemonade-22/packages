// SPDX-License-Identifier: MIT
// Deletes completed runs and their logs/artifacts; preserves releases and caches.
// Snapshot all pages before deletion so removing runs cannot shift pagination.
module.exports = async ({ github, context, core }) => {
  const { owner, repo } = context.repo;
  // No status/search filters: those impose a 1,000-result search limit.
  const runs = await github.paginate(github.rest.actions.listWorkflowRunsForRepo, {
    owner, repo, per_page: 100
  });
  const counts = { deleted: 0, unavailable: 0, skipped: 0, failed: 0 };
  const seen = new Set();
  for (const run of runs) {
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    if (String(run.id) === String(context.runId) || run.status !== 'completed') {
      counts.skipped++;
      continue;
    }
    try {
      // A completed run may have been re-run since the listing was captured.
      const { data: latest } = await github.rest.actions.getWorkflowRun({
        owner, repo, run_id: run.id
      });
      if (latest.status !== 'completed') {
        counts.skipped++;
        continue;
      }
      await github.rest.actions.deleteWorkflowRun({ owner, repo, run_id: run.id });
      counts.deleted++;
      core.info('Deleted workflow run ' + run.id);
    } catch (error) {
      if (error.status === 404 || error.status === 410) {
        counts.unavailable++;
        core.info('Workflow run unavailable: ' + run.id);
      } else {
        counts.failed++;
        core.error('Could not delete workflow run ' + run.id + ': ' + error.message);
        // Stop on authentication or rate-limit errors instead of flooding the API.
        if ([401, 403, 429].includes(error.status)) break;
      }
    }
  }
  await core.summary
    .addHeading('Workflow 运行历史清理结果')
    .addTable([
      [{ data: '项目', header: true }, { data: '数量', header: true }],
      ['已删除运行记录（含日志和 Artifacts）', String(counts.deleted)],
      ['运行记录已不存在或不可用', String(counts.unavailable)],
      ['跳过当前清理任务及未完成任务', String(counts.skipped)],
      ['删除失败', String(counts.failed)]
    ])
    .addRaw('\n已完成的运行记录、日志和 Artifacts 会一并删除；Releases 和缓存保留。当前清理任务及未完成任务不会删除。\n')
    .write();
  if (counts.failed) core.setFailed('部分运行记录未能删除，请查看错误信息后重试。');
  return counts;
};
