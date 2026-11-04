/** Typed backend refusals survive the ControlPlane boundary without parsing operator messages. */
export class ControlCommandError extends Error {
  readonly code: "INVALID" | "LOCKED" | "NOT_FOUND" | "UNAVAILABLE";
  constructor(code: ControlCommandError["code"], message: string) { super(message); this.code = code; }
}
