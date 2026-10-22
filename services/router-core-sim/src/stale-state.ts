export type SafetyStateVersion = Record<string, string | number | null>;

export class StaleSafetyStateError extends Error {
  readonly code = "STALE_STATE" as const;
  readonly resource: string;
  readonly expected: SafetyStateVersion;
  readonly current: SafetyStateVersion;

  constructor(resource: string, expected: SafetyStateVersion, current: SafetyStateVersion) {
    super("State changed — review before retrying");
    this.resource = resource;
    this.expected = expected;
    this.current = current;
  }
}
