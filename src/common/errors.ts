import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';

/** Error body contract used by the app: { error: { code, message, fields? } } */
export class AppError extends HttpException {
  constructor(status: number, code: string, message: string, fields?: Record<string, string>) {
    super({ error: { code, message, fields } }, status);
  }
}

export const invalid = (code: string, message: string, field?: string) =>
  new AppError(HttpStatus.UNPROCESSABLE_ENTITY, code, message, field ? { [field]: message } : undefined);
export const notFound = (what: string) => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`);
export const unauthorized = () => new AppError(HttpStatus.UNAUTHORIZED, 'AUTH', 'Your session has ended. Please sign in again.');

@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof AppError) {
      res.status(exception.getStatus()).json(exception.getResponse());
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse() as { message?: string | string[] };
      const message = Array.isArray(body.message) ? body.message[0] : body.message ?? exception.message;
      res.status(status).json({ error: { code: status === 400 ? 'VALIDATION' : 'HTTP_' + status, message } });
      return;
    }
    console.error(exception);
    res.status(500).json({ error: { code: 'SERVER', message: 'Something went wrong on our side. Please try again.' } });
  }
}
