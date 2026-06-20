import { randomUUID } from 'node:crypto';
import {
  analyzeReplay,
  cardLabel,
  createGame,
  decideBotIntent,
  dispatch,
  effectiveSuit,
  type Card,
  type GameEvent,
  type GameIntent,
  type GameState,
  type SeatIndex
} from '@zpy7/rules';
import type { AppDb, UserRecord } from './db.js';

export class RoomManager {
  private rooms = new Map<string, GameState>();
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private db: AppDb, private onChange: (roomId: string) => void) {
    for (const room of db.listRooms()) this.rooms.set(room.id, room);
  }

  listRooms() {
    return [...this.rooms.values()].map(summaryRoom);
  }

  createRoom(name: string): GameState {
    const room = createGame(randomUUID(), name.trim() || '找朋友牌桌');
    this.rooms.set(room.id, room);
    this.db.saveRoom(room);
    return room;
  }

  getRoom(id: string): GameState {
    const room = this.rooms.get(id) ?? this.db.getRoom(id);
    if (!room) throw new Error('房间不存在');
    this.rooms.set(id, room);
    return room;
  }

  getReplay(id: string) {
    return analyzeReplay(this.getRoom(id));
  }

  applyIntent(roomId: string, user: UserRecord, rawIntent: GameIntent) {
    const room = this.getRoom(roomId);
    const intent = sanitizeIntent(room, user, rawIntent);
    let result;
    try {
      result = dispatch(room, intent);
      auditPlayIntent(roomId, room, intent, result.events);
    } catch (error) {
      auditPlayIntent(roomId, room, intent, [], error);
      throw error;
    }
    this.rooms.set(roomId, result.state);
    this.db.appendEvents(roomId, result.events);
    this.db.saveRoom(result.state);
    this.onChange(roomId);
    this.scheduleBots(roomId);
    return result;
  }

  scheduleBots(roomId: string) {
    if (this.timers.has(roomId)) return;
    const room = this.getRoom(roomId);
    if (!nextBotIntent(room)) return;
    const timer = setTimeout(() => {
      this.timers.delete(roomId);
      this.driveBots(roomId);
    }, botDelay(room));
    this.timers.set(roomId, timer);
  }

  private driveBots(roomId: string) {
    let room = this.getRoom(roomId);
    const intent = nextBotIntent(room);
    if (!intent) return;
    try {
      const result = dispatch(room, intent);
      auditPlayIntent(roomId, room, intent, result.events);
      room = result.state;
      this.rooms.set(roomId, room);
      this.db.appendEvents(roomId, result.events);
      this.db.saveRoom(room);
      this.onChange(roomId);
    } catch (error) {
      auditPlayIntent(roomId, room, intent, [], error);
      console.warn(`bot intent rejected in room ${roomId}:`, error instanceof Error ? error.message : error);
      return;
    }
    if (nextBotIntent(room)) this.scheduleBots(roomId);
  }
}

function botDelay(room: GameState) {
  if (room.phase === 'playing') return 720;
  if (room.phase === 'bidding' || room.phase === 'counter') return 420;
  return 520;
}

function auditPlayIntent(
  roomId: string,
  room: GameState,
  intent: GameIntent,
  events: GameEvent[],
  error?: unknown
) {
  if (intent.type !== 'play') return;
  const player = room.seats[intent.seat];
  const trick = room.currentTrick;
  const leadShape = trick?.leadShape;
  const selected = cardsFromIds(player.hand, intent.cardIds);
  const selectedText = formatCards(selected);
  const leadText = leadShape
    ? `${leadShape.label}/${leadShape.effectiveSuit}/${leadShape.count}张`
    : '首出';
  const sameSuitCards = sameDoorCards(room, player.hand);
  const status = error ? 'REJECT' : 'ACCEPT';
  const reason = error ? ` error=${error instanceof Error ? error.message : String(error)}` : '';
  const eventText = events.map((event) => `#${event.seq}${event.message}`).join(' | ') || 'none';

  console.info(
    `[play-audit ${status}] room=${roomId} round=${room.round} trick=${trick?.index ?? 'none'} ` +
    `seat=${intent.seat + 1} name=${player.name} lead=${leadText} selected=${selectedText} ` +
    `sameDoor=${formatGroupedCards(sameSuitCards)} handCount=${player.hand.length} events=${eventText}${reason}`
  );
}

function cardsFromIds(hand: Card[], ids: string[]): Card[] {
  const byId = new Map(hand.map((card) => [card.id, card]));
  return ids.map((id) => byId.get(id)).filter((card): card is Card => !!card);
}

function sameDoorCards(room: GameState, hand: Card[]): Card[] {
  const leadSuit = room.currentTrick?.leadShape?.effectiveSuit;
  if (!room.trumpSuit || !leadSuit || leadSuit === 'mixed') return hand;
  return hand.filter((card) => effectiveSuit(card, room.trumpSuit!, room.dealerLevel) === leadSuit);
}

function formatCards(cards: Card[]): string {
  return cards.length ? cards.map(cardLabel).join(' ') : '[]';
}

function formatGroupedCards(cards: Card[]): string {
  if (cards.length === 0) return '[]';
  const groups = new Map<string, { label: string; count: number }>();
  for (const card of cards) {
    const label = groupLabel(card);
    groups.set(label, { label, count: (groups.get(label)?.count ?? 0) + 1 });
  }
  return [...groups.values()].map((group) => `${group.label}x${group.count}`).join(' ');
}

function groupLabel(card: Card): string {
  if (card.rank === 'SJ') return '小王';
  if (card.rank === 'BJ') return '大王';
  return cardLabel(card);
}

function nextBotIntent(room: GameState): GameIntent | null {
  if (room.phase === 'bidding' || room.phase === 'counter') {
    if (room.activeSeat === null) return null;
    const seat = room.seats[room.activeSeat];
    return seat?.isBot ? decideBotIntent(room, room.activeSeat) : null;
  }
  if (room.phase === 'bury' && room.bottomOwner !== null) return decideBotIntent(room, room.bottomOwner);
  if (room.phase === 'friend-call' && room.dealerSeat !== null) return decideBotIntent(room, room.dealerSeat);
  if (room.phase === 'playing' && room.activeSeat !== null) return decideBotIntent(room, room.activeSeat);
  return null;
}

function sanitizeIntent(room: GameState, user: UserRecord, intent: GameIntent): GameIntent {
  const clean = stripClientStrategy(intent);
  if (clean.type === 'sit') {
    return { ...clean, userId: user.id, name: user.name };
  }
  if (clean.type === 'leave-seat') {
    return { ...clean, userId: user.id };
  }
  if (clean.type === 'toggle-bot') {
    authorizeSeatControl(room, user, clean.seat);
    return clean;
  }
  if ('seat' in clean) {
    authorizePlayerSeat(room, user, clean.seat);
  }
  return clean;
}

function stripClientStrategy(intent: GameIntent): GameIntent {
  if (intent.type === 'bid') return { type: 'bid', seat: intent.seat, cardIds: intent.cardIds };
  if (intent.type === 'pass-counter') return { type: 'pass-counter', seat: intent.seat };
  if (intent.type === 'bury') return { type: 'bury', seat: intent.seat, cardIds: intent.cardIds };
  if (intent.type === 'call-friends') return { type: 'call-friends', seat: intent.seat, calls: intent.calls };
  if (intent.type === 'play') return { type: 'play', seat: intent.seat, cardIds: intent.cardIds };
  return intent;
}

function authorizeSeatControl(room: GameState, user: UserRecord, seat: SeatIndex) {
  const player = room.seats[seat];
  if (player.userId && player.userId !== user.id) throw new Error('不能操作其他真人座位');
}

function authorizePlayerSeat(room: GameState, user: UserRecord, seat: SeatIndex) {
  const player = room.seats[seat];
  if (player.isBot) throw new Error('AI座位由系统接管');
  if (player.userId !== user.id) throw new Error('只能操作自己的座位');
}

function summaryRoom(room: GameState) {
  return {
    id: room.id,
    name: room.name,
    phase: room.phase,
    round: room.round,
    seats: room.seats.map((seat) => ({
      seat: seat.seat,
      name: seat.name,
      isBot: seat.isBot,
      occupied: !!seat.userId || seat.isBot,
      level: seat.level
    }))
  };
}

export function redactRoom(room: GameState, user: UserRecord | null) {
  const userId = user?.id ?? null;
  return {
    ...room,
    currentBid: publicCurrentBid(room),
    seats: room.seats.map((seat) => {
      const canSeeHand = seat.userId === userId || seat.isBot || room.phase === 'finished';
      return {
        ...seat,
        handCount: seat.hand.length,
        hand: canSeeHand ? seat.hand : []
      };
    }),
    kitty: room.phase === 'finished' || room.phase === 'counter' ? room.kitty : []
  };
}

function publicCurrentBid(room: GameState) {
  if (!room.currentBid) return null;
  const bid = room.currentBid as GameState['currentBid'] & {
    cards?: Card[];
    action?: 'bid' | 'counter' | 'kitty';
  };
  const selected = new Set(bid.cardIds);
  const visibleCards = bid.cards?.length
    ? bid.cards
    : [...room.kitty, ...room.seats.flatMap((seat) => seat.hand)].filter((card) => selected.has(card.id));
  return {
    ...bid,
    cards: visibleCards,
    action: bid.action ?? (bid.source === 'kitty' ? 'kitty' : 'bid')
  };
}
