import { describe, expect, it } from 'vitest';
import { APP_ERROR_CODES, AppError, isAppError } from './errors';

describe('AppError', () => {
  it('keeps code, message and cause', () => {
    const cause = new DOMException('denied', 'NotAllowedError');
    const err = new AppError('mic-denied', 'getUserMedia rejected', { cause });
    expect(err).toBeInstanceOf(Error);
    expect(isAppError(err)).toBe(true);
    expect(err.code).toBe('mic-denied');
    expect(err.message).toBe('getUserMedia rejected');
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('AppError');
  });

  it('has no cause when none is given', () => {
    expect(new AppError('storage-full', 'quota').cause).toBeUndefined();
  });

  it('has exactly the 15 codes of spine AD-10', () => {
    expect(new Set(APP_ERROR_CODES).size).toBe(15);
  });

  it('is not confused with a plain Error', () => {
    expect(isAppError(new Error('x'))).toBe(false);
  });
});
