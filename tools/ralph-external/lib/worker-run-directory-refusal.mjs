// Format bounded, actionable diagnostics for a refused worker run directory.
export function workerRunDirectoryRefusal(entries) {
  const reason = 'Worker run directory must be fresh, empty, private and owned';
  // An empty but pre-created directory fails on mode or ownership; name the remedy (#2918 40b direct-01).
  if (!entries.length) return `${reason}. Pass a run_dir path that does not exist yet (its parent may be missing); the launcher creates it with mode 0700, so do not pre-create it.`;
  const names = entries.toSorted().slice(0, 5).map(name => JSON.stringify(name)).join(', ');
  const remaining = entries.length > 5 ? ` (+${entries.length - 5} more)` : '';
  return `${reason}. Unexpected entries: ${names}${remaining}. Keep the plan and other files outside the run dir, or pass a new run dir.`;
}
