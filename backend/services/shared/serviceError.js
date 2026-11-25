// A failure a service expects and the caller should see, e.g. "Invoice not
// found" (404) or a validation message (400). Controllers turn it into an HTTP
// response with sendError (utils/httpErrors.js); anything else is a 500.

class ServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ServiceError";
    this.status = status;
  }
}

const fail = (status, message) => {
  throw new ServiceError(status, message);
};

module.exports = { ServiceError, fail };
