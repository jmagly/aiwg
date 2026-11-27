/** AIWG guidance: framework dependencies need an explicit runtime check. */
export function hasSdlcDeployment(installed, provider) {
  if (!installed || typeof installed !== 'object' || Array.isArray(installed)) return false;
  return ['sdlc', 'sdlc-complete'].some(id => {
    const deployments = installed[id]?.deployedTo;
    if (!deployments || typeof deployments !== 'object' || Array.isArray(deployments)) return false;
    const candidates = provider ? [deployments[provider]] : Object.values(deployments);
    return candidates.some(record => record && typeof record === 'object'
      && !Array.isArray(record) && record.kernelOnly !== true);
  });
}
