// Format bounded, actionable diagnostics for a refused worker run directory.
export function workerRunDirectoryRefusal(entries) {
  const reason = 'Worker run directory must be fresh, empty, private and owned';
  if (!entries.length) return reason;
  const names = entries.toSorted().slice(0, 5).map(name => JSON.stringify(name)).join(', ');
  const remaining = entries.length > 5 ? ` (+${entries.length - 5} more)` : '';
  return `${reason}. Unexpected entries: ${names}${remaining}. Keep the plan and other files outside the run dir, or pass a new run dir.`;
}
