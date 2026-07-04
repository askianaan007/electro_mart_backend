import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { isForeignKeyViolation } from '../utils/prisma-errors';

interface ErrorBody {
  status: HttpStatus;
  error: string;
  message: string | string[];
}

const REASON_PHRASE: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNAUTHORIZED]: 'Unauthorized',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.NOT_FOUND]: 'Not Found',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
  [HttpStatus.INTERNAL_SERVER_ERROR]: 'Internal Server Error',
};

function reasonPhrase(status: HttpStatus): string {
  return REASON_PHRASE[status] ?? 'Error';
}

function fromHttpException(exception: HttpException): ErrorBody {
  const status = exception.getStatus();
  const body = exception.getResponse();

  if (typeof body === 'string') {
    return { status, error: reasonPhrase(status), message: body };
  }

  const shaped = body as { error?: string; message?: string | string[] };
  return {
    status,
    error: shaped.error ?? reasonPhrase(status),
    message: shaped.message ?? exception.message,
  };
}

function fromPrismaError(
  exception: Prisma.PrismaClientKnownRequestError,
): ErrorBody {
  switch (exception.code) {
    case 'P2002': {
      const target =
        (exception.meta?.target as string[] | undefined)?.join(', ') ?? 'field';
      return {
        status: HttpStatus.CONFLICT,
        error: reasonPhrase(HttpStatus.CONFLICT),
        message: `A record with this ${target} already exists`,
      };
    }
    case 'P2003':
      return {
        status: HttpStatus.CONFLICT,
        error: reasonPhrase(HttpStatus.CONFLICT),
        message:
          'This record is referenced by other data and cannot be modified or deleted',
      };
    case 'P2025':
      return {
        status: HttpStatus.NOT_FOUND,
        error: reasonPhrase(HttpStatus.NOT_FOUND),
        message: 'Record not found',
      };
    default:
      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        error: reasonPhrase(HttpStatus.INTERNAL_SERVER_ERROR),
        message: 'Internal server error',
      };
  }
}

function fromUnknownPrismaError(
  exception: Prisma.PrismaClientUnknownRequestError,
): ErrorBody {
  if (isForeignKeyViolation(exception)) {
    return {
      status: HttpStatus.CONFLICT,
      error: reasonPhrase(HttpStatus.CONFLICT),
      message:
        'This record is referenced by other data and cannot be modified or deleted',
    };
  }
  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    error: reasonPhrase(HttpStatus.INTERNAL_SERVER_ERROR),
    message: 'Internal server error',
  };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let body: ErrorBody;
    if (exception instanceof HttpException) {
      body = fromHttpException(exception);
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      body = fromPrismaError(exception);
    } else if (exception instanceof Prisma.PrismaClientUnknownRequestError) {
      body = fromUnknownPrismaError(exception);
    } else {
      body = {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        error: reasonPhrase(HttpStatus.INTERNAL_SERVER_ERROR),
        message: 'Internal server error',
      };
    }

    if (body.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        exception instanceof Error ? exception.stack : exception,
      );
    }

    response.status(body.status).json({
      statusCode: body.status,
      error: body.error,
      message: body.message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}
