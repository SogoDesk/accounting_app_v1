// Map a service error to an HTTP response. Expected failures (ServiceError)
// keep their status and message; anything else is a 500 with the handler's
// own message, as the controllers have always returned.

const { ServiceError } = require("../services/shared/serviceError");

// Postgres "invalid_datetime_format": a date the request supplied was not a date.
const INVALID_DATE = "22007";

function sendError(res, error, { message, log, invalidDateMessage } = {}) {
  if (error instanceof ServiceError) {
    return res.status(error.status).json({ success: false, message: error.message });
  }
  if (invalidDateMessage && error && error.code === INVALID_DATE) {
    return res.status(400).json({ success: false, message: invalidDateMessage });
  }
  if (log) console.error(`${log} error:`, error);
  return res.status(500).json({
    success: false,
    message: message || "Internal server error",
    error: error && error.message,
  });
}

module.exports = { sendError };
