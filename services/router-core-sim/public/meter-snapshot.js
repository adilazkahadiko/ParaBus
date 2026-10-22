// Meter packets never replace configuration, identities or diagnostic histories.
export function mergeMeterSnapshot(current, meters) {
  if (!current || meters.revision < current.revision) return current;
  const mergeRows = (rows, updates, key = "id") => {
    const byId = new Map(updates.map(row => [row[key], row]));
    return rows.map(row => ({ ...row, ...byId.get(row[key]) }));
  };
  return {
    ...current, ...meters,
    channels: mergeRows(current.channels, meters.channels),
    buses: mergeRows(current.buses, meters.buses),
    output: current.output ? { ...current.output, ...meters.output } : current.output,
    cueOutput: current.cueOutput ? { ...current.cueOutput, ...meters.cueOutput } : current.cueOutput,
    discord: current.discord ? { ...current.discord, txStems: mergeRows(current.discord.txStems ?? [], meters.txMeters ?? [], "profileId") } : current.discord,
  };
}
