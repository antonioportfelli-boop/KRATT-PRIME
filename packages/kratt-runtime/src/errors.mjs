export class KrattRuntimeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "KrattRuntimeError";
    this.code = code;
  }
}

export class ConfigurationError extends KrattRuntimeError {
  constructor(message) { super("CONFIGURATION_INVALID", message); this.name = "ConfigurationError"; }
}
