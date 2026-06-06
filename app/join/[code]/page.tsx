'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useReducer, useTable } from 'spacetimedb/react';
import { reducers, tables } from '../../../src/module_bindings';
import { BrutalButton } from '../../components/BrutalButton';
import { BrutalCard } from '../../components/BrutalCard';

const COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6','#8b5cf6','#ec4899','#e2e8f0','#94a3b8'];

export default function JoinPage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const joinRoom = useReducer(reducers.joinRoom);

  const [nickname, setNickname] = useState('');
  const [color, setColor] = useState(COLORS[3]);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');

  const [rooms] = useTable(tables.room.where(r => r.code.eq(code)));
  const room = rooms[0];

  const handleJoin = () => {
    if (!nickname.trim()) return;
    setJoining(true);
    setError('');
    try {
      joinRoom({ code, nickname: nickname.trim(), color });
      router.push(`/play/${code}`);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to join');
      setJoining(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <BrutalCard
        color="surface"
        className="w-full max-w-[440px] flex flex-col gap-6 !p-8"
        initial={{ opacity: 0, y: 24, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 18 }}
      >
        <div className="text-center">
          <p className="text-sm font-display uppercase tracking-widest text-[var(--cyan)] mb-1">Joining room</p>
          <h1 className="font-display font-black uppercase tracking-[0.12em] text-5xl text-[var(--magenta)] leading-none">{code}</h1>
          {room && (
            <p className="text-sm text-white/70 mt-2">
              {room.status === 'lobby' ? 'Lobby is open' : 'Game already in progress'}
            </p>
          )}
        </div>

        <div>
          <label className="block text-sm font-display uppercase tracking-wide text-[var(--cyan)] mb-2">Your nickname</label>
          <input
            placeholder="e.g. PicassoJr"
            value={nickname}
            onChange={e => setNickname(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleJoin()}
            maxLength={20}
            autoFocus
            className="w-full border-4 border-black bg-[var(--surface)] rounded-2xl p-4 text-xl font-display font-bold text-white shadow-[4px_4px_0_0_#000] focus:outline-none focus:border-[var(--magenta)]"
          />
        </div>

        <div>
          <label className="block text-sm font-display uppercase tracking-wide text-[var(--cyan)] mb-3">Pick your color</label>
          <div className="flex flex-wrap gap-2.5">
            {COLORS.map(c => (
              <button
                key={c}
                onClick={() => setColor(c)}
                style={{ background: c }}
                className={`w-10 h-10 rounded-full border-4 transition-transform shadow-[3px_3px_0_0_#000] ${
                  color === c ? 'border-white scale-110' : 'border-black'
                }`}
              />
            ))}
          </div>
        </div>

        {error && <p className="text-[var(--red)] font-display font-bold text-sm">{error}</p>}

        <BrutalButton
          color="magenta"
          size="xl"
          onClick={handleJoin}
          disabled={!nickname.trim() || joining}
          className="w-full !text-2xl !py-5 mt-1"
        >
          {joining ? 'Joining…' : 'Join Game'}
        </BrutalButton>
      </BrutalCard>
    </div>
  );
}
