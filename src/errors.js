// An error with an HTTP status, shown to the user as-is.
export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
