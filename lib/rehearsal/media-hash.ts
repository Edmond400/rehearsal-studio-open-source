import {SHA256} from '@noble/hashes/sha2';

// Only persist SHA-256 state at a full compression-block boundary. The
// database keeps the byte count separately and never accepts a client state.
export class ResumableSha256 extends SHA256 {
 constructor(bytes: number, state: string | null) {
  super();
  if (!bytes && state === null) return;
  if (!bytes || bytes % this.blockLen || !state || !/^[a-f0-9]{64}$/.test(state)) {
   throw new Error('Invalid persisted SHA-256 checkpoint');
  }
  const words = Buffer.from(state, 'hex');
  this.set(words.readInt32BE(0), words.readInt32BE(4), words.readInt32BE(8), words.readInt32BE(12),
   words.readInt32BE(16), words.readInt32BE(20), words.readInt32BE(24), words.readInt32BE(28));
  this.length = bytes;
 }

 checkpoint() {
  if (this.pos) throw new Error('SHA-256 checkpoint requires complete blocks');
  const words = Buffer.alloc(32);
  this.get().forEach((word, i) => words.writeInt32BE(word, i * 4));
  return words.toString('hex');
 }
}
