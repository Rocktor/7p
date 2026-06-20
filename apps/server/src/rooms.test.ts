import { describe, expect, it, vi } from 'vitest';
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

  it('requires a player to leave before sitting elsewhere', () => {
    const db = new AppDb(':memory:');
    const manager = new RoomManager(db, () => {});
    const user = db.createUser('tester', '123');
    const room = manager.createRoom('test room');

    manager.applyIntent(room.id, user, { type: 'sit', seat: 0, userId: 'forged', name: 'forged' });

    expect(() => manager.applyIntent(room.id, user, { type: 'sit', seat: 1, userId: 'forged', name: 'forged' })).toThrow(/先离席/);

    const left = manager.applyIntent(room.id, user, { type: 'leave-seat', seat: 0, userId: 'forged' });
    expect(left.state.seats[0]).toMatchObject({ userId: null, isBot: true, name: 'AI-1' });

    const seated = manager.applyIntent(room.id, user, { type: 'sit', seat: 1, userId: 'forged', name: 'forged' });
    expect(seated.state.seats[1]).toMatchObject({ userId: user.id, isBot: false, name: user.name });
  });

  it('rejects manual player actions for AI-controlled seats', () => {
    const db = new AppDb(':memory:');
    const manager = new RoomManager(db, () => {});
    const user = db.createUser('tester', '123');
    const room = manager.createRoom('test room');

    manager.applyIntent(room.id, user, { type: 'toggle-bot', seat: 0, enabled: true });

    expect(() => manager.applyIntent(room.id, user, { type: 'pass-counter', seat: 0 })).toThrow(/AI座位由系统接管/);
  });

  it('resumes bot play for persisted rooms after manager startup', async () => {
    vi.useFakeTimers();
    try {
      const db = new AppDb(':memory:');
      const seedManager = new RoomManager(db, () => {});
      const room = seedManager.createRoom('test room');
      const state = seedManager.getRoom(room.id);
      state.phase = 'playing';
      state.trumpSuit = 'spades';
      state.dealerLevel = 'J';
      state.activeSeat = 0;
      state.currentTrick = {
        index: 1,
        leader: 0,
        plays: [],
        leadShape: null,
        winner: null,
        points: 0
      };
      state.seats[0].isBot = true;
      state.seats[0].name = 'AI-1';
      state.seats[0].hand = [{ id: 'bot-card', deck: 0, suit: 'spades', rank: '2' }];
      state.seats[1].isBot = true;
      state.seats[1].name = 'AI-2';
      state.seats[1].hand = [{ id: 'bot-card-2', deck: 1, suit: 'spades', rank: '3' }];
      db.saveRoom(state);

      let changes = 0;
      const manager = new RoomManager(db, () => { changes += 1; });

      await vi.advanceTimersByTimeAsync(1600);

      const resumed = manager.getRoom(room.id);
      expect(resumed.currentTrick?.plays).toHaveLength(2);
      expect(resumed.currentTrick?.plays[0].seat).toBe(0);
      expect(resumed.currentTrick?.plays[1].seat).toBe(1);
      expect(changes).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('strips forged strategy reports from user intents', () => {
    const db = new AppDb(':memory:');
    const manager = new RoomManager(db, () => {});
    const user = db.createUser('tester', '123');
    const room = manager.createRoom('test room');
    const state = manager.getRoom(room.id);
    state.phase = 'bidding';
    state.activeSeat = 0;
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
