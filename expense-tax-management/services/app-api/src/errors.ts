import type { FastifyError, FastifyInstance } from "fastify";

interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
  };
}

function errorEnvelope(
  code: string,
  message: string,
  requestId: string,
): ErrorEnvelope {
  return {
    error: {
      code,
      message,
      requestId,
    },
  };
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send(errorEnvelope("NOT_FOUND", "Route not found", request.id));
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode =
      error.validation || error.statusCode === 400
        ? 400
        : error.statusCode && error.statusCode >= 400 && error.statusCode < 500
          ? error.statusCode
          : 500;
    const isInternalError = statusCode >= 500;

    request.log.error(
      { err: error, requestId: request.id, statusCode },
      "request failed",
    );

    reply.code(statusCode).send(
      errorEnvelope(
        isInternalError
          ? "INTERNAL_ERROR"
          : error.validation
            ? "VALIDATION_ERROR"
            : "REQUEST_ERROR",
        isInternalError
          ? "Internal server error"
          : error.validation
            ? "Request validation failed"
            : "Request failed",
        request.id,
      ),
    );
  });
}
