import { formatBytes } from "../convert/report.js";
import type { BundleSummary, MigrationFileResult, ProjectAssessment } from "../migration/types.js";

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function formatAssessment(assessment: ProjectAssessment): string {
  const lines: string[] = [];
  lines.push(
    `Pentaho project "${assessment.projectName}": readiness ${assessment.readiness.score}/100 (${assessment.readiness.level}).`,
  );
  lines.push(assessment.readiness.summary);
  lines.push(
    `${plural(assessment.totals.files, "file")}, ${plural(assessment.totals.transformations, "transformation")}, ${plural(assessment.totals.jobs, "job")}, ${plural(assessment.totals.steps, "step")}, ${plural(assessment.totals.jobEntries, "job entry", "job entries")}.`,
  );
  lines.push(
    `Step types: ${assessment.totals.supportedStepTypes} automatic, ${assessment.totals.partialStepTypes} partial, ${assessment.totals.unsupportedStepTypes} manual.`,
  );
  if (assessment.partialSteps.length > 0) {
    const sample = assessment.partialSteps
      .slice(0, 5)
      .map((step) => `${step.step} (${step.type})`)
      .join(", ");
    lines.push(
      `Partial steps needing review: ${sample}${assessment.partialSteps.length > 5 ? ", ..." : ""}.`,
    );
  }
  if (assessment.unsupportedSteps.length > 0) {
    const sample = assessment.unsupportedSteps
      .slice(0, 5)
      .map((step) => `${step.step} (${step.type})`)
      .join(", ");
    lines.push(
      `Manual steps that must be rewritten: ${sample}${assessment.unsupportedSteps.length > 5 ? ", ..." : ""}.`,
    );
  }
  if (assessment.connections.length > 0) {
    lines.push(
      `JDBC connections: ${assessment.connections.map((connection) => `${connection.name} (${connection.type})`).join(", ")}. Passwords from the source were not included.`,
    );
  }
  if (assessment.schedules.length > 0) {
    lines.push(
      `Schedules: ${assessment.schedules.map((schedule) => `${schedule.job}/${schedule.entry}: ${schedule.expression ?? schedule.description}`).join("; ")}.`,
    );
  }
  const risks = assessment.risks.filter((risk) => risk.severity !== "info").slice(0, 6);
  if (risks.length > 0) {
    lines.push("Top risks:");
    for (const risk of risks) lines.push(`- [${risk.severity}] ${risk.message}`);
  }
  if (assessment.questions.length > 0) {
    lines.push("Open questions:");
    for (const question of assessment.questions.slice(0, 5)) lines.push(`- ${question}`);
  }
  lines.push(
    "Call generate_aws_migration with the same files to write the Glue scripts, Step Functions definitions and CloudFormation template.",
  );
  return lines.join("\n");
}

export function formatBundleSummary(summary: BundleSummary): string {
  const lines: string[] = [];
  lines.push(
    `Generated bundle ${summary.bundle_id} for "${summary.project_name}" (${summary.generated_with}).`,
  );
  lines.push(
    `Readiness ${summary.readiness.score}/100 (${summary.readiness.level}). ${summary.readiness.summary}`,
  );
  if (summary.download_url) {
    lines.push(
      `ZIP download: ${summary.download_url}${summary.download_expires_at ? ` (expires ${summary.download_expires_at})` : ""}`,
    );
  } else {
    lines.push(
      `No download link is configured. Read individual files with get_migration_file using bundle_id ${summary.bundle_id}.`,
    );
  }
  lines.push(`${plural(summary.files.length, "generated file")}.`);
  if (summary.jobs.length > 0) {
    lines.push("Glue jobs:");
    for (const job of summary.jobs) {
      lines.push(
        `- ${job.glue_job_name} from ${job.transformation}: ${job.automatic_steps.length} automatic, ${job.partial_steps.length} partial, ${job.manual_steps.length} manual step types; script ${job.script_path}.`,
      );
    }
  }
  if (summary.sql_runner) {
    lines.push(
      `- SQL runner ${summary.sql_runner.name}: ${plural(summary.sql_runner.entries, "SQL job entry", "SQL job entries")}; script ${summary.sql_runner.script_path}.`,
    );
  }
  if (summary.state_machines.length > 0) {
    lines.push("Step Functions state machines:");
    for (const machine of summary.state_machines) {
      lines.push(
        `- ${machine.state_machine_name} for ${machine.job}; definition ${machine.definition_path}; ${plural(machine.schedule_count, "schedule")}.`,
      );
    }
  }
  if (summary.connections.length > 0) {
    lines.push("Secrets to fill after deployment:");
    for (const connection of summary.connections) {
      lines.push(`- ${connection.secret_name} for ${connection.name} (${connection.jdbc_url}).`);
    }
  }
  const problems = summary.warnings.slice(0, 8);
  if (problems.length > 0) {
    lines.push(`Warnings (${summary.warnings.length}):`);
    for (const warning of problems) lines.push(`- ${warning}`);
  }
  if (summary.next_steps.length > 0) {
    lines.push("Next steps:");
    for (const step of summary.next_steps) lines.push(`- ${step}`);
  }
  lines.push(
    `Use get_migration_file with bundle_id ${summary.bundle_id} to read migration-report.md, README.md or any generated script.`,
  );
  return lines.join("\n");
}

export function formatMigrationFile(result: MigrationFileResult, remainingBytes: number): string {
  const header = `${result.path} (${result.kind}, ${formatBytes(result.bytes)}, sha256 ${result.sha256.slice(0, 16)}${result.truncated ? `, showing the first ${formatBytes(remainingBytes)}` : ""})`;
  return [header, "", result.content].join("\n");
}
