/** Display-only text shared by state and scene previews; never used as a target ID. */
export const externalDisplayName = (name: string) => name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 80);
