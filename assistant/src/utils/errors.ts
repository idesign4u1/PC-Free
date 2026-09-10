/** Base class so the HTTP layer and the WhatsApp layer can react differently. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus = 500,
    readonly userMessageHe?: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A validated business-rule failure — safe to surface to the user. */
export class ValidationError extends AppError {
  constructor(message: string, userMessageHe?: string) {
    super(message, 'validation_error', 400, userMessageHe);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, userMessageHe?: string) {
    super(message, 'not_found', 404, userMessageHe);
  }
}

export class AuthError extends AppError {
  constructor(message: string) {
    super(message, 'unauthorized', 401);
  }
}

/**
 * An external API misbehaved. `integration` drives the degraded-mode message the
 * user sees ("Google Calendar is unavailable right now…") and the health endpoint.
 */
export class IntegrationError extends AppError {
  constructor(
    readonly integration: string,
    message: string,
    readonly status?: number,
    readonly retryable = true,
    cause?: unknown,
  ) {
    super(message, 'integration_error', 502, undefined, cause);
  }
}

/** The connected account needs the user to re-authorise; never auto-retried. */
export class ReauthRequiredError extends IntegrationError {
  constructor(integration: string, message: string) {
    super(integration, message, 401, false);
  }
}

export function describeError(err: unknown): { message: string; stack?: string } {
  if (err instanceof Error) return { message: err.message, stack: err.stack };
  return { message: String(err) };
}

export function errorText(err: unknown): string {
  return describeError(err).message;
}
