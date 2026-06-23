import { describe, it, expect } from 'vitest';
import { withTimeout } from '../src/util/timeout';

describe('withTimeout', () => {
  it('rejects with a labelled error when the deadline passes first', async () => {
    const never = new Promise<never>(() => {});
    await expect(withTimeout(never, 20, 'connect')).rejects.toThrow(
      /connect timed out after 20ms/,
    );
  });

  it('resolves with the value when the promise beats the deadline', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'call')).resolves.toBe('ok');
  });

  it('propagates the original rejection unchanged when it loses to the timer', async () => {
    const boom = Promise.reject(new Error('downstream exploded'));
    await expect(withTimeout(boom, 1000, 'call')).rejects.toThrow('downstream exploded');
  });
});
