'use strict';

class ApiError extends Error {
  constructor(status, code, message, fields, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.details = details;
  }
}

module.exports = { ApiError };
