// Public doctor options and exit-status contract.
export const DOCTOR_HELP = `aiwg doctor — check AIWG installation health

Usage:
  aiwg doctor [options]
  aiwg -doctor [options]
  aiwg --doctor [options]

Options:
  --deployment          Verify configured provider deployments
  --provider <name>     Limit deployment verification to one provider
  --bundle <name>       Limit deployment verification to one bundle
  --scope <scope>       Verification scope: project or user
  --user                Alias for --scope user
  --qualify             With --probe-workers, record installation and configured model/role approval
  --list-approvals      With --probe-workers, list recorded approvals offline (supports --json)
  --forget-approval PATH With --probe-workers --yes, remove approvals for this workspace
  --yes                 Confirm worker qualification or approval removal
  --dry-run             With --probe-workers, preview qualification without writes
  --cli NAME            Limit worker probes, qualification, or approvals to one CLI
  --group <name>        Apply the named group cap (requires --resources)
  --resources           Report live host resources, threshold origins and remaining worker slots (supports --json)
  --decision-offload    Show offline advisory decision readiness, adoption and workspace permission report
  --fix                 With --decision-offload, repair unsafe journal modes and collapsed group masks on non-secret outputs
  --probe-workers       Run bounded worker CLI version probes (default: config-only, no subprocess)
  --project-local       Include project-local artifact diagnostics
  --json                Emit machine-readable output (with --probe-workers: one worker-probe record per CLI; with --deployment: deployment verification; with --decision-offload: offline snapshot; with --resources: host capacity)
  --verbose, -v         Include verbose diagnostics
  --help, -h            Show this help

Exit status:
  0  Checks completed; ordinary doctor warnings are advisory.
  1  Diagnostic errors, failed or partial explicit worker qualification, or blocked recorded invocations.
  2  Invalid usage.
  --resources exits 1 when slots are zero.
  --qualify uses the same exit status in text and JSON output.
`;
