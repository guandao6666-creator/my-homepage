/**
 * Guandao OS · D1 备份 Workflow 绑定入口。
 *
 * 具体流程在 d1-backup-run.js（不依赖 cloudflare:workers，便于 Node Mock 测试）。
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import { runD1Backup } from "./d1-backup-run.js";

export class D1BackupWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return runD1Backup({ env: this.env, event, step });
  }
}