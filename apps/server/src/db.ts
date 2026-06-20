import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { GameEvent, GameState } from '@zpy7/rules';

export type UserRecord = {
  id: string;
  name: string;
  token: string;
};

export class AppDb {
  private db: DatabaseSync;

  constructor(filename = resolve(process.cwd(), 'data/zpy7.db')) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS game_events (
        room_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        payload_json TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(room_id, seq)
      );
    `);
  }

  createUser(name: string, password: string): UserRecord {
    const cleanName = name.trim();
    if (!cleanName) throw new Error('用户名不能为空');
    if (password.length < 3) throw new Error('密码至少3位');
    const user = {
      id: randomUUID(),
      name: cleanName,
      token: randomUUID()
    };
    this.db.prepare(`
      INSERT INTO users (id, name, password_hash, token, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(user.id, user.name, hashPassword(password), user.token, new Date().toISOString());
    return user;
  }

  login(name: string, password: string): UserRecord {
    const row = this.db.prepare('SELECT id, name, password_hash, token FROM users WHERE name = ?').get(name.trim()) as
      | { id: string; name: string; password_hash: string; token: string }
      | undefined;
    if (!row || row.password_hash !== hashPassword(password)) throw new Error('用户名或密码错误');
    const token = randomUUID();
    this.db.prepare('UPDATE users SET token = ? WHERE id = ?').run(token, row.id);
    return { id: row.id, name: row.name, token };
  }

  getUserByToken(token: string): UserRecord | null {
    const row = this.db.prepare('SELECT id, name, token FROM users WHERE token = ?').get(token) as UserRecord | undefined;
    return row ?? null;
  }

  saveRoom(state: GameState) {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO rooms (id, name, state_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(state.id, state.name, JSON.stringify(state), now, now);
  }

  listRooms(): GameState[] {
    const rows = this.db.prepare('SELECT state_json FROM rooms ORDER BY updated_at DESC').all() as { state_json: string }[];
    return rows.map((row) => JSON.parse(row.state_json) as GameState);
  }

  getRoom(id: string): GameState | null {
    const row = this.db.prepare('SELECT state_json FROM rooms WHERE id = ?').get(id) as { state_json: string } | undefined;
    return row ? (JSON.parse(row.state_json) as GameState) : null;
  }

  appendEvents(roomId: string, events: GameEvent[]) {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO game_events (room_id, seq, type, message, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    for (const event of events) {
      stmt.run(roomId, event.seq, event.type, event.message, JSON.stringify(event.payload ?? null), now);
    }
  }
}

function hashPassword(password: string): string {
  return createHash('sha256').update(`zpy7:${password}`).digest('hex');
}
