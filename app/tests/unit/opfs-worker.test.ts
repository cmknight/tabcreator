import { describe, expect, it } from 'vitest';
import type { FromOpfsWorker } from '../../src/storage/audio-store';
import {
  createOpfsHandler,
  type OpfsRoot,
  type SyncAccessHandle,
} from '../../src/storage/opfs-worker';

// The real sync access handles need a browser (tests/e2e/storage.dev.spec.ts); this drives the
// worker's handler with in-memory fakes.

class FakeHandle implements SyncAccessHandle {
  data = new Uint8Array(0);
  closed = false;
  calls: string[] = [];
  failWrite = false;
  failFlush = false;
  getSize() {
    return this.data.byteLength;
  }
  write(buffer: Uint8Array, { at }: { at: number }) {
    this.calls.push('write');
    const next = new Uint8Array(Math.max(this.data.byteLength, at + buffer.byteLength));
    next.set(this.data);
    if (this.failWrite) {
      // A partial write that lands some bytes, then fails.
      next.set(buffer.subarray(0, 1), at);
      this.data = next;
      throw new DOMException('disk full', 'QuotaExceededError');
    }
    next.set(buffer, at);
    this.data = next;
    return buffer.byteLength;
  }
  flush() {
    this.calls.push('flush');
    if (this.failFlush) throw new DOMException('flush failed', 'InvalidStateError');
  }
  truncate(size: number) {
    this.calls.push(`truncate:${size}`);
    this.data = this.data.slice(0, size);
  }
  close() {
    this.calls.push('close');
    this.closed = true;
  }
}

function setup() {
  const created: { name: string; handle: FakeHandle }[] = [];
  const replies: FromOpfsWorker[] = [];
  const root: OpfsRoot = {
    async getDirectoryHandle(dir) {
      expect(dir).toBe('raw');
      return {
        async getFileHandle(name) {
          return {
            async createSyncAccessHandle() {
              const handle = new FakeHandle();
              created.push({ name, handle });
              return handle;
            },
          };
        },
      };
    },
  };
  let reqId = 0;
  const handler = createOpfsHandler(
    () => Promise.resolve(root),
    (m) => replies.push(m),
  );
  const send = {
    open: (takeId: string) => handler({ type: 'open', reqId: ++reqId, takeId }),
    append: (takeId: string, samples: Float32Array) =>
      handler({ type: 'append', reqId: ++reqId, takeId, samples }),
    close: (takeId: string) => handler({ type: 'close', reqId: ++reqId, takeId }),
  };
  return { created, replies, send };
}

describe('OPFS worker handler', () => {
  it('opens, appends at the end with a flush each time, and closes', async () => {
    const { created, replies, send } = setup();
    await send.open('t1');
    await send.open('t1'); // already open: no second handle
    await send.append('t1', new Float32Array([0.5]));
    await send.append('t1', new Float32Array([-1, 0.25]));
    await send.close('t1');
    expect(created.map((c) => c.name)).toEqual(['t1.f32']);
    const handle = created[0]!.handle;
    expect([...new Float32Array(handle.data.buffer)]).toEqual([0.5, -1, 0.25]);
    expect(handle.calls).toEqual(['write', 'flush', 'write', 'flush', 'flush', 'close']);
    expect(handle.closed).toBe(true);
    expect(replies).toEqual([1, 2, 3, 4, 5].map((reqId) => ({ type: 'done', reqId })));
  });

  it('replies InvalidStateError to an append on a take that is not open', async () => {
    const { replies, send } = setup();
    await send.append('t1', new Float32Array(1));
    expect(replies).toEqual([
      {
        type: 'error',
        reqId: 1,
        name: 'InvalidStateError',
        message: 'Raw file for t1 is not open',
      },
    ]);
  });

  it('truncates a failed append back to the previous size', async () => {
    const { created, replies, send } = setup();
    await send.open('t1');
    await send.append('t1', new Float32Array([0.5]));
    const handle = created[0]!.handle;
    handle.failWrite = true;
    await send.append('t1', new Float32Array([1, 2]));
    expect(handle.data.byteLength).toBe(4);
    expect(handle.calls.slice(-2)).toEqual(['truncate:4', 'flush']);
    expect(replies.at(-1)).toMatchObject({ type: 'error', reqId: 3, name: 'QuotaExceededError' });
  });

  it('closes the handle and frees the take when flush throws on close', async () => {
    const { created, replies, send } = setup();
    await send.open('t1');
    const handle = created[0]!.handle;
    handle.failFlush = true;
    await send.close('t1');
    expect(handle.closed).toBe(true);
    expect(replies.at(-1)).toEqual({
      type: 'error',
      reqId: 2,
      name: 'InvalidStateError',
      message: 'flush failed',
    });
    // The take is no longer open: appends fail and a reopen creates a fresh handle.
    await send.append('t1', new Float32Array(1));
    expect(replies.at(-1)).toMatchObject({ type: 'error', reqId: 3, name: 'InvalidStateError' });
    await send.open('t1');
    expect(created).toHaveLength(2);
    expect(replies.at(-1)).toEqual({ type: 'done', reqId: 4 });
  });

  it('handles requests strictly in arrival order', async () => {
    const { replies, send } = setup();
    void send.open('t1');
    void send.append('t1', new Float32Array(1));
    await send.close('t1');
    expect(replies.map((r) => [r.reqId, r.type])).toEqual([
      [1, 'done'],
      [2, 'done'],
      [3, 'done'],
    ]);
  });
});
