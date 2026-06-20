import { describe, expect, it } from 'vitest';
import { AppDb } from './db.js';
import { RoomManager } from './rooms.js';

describe('RoomManager', () => {
  it('creates a persisted room and accepts AI seat toggles', () => {
    const db = new AppDb(':memory:');
    const manager = new RoomManager(db, () => {});
    const user = db.createUser('tester', '123');
    const room = manager.createRoom('test room');
    const result = manager.applyIntent(room.id, user, { type: 'toggle-bot', seat: 0, enabled: true });
    expect(result.state.seats[0].isBot).toBe(true);
    expect(manager.listRooms()[0].name).toBe('test room');
  });

  it('strips forged strategy reports from user intents', () => {
    const db = new AppDb(':memory:');
    const manager = new RoomManager(db, () => {});
    const user = db.createUser('tester', '123');
    const room = manager.createRoom('test room');
    const state = manager.getRoom(room.id);
    state.phase = 'bidding';
    state.seats[0].userId = user.id;
    state.seats[0].name = user.name;

    const result = manager.applyIntent(room.id, user, {
      type: 'pass-counter',
      seat: 0,
      strategy: {
        seat: 0,
        phase: 'bidding',
        action: 'pass-counter',
        objective: { team: 'host', target: 'host-level-up', scoreLine: 'fake', summary: 'fake' },
        score: 100,
        reasons: ['fake'],
        risks: []
      }
    });

    expect(result.events.some((event) => event.type === 'ai.decision')).toBe(false);
    expect(result.events.some((event) => event.type === 'player.pass')).toBe(true);
  });
});
