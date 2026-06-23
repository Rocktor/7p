import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Bot, Check, CirclePlay, DoorOpen, History, Hourglass, LogOut, Play, RotateCcw, Send, Shuffle, Star, UserRound, X } from 'lucide-react';
import { createRoom, getReplay, getRoom, listRooms, login, postIntent, register } from './api';
import type { Card, GameState, NormalSuit, ReplayAnalysis, TrickState, TrumpSuit, User } from './types';
import './styles.css';

const SUIT_SYMBOL: Record<string, string> = {
  spades: '♠',
  hearts: '♥',
  clubs: '♣',
  diamonds: '♦',
  joker: '☉'
};

const SUIT_NAME: Record<NormalSuit, string> = {
  spades: '黑桃',
  hearts: '红桃',
  clubs: '梅花',
  diamonds: '方片'
};

const TRUMP_NAME: Record<TrumpSuit, string> = {
  ...SUIT_NAME,
  'no-trump': '无主'
};

type IntentSender = (intent: unknown) => Promise<void>;
type FriendCallRank = 'A' | 'K';
type CounterBidInfo = {
  seq: number;
  seat: number;
  suit: TrumpSuit;
  levelRank: string;
  levelCardCount: number;
  jokerCount: number;
  noTrumpRank?: 'SJ' | 'BJ';
  cards: Card[];
};

function App() {
  const [user, setUser] = useState<User | null>(() => {
    const raw = localStorage.getItem('zpy7-user');
    return raw ? JSON.parse(raw) as User : null;
  });
  const [rooms, setRooms] = useState<{ id: string; name: string; phase: string; round: number }[]>([]);
  const [room, setRoom] = useState<GameState | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [replay, setReplay] = useState<ReplayAnalysis | null>(null);

  useEffect(() => {
    refreshRooms();
  }, []);

  useEffect(() => {
    const roomId = room?.id;
    const token = user?.token;
    if (!roomId || !token) return;

    let closed = false;
    let ws: WebSocket | null = null;
    let retryTimer: number | undefined;
    let pollTimer: number | undefined;

    const fetchLatestRoom = async () => {
      try {
        const result = await getRoom(roomId, token);
        if (!closed) setRoom(result.room);
      } catch (err) {
        if (!closed) setError(err instanceof Error ? err.message : String(err));
      }
    };

    const connect = (attempt = 0) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${proto}://${location.host}/ws?roomId=${roomId}&token=${token}`);
      ws = socket;

      socket.onopen = () => {
        if (!closed) void fetchLatestRoom();
      };
      socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'state') setRoom(msg.room);
        if (msg.type === 'error') setError(msg.message);
      };
      socket.onerror = () => {
        socket.close();
      };
      socket.onclose = () => {
        if (closed) return;
        void fetchLatestRoom();
        const delay = Math.min(6000, 800 * 2 ** Math.min(attempt, 3));
        retryTimer = window.setTimeout(() => connect(attempt + 1), delay);
      };
    };

    connect();
    pollTimer = window.setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) void fetchLatestRoom();
    }, 3000);

    return () => {
      closed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      if (pollTimer) window.clearInterval(pollTimer);
      ws?.close();
    };
  }, [room?.id, user?.token]);

  async function refreshRooms() {
    const result = await listRooms();
    setRooms(result.rooms);
  }

  function persistUser(next: User) {
    setUser(next);
    localStorage.setItem('zpy7-user', JSON.stringify(next));
  }

  async function sendIntent(intent: unknown) {
    if (!room || !user) return;
    try {
      setError('');
      const result = await postIntent(room.id, intent, user.token);
      setRoom(result.room);
      setSelected([]);
      if (result.room.phase === 'finished') {
        const replayResult = await getReplay(result.room.id, user.token);
        setReplay(replayResult.analysis);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function fillAiSeats() {
    if (!room || !user) return;
    const emptySeats = room.seats.filter((seat) => !seat.userId && !seat.isBot).map((seat) => seat.seat);
    if (emptySeats.length === 0) return;
    try {
      setError('');
      let nextRoom = room;
      for (const seat of emptySeats) {
        const result = await postIntent(room.id, { type: 'toggle-bot', seat, enabled: true }, user.token);
        nextRoom = result.room;
      }
      setRoom(nextRoom);
      setSelected([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function openRoom(id: string) {
    const result = await getRoom(id, user?.token);
    setRoom(result.room);
    setReplay(null);
  }

  async function loadReplay() {
    if (!room) return;
    const result = await getReplay(room.id, user?.token);
    setReplay(result.analysis);
  }

  function returnToLobby() {
    setRoom(null);
    setReplay(null);
    refreshRooms();
  }

  if (!user) {
    return <AuthScreen onAuth={persistUser} />;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <h1>7人6副牌找朋友 <span className="version-label">Alpha V20260623</span></h1>
          <p>联机牌桌 · AI补位 · 复盘分析</p>
        </div>
        <div className="user-pill">
          <UserRound size={18} />
          <span>{user.name}</span>
          <button title="退出登录" onClick={() => { localStorage.removeItem('zpy7-user'); setUser(null); }}>
            <LogOut size={16} />
          </button>
        </div>
      </header>

      {!room ? (
        <RoomLobby
          rooms={rooms}
          onRefresh={refreshRooms}
          onOpen={openRoom}
          onCreate={async (name) => {
            const result = await createRoom(name, user.token);
            setRoom(result.room);
            await refreshRooms();
          }}
        />
      ) : (
        <main className="game-layout">
          <section className="table-zone">
            <Table room={room} user={user} onIntent={sendIntent} onFillAiSeats={fillAiSeats} />
            <Hand
              room={room}
              user={user}
              selected={selected}
              setSelected={setSelected}
              onPlay={() => sendIntent({ type: 'play', seat: mySeat(room, user), cardIds: selected })}
            />
          </section>
          <aside className="control-rail">
            <ReturnRoomButton onConfirm={returnToLobby} />
            <ActionPanel room={room} user={user} selected={selected} onIntent={sendIntent} onReplay={loadReplay} />
            {error && <div className="error-box">{error}</div>}
            <EventLog room={room} />
            {replay && <ReplayPanel replay={replay} />}
          </aside>
        </main>
      )}
    </div>
  );
}

function ReturnRoomButton({ onConfirm }: { onConfirm: () => void }) {
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = window.setTimeout(() => setConfirming(false), 3500);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  if (confirming) {
    return (
      <div className="return-confirm">
        <button className="danger-soft" onClick={onConfirm}><Check size={16} /> 确认返回</button>
        <button className="ghost icon-only" title="取消返回" onClick={() => setConfirming(false)}><X size={16} /></button>
      </div>
    );
  }

  return (
    <button className="ghost" onClick={() => setConfirming(true)}>
      <DoorOpen size={16} /> 返回房间
    </button>
  );
}

function AuthScreen({ onAuth }: { onAuth: (user: User) => void }) {
  const [name, setName] = useState('玩家');
  const [password, setPassword] = useState('123456');
  const [error, setError] = useState('');

  async function submit(mode: 'login' | 'register') {
    try {
      const user = mode === 'login' ? await login(name, password) : await register(name, password);
      onAuth(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-panel">
        <div className="brand-mark">ZP7</div>
        <h1>7人6副牌找朋友 <span className="version-label">Alpha V20260623</span></h1>
        <p>输入昵称即可本地注册。你可以开房、坐座、切AI，并让服务端按房规强校验。</p>
        <label>昵称<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>密码<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <div className="auth-actions">
          <button onClick={() => submit('login')}>登录</button>
          <button className="secondary" onClick={() => submit('register')}>注册</button>
        </div>
        {error && <div className="error-box">{error}</div>}
      </div>
    </div>
  );
}

function RoomLobby({
  rooms,
  onRefresh,
  onOpen,
  onCreate
}: {
  rooms: { id: string; name: string; phase: string; round: number }[];
  onRefresh: () => void;
  onOpen: (id: string) => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState('周末找朋友');
  return (
    <main className="lobby">
      <section className="new-room">
        <h2>开一桌</h2>
        <div className="inline-form">
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <button onClick={() => onCreate(name)}><CirclePlay size={16} /> 创建</button>
        </div>
      </section>
      <section className="room-list">
        <div className="section-head">
          <h2>房间</h2>
          <button className="ghost" onClick={onRefresh}><RotateCcw size={16} /> 刷新</button>
        </div>
        {rooms.length === 0 ? <p className="muted">还没有房间。</p> : rooms.map((room) => (
          <button className="room-row" key={room.id} onClick={() => onOpen(room.id)}>
            <span>{room.name}</span>
            <small>{room.phase} · 第{room.round}局</small>
          </button>
        ))}
      </section>
    </main>
  );
}

function Table({
  room,
  user,
  onIntent,
  onFillAiSeats
}: {
  room: GameState;
  user: User;
  onIntent: IntentSender;
  onFillAiSeats: () => Promise<void>;
}) {
  const visibleTrick = useVisibleTrick(room);
  const scoreBurst = useScoreBurst(room);
  const hostTeam = hostTeamSeats(room);
  const emptySeatCount = room.seats.filter((seat) => !seat.userId && !seat.isBot).length;
  const seatControlEnabled = room.phase === 'lobby' || room.phase === 'finished';
  const mySeatIndex = mySeat(room, user);
  const counterBidsBySeat = counterBidMarks(room);
  const [counterDetailSeat, setCounterDetailSeat] = useState<number | null>(null);
  const counterDetailBids = counterDetailSeat === null ? [] : (counterBidsBySeat.get(counterDetailSeat) ?? []);

  async function toggleAiSeat(seat: GameState['seats'][number]) {
    if (!seatControlEnabled) return;
    await onIntent({ type: 'toggle-bot', seat: seat.seat, enabled: !seat.isBot });
  }

  const tableClasses = [
    'table-felt',
    `phase-${room.phase}`,
    shouldShowPublicBid(room) ? 'public-stage' : '',
    room.phase === 'finished' ? 'settlement-mode' : ''
  ].filter(Boolean).join(' ');

  return (
    <div className={tableClasses}>
      <div className={`table-center ${room.phase === 'finished' ? 'settlement-center' : ''}`}>
        <span className="phase-chip">{phaseLabel(room.phase)}</span>
        <h2>{tableHeadline(room)}</h2>
        <p>第{room.round || 0}局 · 庄家 {seatName(room, room.dealerSeat)} · 打 {room.dealerLevel} · 闲家 {attackerScore(room)}分</p>
        <p>主花色 {room.trumpSuit ? TRUMP_NAME[room.trumpSuit] : '未定'} · {tableFocus(room)}</p>
        {room.phase === 'lobby' && emptySeatCount > 0 && (
          <button className="felt-action" onClick={onFillAiSeats}>
            <Bot size={16} /> 一键AI补齐 <span>{emptySeatCount}</span>
          </button>
        )}
        {room.phase === 'finished' && room.result && <strong>闲家 {room.result.attackerPoints} 分 · 下局庄家 {seatName(room, room.result.nextDealer)}</strong>}
        {room.phase === 'finished' && room.result ? (
          <KittySettlement room={room} />
        ) : shouldShowPublicBid(room) ? (
          <PublicBidShowcase room={room} />
        ) : visibleTrick && (
          <div className={`trick-layout ${visibleTrick.collecting ? 'collecting' : ''}`}>
            {visibleTrick.trick.plays.length === 0 ? <span className="muted-on-felt">等待 {seatName(room, room.activeSeat ?? visibleTrick.trick.leader)} 出牌</span> : visibleTrick.trick.plays.map((play) => (
              <div
                className="trick-play"
                key={play.seat}
                title={visibleTrick.trick.winner === play.seat ? '当前最大' : undefined}
              >
                <span>{seatName(room, play.seat)}</span>
                <div className="mini-card-row">
                  {play.cards.map((card) => <MiniCard card={card} highlighted={visibleTrick.trick.winner === play.seat} key={card.id} />)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {scoreBurst && (
        <div className="score-burst" key={scoreBurst.seq}>
          <strong>{scoreBurst.points > 0 ? `+${scoreBurst.points}` : '收墩'}</strong>
          <span>{seatName(room, scoreBurst.winner)} 收下第 {scoreBurst.trickIndex} 墩</span>
        </div>
      )}
      {room.seats.map((seat) => {
        const isMySeat = seat.userId === user.id;
        const canSit = seatControlEnabled && mySeatIndex === null && !seat.userId;
        const counterBids = counterBidsBySeat.get(seat.seat) ?? [];
        return (
        <div
          className={[
            'seat',
            `seat-${seat.seat}`,
            isMySeat ? 'mine' : '',
            seat.seat === room.activeSeat ? 'active' : '',
            seat.seat === room.dealerSeat ? 'dealer' : '',
            hostTeam.has(seat.seat) ? 'host-team' : '',
            scoreBurst?.winner === seat.seat ? 'score-winner' : ''
          ].filter(Boolean).join(' ')}
          key={seat.seat}
        >
          {seat.seat === room.activeSeat && (
            <span className="turn-hourglass" title={`等待 ${seatName(room, seat.seat)} 出牌`}>
              <Hourglass size={17} />
            </span>
          )}
          <div className="seat-title">
            <span>{seat.name}</span>
            <span className="seat-badges">
              {teamRole(room, seat.seat) && <em>{teamRole(room, seat.seat)}</em>}
              {counterBids.length > 0 && (
                <button
                  className="counter-star-button"
                  title="查看反底牌"
                  onClick={() => setCounterDetailSeat(seat.seat)}
                >
                  <Star size={13} fill="currentColor" />
                  {counterBids.length > 1 && <span>{counterBids.length}</span>}
                </button>
              )}
              {isMySeat && (
                <button
                  className="seat-avatar-toggle seat-leave-button"
                  title="离席，AI接管"
                  onClick={() => onIntent({ type: 'leave-seat', seat: seat.seat })}
                >
                  <LogOut size={14} />
                </button>
              )}
              {(seat.isBot || (!seat.userId && seatControlEnabled)) && (
                <button
                  className={`seat-avatar-toggle ${seat.isBot ? 'bot-on' : ''}`}
                  title={seat.isBot ? '转为空座' : '切为AI'}
                  disabled={!seatControlEnabled}
                  onClick={() => toggleAiSeat(seat)}
                >
                  <Bot size={14} />
                </button>
              )}
            </span>
          </div>
          <div className="seat-meta">
            <span>{seat.level}级</span>
            <span>{seat.handCount ?? seat.hand.length}张</span>
            <span>{seat.personalPoints}分</span>
          </div>
          <div className="seat-actions">
            {canSit && <button onClick={() => onIntent({ type: 'sit', seat: seat.seat })}>坐下</button>}
          </div>
        </div>
        );
      })}
      {counterDetailSeat !== null && counterDetailBids.length > 0 && (
        <CounterBidDetail
          bids={counterDetailBids}
          room={room}
          onClose={() => setCounterDetailSeat(null)}
        />
      )}
    </div>
  );
}

function CounterBidDetail({
  bids,
  room,
  onClose
}: {
  bids: CounterBidInfo[];
  room: GameState;
  onClose: () => void;
}) {
  const seat = bids[0]?.seat ?? null;
  return (
    <div className="counter-bid-backdrop" onClick={onClose}>
      <section className="counter-bid-detail" onClick={(event) => event.stopPropagation()}>
        <button className="counter-bid-close" onClick={onClose} title="关闭">
          <X size={15} />
        </button>
        <span>反底记录</span>
        <h3>{seatName(room, seat)}</h3>
        {bids.map((bid, index) => (
          <div className="counter-bid-entry" key={`${bid.seq}-${index}`}>
            <strong>#{bid.seq} {counterBidText(bid)}</strong>
            <div className="counter-bid-cards">
              {bid.cards.length === 0 ? (
                <small>没有拿到公开牌面</small>
              ) : bid.cards.map((card) => <MiniCard card={card} key={`${bid.seq}-${card.id}`} />)}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function Hand({
  room,
  user,
  selected,
  setSelected,
  onPlay
}: {
  room: GameState;
  user: User;
  selected: string[];
  setSelected: React.Dispatch<React.SetStateAction<string[]>>;
  onPlay: () => void;
}) {
  const seat = mySeat(room, user);
  const hand = seat === null ? [] : room.seats[seat].hand;
  const pickedKitty = new Set(room.pickedKittyCardIds ?? []);
  const piles = groupHandCards(hand, selected, pickedKitty);
  const rows = splitHandPiles(piles);
  return (
    <section className="hand-dock">
      <div className="hand-head">
        <h3>我的手牌</h3>
        <span>{hand.length} 张 · 已选 {selected.length}</span>
        <button disabled={room.activeSeat !== seat || selected.length === 0} onClick={onPlay}><Play size={15} /> 出牌</button>
      </div>
      <div className={`hand-grid ${rows.length > 1 ? 'two-rows' : 'one-row'}`}>
        {rows.map((row, rowIndex) => (
          <div className="hand-row" key={rowIndex}>
            {row.map((pile, index) => {
              const x = row.length === 1 ? 50 : (index / (row.length - 1)) * 100;
              const shift = row.length === 1 ? '-50%' : index === 0 ? '0%' : index === row.length - 1 ? '-100%' : '-50%';
              const selectedCount = pile.selectedCount;
              return (
                <button
                  key={pile.key}
                  className={[
                    'hand-pile',
                    pile.lead.suit,
                    pile.cards.length > 1 ? 'duplicated' : '',
                    pile.pickedCount > 0 ? 'kitty-pickup' : '',
                    selectedCount > 0 ? 'selected' : '',
                    selectedCount > 0 ? `selected-count-${Math.min(selectedCount, 3)}` : '',
                    selectedCount > 3 ? 'selected-count-many' : '',
                    selectedCount === pile.cards.length ? 'fully-selected' : ''
                  ].filter(Boolean).join(' ')}
                  style={{
                    left: `${x}%`,
                    '--pile-shift': shift,
                    zIndex: index + 1
                  } as React.CSSProperties}
                  title={`${cardSuitName(pile.lead)}${cardRank(pile.lead)} · ${pile.cards.length}张 · 已选${selectedCount} · 单击逐张选择`}
                  onClick={() => setSelected((current) => cyclePileSelection(current, pile.cards))}
                >
                  {pile.cards.length > 2 && <span className="pile-shadow two" />}
                  {pile.cards.length > 1 && <span className="pile-shadow one" />}
                  <span className="pile-face">
                    <span className="corner top">{cardRank(pile.lead)}<em>{SUIT_SYMBOL[pile.lead.suit]}</em></span>
                    <b>{pile.lead.rank === 'SJ' ? '小' : pile.lead.rank === 'BJ' ? '大' : SUIT_SYMBOL[pile.lead.suit]}</b>
                    <span className="corner bottom">{cardRank(pile.lead)}<em>{SUIT_SYMBOL[pile.lead.suit]}</em></span>
                    <small>{pile.cards.length > 1 ? `${pile.cards.length}张` : pile.lead.deck + 1}</small>
                  </span>
                  {pile.cards.length > 1 && <span className="pile-count-badge">×{pile.cards.length}</span>}
                  {pile.pickedCount > 0 && <span className="pile-kitty-badge">底</span>}
                  {selectedCount > 0 && <span className="pile-select-badge">{selectedCount}/{pile.cards.length}</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

type HandPile = {
  key: string;
  lead: Card;
  cards: Card[];
  selectedCount: number;
  pickedCount: number;
};

function groupHandCards(hand: Card[], selected: string[], pickedKitty: Set<string>): HandPile[] {
  const selectedSet = new Set(selected);
  const groups = new Map<string, Card[]>();
  for (const card of hand) {
    const key = `${card.suit}:${card.rank}`;
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  return [...groups.entries()].map(([key, cards]) => ({
    key,
    lead: cards[0],
    cards,
    selectedCount: cards.filter((card) => selectedSet.has(card.id)).length,
    pickedCount: cards.filter((card) => pickedKitty.has(card.id)).length
  }));
}

function splitHandPiles(piles: HandPile[]) {
  if (piles.length <= 24) return [piles];
  const split = Math.ceil(piles.length / 2);
  return [piles.slice(0, split), piles.slice(split)];
}

function cyclePileSelection(selected: string[], cards: Card[]) {
  const cardIds = cards.map((card) => card.id);
  const selectedSet = new Set(selected);
  const selectedCount = cardIds.filter((id) => selectedSet.has(id)).length;
  const nextCount = selectedCount >= cardIds.length ? 0 : selectedCount + 1;
  const withoutPile = selected.filter((id) => !cardIds.includes(id));
  return [...withoutPile, ...cardIds.slice(0, nextCount)];
}

function MiniCard({ card, highlighted = false }: { card: Card; highlighted?: boolean }) {
  return (
    <span className={`mini-card ${card.suit} ${highlighted ? 'winning' : ''}`}>
      <b>{cardRank(card)}</b>
      <i>{SUIT_SYMBOL[card.suit]}</i>
    </span>
  );
}

function PublicBidShowcase({ room }: { room: GameState }) {
  const bid = room.currentBid!;
  const action = bid.action ?? (bid.source === 'kitty' ? 'kitty' : 'bid');
  const actionText = action === 'counter' ? '反底' : action === 'kitty' ? '翻底定主' : '亮主';
  const cards = bid.cards?.length ? bid.cards : bid.cardIds.map((id) => (
    bid.suit === 'no-trump'
      ? { id, deck: 0, suit: 'joker', rank: bid.noTrumpRank ?? 'SJ' }
      : { id, deck: 0, suit: bid.suit, rank: bid.levelRank }
  ) as Card);

  return (
    <section className={`public-bid-showcase ${action}`}>
      <div className="public-bid-head">
        <span>{seatName(room, bid.seat)}</span>
        <strong>{actionText}</strong>
      </div>
      <div className="public-bid-cards" aria-label="公开亮主牌">
        {cards.map((card, index) => (
          <span className={`public-bid-card ${card.suit}`} style={{ '--bid-card-index': index } as React.CSSProperties} key={`${card.id}-${index}`}>
            <b>{cardRank(card)}</b>
            <i>{SUIT_SYMBOL[card.suit]}</i>
            <em>{card.deck + 1}</em>
          </span>
        ))}
      </div>
      <div className="public-bid-summary">
        {bid.suit === 'no-trump' ? (
          <>
            <span>2猫</span>
            <span>{bid.levelCardCount}张{jokerName(bid.noTrumpRank)}</span>
            <span>当前主花色 无主</span>
          </>
        ) : (
          <>
            <span>{bid.jokerCount}张王</span>
            <span>{bid.levelCardCount}张{SUIT_NAME[bid.suit]}{bid.levelRank}</span>
            <span>当前主花色 {SUIT_NAME[bid.suit]}</span>
          </>
        )}
      </div>
    </section>
  );
}

function jokerName(rank: 'SJ' | 'BJ' | undefined) {
  if (rank === 'SJ') return '小王';
  if (rank === 'BJ') return '大王';
  return '同类王';
}

function KittySettlement({ room }: { room: GameState }) {
  const result = room.result!;
  const bottomBonus = result.kittyPoints * result.kittyMultiplier;
  const lastTrickCardsPerSeat = room.completedTricks.at(-1)?.plays[0]?.cards.length ?? 0;
  const bottomTitle = result.bottomSaved ? '保底结算' : '抠底结算';
  const multiplierText = result.bottomSaved ? '庄家保底' : `${digLabel(lastTrickCardsPerSeat)} · 末墩每家${lastTrickCardsPerSeat}张`;

  return (
    <section className={`kitty-settlement ${result.bottomSaved ? 'saved' : 'dug'}`}>
      <div className="kitty-head">
        <span>{bottomTitle}</span>
        <strong>{outcomeText(result)}</strong>
      </div>
      <div className="kitty-cards" aria-label="底牌">
        {room.kitty.map((card, index) => (
          <span className={`kitty-card ${card.suit}`} style={{ '--deal-index': index } as React.CSSProperties} key={card.id}>
            <b>{cardRank(card)}</b>
            <i>{SUIT_SYMBOL[card.suit]}</i>
            <em>{card.deck + 1}</em>
          </span>
        ))}
      </div>
      <div className="kitty-math">
        <div style={{ '--step-index': 0 } as React.CSSProperties}>
          <span>底前闲家</span>
          <strong>{result.rawAttackerPoints}</strong>
        </div>
        <div style={{ '--step-index': 1 } as React.CSSProperties}>
          <span>底牌分</span>
          <strong>{result.kittyPoints}</strong>
        </div>
        <div style={{ '--step-index': 2 } as React.CSSProperties}>
          <span>{multiplierText}</span>
          <strong>×{result.kittyMultiplier}</strong>
        </div>
        <div style={{ '--step-index': 3 } as React.CSSProperties}>
          <span>{result.bottomSaved ? '底牌加分' : '抠底加分'}</span>
          <strong>{bottomBonus}</strong>
        </div>
      </div>
      <div className="kitty-total" style={{ '--step-index': 4 } as React.CSSProperties}>
        <span>闲家总分</span>
        <strong>{result.attackerPoints}</strong>
      </div>
      {result.mandatoryBottomPenalty && (
        <div className="kitty-penalty" style={{ '--step-index': 5 } as React.CSSProperties}>
          <span>{result.mandatoryBottomPenalty.kind === 'main' ? '主' : '副'}{result.mandatoryBottomPenalty.rank}抠底</span>
          <strong>{mandatoryPenaltyText(room, result.mandatoryBottomPenalty)}</strong>
        </div>
      )}
    </section>
  );
}

function mandatoryPenaltyText(room: GameState, penalty: NonNullable<NonNullable<GameState['result']>['mandatoryBottomPenalty']>) {
  const affected = penalty.affected.map((item) => `${seatName(room, item.seat)} ${item.from}→${item.to}`).join('、');
  const target = penalty.target ? `庄家队打回 ${penalty.target}` : '庄家队按个人级数打回';
  return affected ? `${target}：${affected}` : target;
}

function digLabel(count: number) {
  if (count === 1) return '单抠';
  if (count === 2) return '双抠';
  if (count === 3) return '三抠';
  return `${count}抠`;
}

function shouldShowPublicBid(room: GameState) {
  return !!room.currentBid && (room.phase === 'bury' || room.phase === 'counter' || room.phase === 'friend-call');
}

function outcomeText(result: NonNullable<GameState['result']>) {
  if (result.outcome === 'attackers-level-up') return `闲家升 ${result.levelDelta} 级`;
  if (result.outcome === 'attackers-down') return '庄家下台，闲家上台不升级';
  if (result.outcome === 'host-big-shutout') return '大光，庄家升 3 级';
  if (result.outcome === 'host-small-shutout') return '小光，庄家升 2 级';
  return '庄家升 1 级';
}

function cardRank(card: Card) {
  if (card.rank === 'SJ') return '小王';
  if (card.rank === 'BJ') return '大王';
  return card.rank;
}

function cardSuitName(card: Card) {
  if (card.suit === 'joker') return '王';
  return SUIT_NAME[card.suit];
}

function ActionPanel({
  room,
  user,
  selected,
  onIntent,
  onReplay
}: {
  room: GameState;
  user: User;
  selected: string[];
  onIntent: IntentSender;
  onReplay: () => void;
}) {
  const seat = mySeat(room, user);
  const [callOneSuit, setCallOneSuit] = useState<NormalSuit>('hearts');
  const [callTwoSuit, setCallTwoSuit] = useState<NormalSuit>('spades');
  const [callOneNth, setCallOneNth] = useState(2);
  const [callTwoNth, setCallTwoNth] = useState(5);
  const friendSuitOptions = useMemo(() => (Object.keys(SUIT_NAME) as NormalSuit[]).filter((suit) => suit !== room.trumpSuit), [room.trumpSuit]);
  const friendCallRank = friendCallRankForRoom(room);
  const canBidOrCounter = seat !== null &&
    room.activeSeat === seat &&
    (room.phase === 'bidding' || (room.counterEligibleSeats ?? []).includes(seat));

  useEffect(() => {
    if (!friendSuitOptions.length) return;
    if (!friendSuitOptions.includes(callOneSuit)) setCallOneSuit(friendSuitOptions[0]);
    if (!friendSuitOptions.includes(callTwoSuit)) setCallTwoSuit(friendSuitOptions[1] ?? friendSuitOptions[0]);
  }, [callOneSuit, callTwoSuit, friendSuitOptions]);
  const safeFriendSuit = (suit: NormalSuit, fallbackIndex: number) => {
    return friendSuitOptions.includes(suit) ? suit : (friendSuitOptions[fallbackIndex] ?? friendSuitOptions[0]);
  };

  return (
    <section className="action-panel">
      <h2>操作</h2>
      {room.phase === 'lobby' && <button onClick={() => onIntent({ type: 'start-game' })}><Shuffle size={16} /> 开始发牌</button>}
      {(room.phase === 'bidding' || room.phase === 'counter') && seat !== null && (
        <div className="action-stack">
          <button disabled={!canBidOrCounter || selected.length < 3} onClick={() => onIntent({ type: 'bid', seat, cardIds: selected })}>
            <Send size={16} /> {room.phase === 'bidding' ? '亮主' : '反底'}
          </button>
          <button className="secondary" disabled={!canBidOrCounter} onClick={() => onIntent({ type: 'pass-counter', seat })}>
            {room.phase === 'bidding' ? '不亮' : '不反'}
          </button>
          <small>{canBidOrCounter ? '两王+同花级牌，或2猫+n张同类王反无主。' : `等待 ${seatName(room, room.activeSeat)} 操作。`}</small>
        </div>
      )}
      {room.phase === 'bury' && seat === room.bottomOwner && (
        <div className="action-stack">
          <button disabled={selected.length !== 9} onClick={() => onIntent({ type: 'bury', seat, cardIds: selected })}>扣9张底牌</button>
          <small>不能扣任何A。</small>
        </div>
      )}
      {room.phase === 'counter' && seat !== null && (seat === room.bottomOwner || seat === room.dealerSeat) && (
        <button className="secondary" onClick={() => onIntent({ type: 'finish-counter', seat })}>结束反底</button>
      )}
      {room.phase === 'friend-call' && seat === room.dealerSeat && (
        <div className="friend-form">
          <FriendCallInput suit={callOneSuit} rank={friendCallRank} nth={callOneNth} suitOptions={friendSuitOptions} setSuit={setCallOneSuit} setNth={setCallOneNth} />
          <FriendCallInput suit={callTwoSuit} rank={friendCallRank} nth={callTwoNth} suitOptions={friendSuitOptions} setSuit={setCallTwoSuit} setNth={setCallTwoNth} />
          <button disabled={friendSuitOptions.length < 2} onClick={() => onIntent({
            type: 'call-friends',
            seat,
            calls: [
              { suit: safeFriendSuit(callOneSuit, 0), nth: callOneNth },
              { suit: safeFriendSuit(callTwoSuit, 1), nth: callTwoNth }
            ]
          })}>确认找朋友</button>
        </div>
      )}
      {room.phase === 'finished' && (
        <div className="action-stack">
          <button onClick={() => onIntent({ type: 'next-round' })}><RotateCcw size={16} /> 下一局</button>
          <button className="secondary" onClick={onReplay}><History size={16} /> 复盘</button>
        </div>
      )}
      <div className="friend-list">
        <h3>找朋友</h3>
        {room.friendCalls.length === 0 ? <p className="muted">未找朋友</p> : room.friendCalls.map((call) => (
          <FriendCallStatus call={call} room={room} key={call.id} />
        ))}
      </div>
    </section>
  );
}

function FriendCallStatus({
  call,
  room
}: {
  call: GameState['friendCalls'][number];
  room: GameState;
}) {
  if (call.matchedBy !== null) {
    const rank = call.rank ?? friendCallRankForRoom(room);
    return (
      <p className="friend-call-row matched">
        <span>{SUIT_NAME[call.suit]}第{call.nth}张{rank}</span>
        <small>· {seatName(room, call.matchedBy)} 第{call.matchedTrick ?? '?'}墩找到</small>
      </p>
    );
  }
  const rank = call.rank ?? friendCallRankForRoom(room);
  return (
    <p className="friend-call-row">
      <span>{SUIT_NAME[call.suit]}第{call.nth}张{rank}</span>
      <small>· 已见{call.seen}</small>
    </p>
  );
}

function FriendCallInput({
  suit,
  rank,
  nth,
  suitOptions,
  setSuit,
  setNth
}: {
  suit: NormalSuit;
  rank: FriendCallRank;
  nth: number;
  suitOptions: NormalSuit[];
  setSuit: (suit: NormalSuit) => void;
  setNth: (nth: number) => void;
}) {
  return (
    <div className="friend-input">
      <select value={suit} onChange={(e) => setSuit(e.target.value as NormalSuit)}>
        {suitOptions.map((option) => (
          <option value={option} key={option}>{SUIT_NAME[option]}</option>
        ))}
      </select>
      <input min={1} max={6} type="number" value={nth} onChange={(e) => setNth(Number(e.target.value))} />
      <span>张{rank}</span>
    </div>
  );
}

function friendCallRankForRoom(room: GameState): FriendCallRank {
  return room.dealerLevel === 'A' ? 'K' : 'A';
}

function EventLog({ room }: { room: GameState }) {
  const visibleEvents = currentRoundEvents(room).filter((event) => event.type !== 'ai.decision');
  return (
    <section className="event-log">
      <div className="event-log-head">
        <h2>{room.round > 0 ? `第${room.round}局事件` : '事件'}</h2>
        <span>{visibleEvents.length}条</span>
      </div>
      <div className="event-log-list" role="log">
        {visibleEvents.length === 0 ? (
          <p className="muted">暂无事件。</p>
        ) : visibleEvents.slice().reverse().map((event) => (
          <p key={event.seq}><span>#{event.seq}</span>{event.message}</p>
        ))}
      </div>
    </section>
  );
}

function currentRoundEvents(room: GameState): GameState['events'] {
  if (room.round <= 0) return room.events;
  const currentRoundPrefix = `第 ${room.round} 局开始`;
  let latestRoundStart = -1;
  for (let index = room.events.length - 1; index >= 0; index -= 1) {
    const event = room.events[index];
    if (event.type !== 'round.start') continue;
    if (latestRoundStart < 0) latestRoundStart = index;
    if (event.message.startsWith(currentRoundPrefix)) return room.events.slice(index);
  }
  return latestRoundStart >= 0 ? room.events.slice(latestRoundStart) : room.events;
}

function counterBidMarks(room: GameState): Map<number, CounterBidInfo[]> {
  const marks = new Map<number, CounterBidInfo[]>();
  for (const event of currentRoundEvents(room)) {
    if (event.type !== 'trump.counter') continue;
    const payload = event.payload;
    if (!isCounterBidPayload(payload)) continue;
    const bid: CounterBidInfo = {
      seq: event.seq,
      seat: payload.seat,
      suit: payload.suit,
      levelRank: String(payload.levelRank ?? room.dealerLevel),
      levelCardCount: Number(payload.levelCardCount ?? 0),
      jokerCount: Number(payload.jokerCount ?? 0),
      noTrumpRank: payload.noTrumpRank === 'SJ' || payload.noTrumpRank === 'BJ' ? payload.noTrumpRank : undefined,
      cards: Array.isArray(payload.cards) ? payload.cards.filter(isCardSnapshot) : []
    };
    marks.set(bid.seat, [...(marks.get(bid.seat) ?? []), bid]);
  }
  return marks;
}

function isCounterBidPayload(payload: unknown): payload is {
  seat: number;
  suit: TrumpSuit;
  levelRank?: unknown;
  levelCardCount?: unknown;
  jokerCount?: unknown;
  noTrumpRank?: unknown;
  cards?: unknown;
} {
  if (!payload || typeof payload !== 'object') return false;
  const bid = payload as { seat?: unknown; suit?: unknown };
  return typeof bid.seat === 'number' && isTrumpSuit(bid.suit);
}

function isTrumpSuit(value: unknown): value is TrumpSuit {
  return value === 'no-trump' || value === 'spades' || value === 'hearts' || value === 'clubs' || value === 'diamonds';
}

function isCardSnapshot(value: unknown): value is Card {
  if (!value || typeof value !== 'object') return false;
  const card = value as Partial<Card>;
  return typeof card.id === 'string' &&
    typeof card.deck === 'number' &&
    typeof card.suit === 'string' &&
    typeof card.rank === 'string';
}

function counterBidText(bid: CounterBidInfo) {
  if (bid.suit === 'no-trump') {
    return `2猫 + ${bid.levelCardCount}张${jokerName(bid.noTrumpRank)} · 无主`;
  }
  return `${bid.jokerCount}张王 + ${bid.levelCardCount}张${TRUMP_NAME[bid.suit]} ${bid.levelRank}`;
}

function ReplayPanel({ replay }: { replay: ReplayAnalysis }) {
  return (
    <section className="replay-panel">
      <h2>{replay.title}</h2>
      <p>{replay.summary}</p>
      <h3>身份与分数</h3>
      {replay.friendTimeline.map((line) => <p key={line}>{line}</p>)}
      <h3>个人暂存</h3>
      {replay.scoringTimeline.map((line) => <p key={line}>{line}</p>)}
      <h3>关键节点</h3>
      {replay.keyMoments.map((line) => <p key={line}>{line}</p>)}
      <h3>AI学习</h3>
      <p>{replay.learningSummary}</p>
      {replay.aiDecisionTimeline.map((line) => <p key={line}>{line}</p>)}
      <h3>问题发现</h3>
      {(replay.badDecisionTimeline.length ? replay.badDecisionTimeline : ['暂无明显坏决策标签。']).map((line) => <p key={line}>{line}</p>)}
    </section>
  );
}

function mySeat(room: GameState, user: User): number | null {
  const found = room.seats.find((seat) => seat.userId === user.id);
  return found ? found.seat : null;
}

function seatName(room: GameState, seat: number | null) {
  if (seat === null || seat === undefined) return '未定';
  return room.seats[seat]?.name ?? `座位${seat + 1}`;
}

function phaseLabel(phase: string) {
  return {
    lobby: '准备',
    bidding: '亮主',
    bury: '扣底',
    counter: '反底',
    'friend-call': '找朋友',
    playing: '出牌',
    finished: '结算'
  }[phase] ?? phase;
}

function tableHeadline(room: GameState) {
  if (room.phase === 'lobby') return room.name;
  if (room.phase === 'bidding') return '亮主阶段';
  if (room.phase === 'bury') return '扣底';
  if (room.phase === 'counter') return '反底';
  if (room.phase === 'friend-call') return '找朋友';
  if (room.phase === 'playing') return `等待 ${seatName(room, room.activeSeat)} 出牌`;
  if (room.phase === 'finished') return '本局结算';
  return room.name;
}

function tableFocus(room: GameState) {
  if (room.phase === 'lobby') return '等待开局';
  if (room.phase === 'bidding') return `等待 ${seatName(room, room.activeSeat ?? room.dealerSeat)} 亮主`;
  if (room.phase === 'bury') return `等待 ${seatName(room, room.bottomOwner)} 扣底`;
  if (room.phase === 'counter') return `等待 ${seatName(room, room.activeSeat ?? room.bottomOwner ?? room.dealerSeat)} 反底`;
  if (room.phase === 'friend-call') return `等待 ${seatName(room, room.dealerSeat)} 找朋友`;
  if (room.phase === 'playing') return `等待 ${seatName(room, room.activeSeat)} 出牌`;
  if (room.phase === 'finished') return '本局已结算';
  return `当前 ${seatName(room, room.activeSeat)}`;
}

function hostTeamSeats(room: GameState) {
  const seats = new Set<number>();
  if (room.phase === 'finished' && room.result) {
    for (const seat of room.result.hostTeam) seats.add(seat);
    return seats;
  }
  if (room.dealerSeat !== null) seats.add(room.dealerSeat);
  for (const call of room.friendCalls) {
    if (call.matchedBy !== null) seats.add(call.matchedBy);
  }
  return seats;
}

function attackerScore(room: GameState) {
  if (room.phase === 'finished' && room.result) return room.result.attackerPoints;
  const hostTeam = hostTeamSeats(room);
  return room.seats.reduce((sum, seat) => hostTeam.has(seat.seat) ? sum : sum + seat.personalPoints, 0);
}

function teamRole(room: GameState, seat: number) {
  if (seat === room.dealerSeat) return '庄家';
  if (room.friendCalls.some((call) => call.matchedBy === seat)) return '朋友';
  if (room.phase === 'finished' && room.result?.hostTeam.includes(seat)) return '庄家队';
  return '';
}

function useVisibleTrick(room: GameState) {
  const [visibleTrick, setVisibleTrick] = useState<{ trick: TrickState; collecting: boolean } | null>(null);
  const current = room.currentTrick;
  const latestCompleted = room.completedTricks.at(-1);

  useEffect(() => {
    if (current && current.plays.length > 0) {
      setVisibleTrick({ trick: current, collecting: false });
      return;
    }

    if (latestCompleted && latestCompleted.plays.length > 0) {
      setVisibleTrick({ trick: latestCompleted, collecting: true });
      const timer = window.setTimeout(() => {
        setVisibleTrick(current ? { trick: current, collecting: false } : null);
      }, 900);
      return () => window.clearTimeout(timer);
    }

    setVisibleTrick(current ? { trick: current, collecting: false } : null);
  }, [current?.index, current?.plays.length, latestCompleted?.index]);

  return visibleTrick;
}

function useScoreBurst(room: GameState) {
  const latest = latestTrickComplete(room);
  const [burst, setBurst] = useState<ReturnType<typeof latestTrickComplete>>(null);

  useEffect(() => {
    if (!latest) return;
    setBurst(latest);
    const timer = window.setTimeout(() => setBurst(null), 1800);
    return () => window.clearTimeout(timer);
  }, [latest?.seq]);

  return burst;
}

function latestTrickComplete(room: GameState) {
  const event = [...room.events].reverse().find((item) => item.type === 'trick.complete');
  if (!event) return null;
  const payload = event.payload as { winner?: unknown; points?: unknown } | undefined;
  const winner = typeof payload?.winner === 'number' ? payload.winner : null;
  const points = typeof payload?.points === 'number' ? payload.points : 0;
  const match = event.message.match(/第\s*(\d+)\s*墩/);
  return {
    seq: event.seq,
    winner,
    points,
    trickIndex: match ? Number(match[1]) : room.completedTricks.at(-1)?.index ?? 0
  };
}

createRoot(document.getElementById('root')!).render(<App />);
