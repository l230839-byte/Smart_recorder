import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { AppLockState } from '@shared/models';
import type { Db } from '../db/database';

const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
/** Free attempts before waits begin; then 30 seconds, doubling, up to 15 minutes. */
const FREE_ATTEMPTS = 5;
const FIRST_WAIT_MS = 30_000;
const MAX_WAIT_MS = 15 * 60_000;
export const AUTO_LOCK_CHOICES = [0, 1, 5, 15, 30, 60];

interface Row {
  salt: Uint8Array;
  hash: Uint8Array;
  auto_lock_minutes: number;
  failed_attempts: number;
  locked_until: number;
}

export function validPin(pin: string): boolean {
  return /^\d{4,12}$/.test(pin);
}

function hashPin(pin: string, salt: Uint8Array): Buffer {
  return scryptSync(pin, salt, 32, SCRYPT);
}

/**
 * The optional app lock (prompt §16). The main process enforces it: while locked, the API refuses
 * everything except unlocking, so the lock screen is not just a cover over working screens. Wrong PINs
 * cost increasing waits, which survive a restart.
 *
 * It protects against someone using EchoMind on an unlocked computer. It does not encrypt files on disk;
 * Windows' own account protection and BitLocker do that.
 */
export class AppLock {
  private locked: boolean;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {
    this.locked = this.row() !== null;
  }

  private row(): Row | null {
    return (this.db.prepare('SELECT salt, hash, auto_lock_minutes, failed_attempts, locked_until FROM app_lock WHERE id = 1').get() as Row | undefined) ?? null;
  }

  state(): AppLockState {
    const row = this.row();
    return { enabled: row !== null, locked: this.locked, autoLockMinutes: row?.auto_lock_minutes ?? 5, waitUntil: row && row.locked_until > this.now() ? row.locked_until : null };
  }

  isLocked(): boolean {
    return this.locked;
  }

  private verify(pin: string): boolean {
    const row = this.row();
    if (!row) return true;
    const t = this.now();
    if (row.locked_until > t) throw new Error(`Too many wrong PINs. Try again in ${Math.ceil((row.locked_until - t) / 1000)} seconds.`);
    const ok = validPin(pin) && timingSafeEqual(hashPin(pin, row.salt), Buffer.from(row.hash));
    if (ok) {
      this.db.prepare('UPDATE app_lock SET failed_attempts = 0, locked_until = 0 WHERE id = 1').run();
      return true;
    }
    const failed = row.failed_attempts + 1;
    const wait = failed >= FREE_ATTEMPTS ? Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (failed - FREE_ATTEMPTS)) : 0;
    this.db.prepare('UPDATE app_lock SET failed_attempts = ?, locked_until = ? WHERE id = 1').run(failed, wait ? t + wait : 0);
    return false;
  }

  /** Turns the lock on, or changes the PIN (which needs the current one). */
  setPin(pin: string, currentPin: string | null): void {
    if (!validPin(pin)) throw new Error('Use 4 to 12 digits.');
    if (this.row() && (currentPin === null || !this.verify(currentPin))) throw new Error('The current PIN is not right.');
    const salt = randomBytes(16);
    this.db
      .prepare('INSERT INTO app_lock (id, salt, hash) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET salt = excluded.salt, hash = excluded.hash, failed_attempts = 0, locked_until = 0')
      .run(salt, hashPin(pin, salt));
  }

  disable(currentPin: string): void {
    if (!this.row()) return;
    if (!this.verify(currentPin)) throw new Error('The PIN is not right.');
    this.db.prepare('DELETE FROM app_lock WHERE id = 1').run();
    this.locked = false;
  }

  setAutoLock(minutes: number): void {
    if (!AUTO_LOCK_CHOICES.includes(minutes)) throw new Error('Choose one of the offered times.');
    this.db.prepare('UPDATE app_lock SET auto_lock_minutes = ? WHERE id = 1').run(minutes);
  }

  lock(): boolean {
    if (!this.row() || this.locked) return false;
    this.locked = true;
    return true;
  }

  /** True when the PIN was right. */
  unlock(pin: string): boolean {
    if (!this.locked) return true;
    if (!this.verify(pin)) return false;
    this.locked = false;
    return true;
  }

  /** Locks after the computer has been idle for the chosen time. */
  idle(idleSeconds: number): boolean {
    const minutes = this.row()?.auto_lock_minutes ?? 0;
    return minutes > 0 && idleSeconds >= minutes * 60 && this.lock();
  }
}
