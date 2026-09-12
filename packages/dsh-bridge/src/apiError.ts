/** Transport-level error carrying the HTTP status and machine-readable code the renderer branches on. */
export class DshApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message = code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
