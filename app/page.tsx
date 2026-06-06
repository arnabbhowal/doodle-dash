'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../src/module_bindings';
import { BrutalButton } from './components/BrutalButton';

function randomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export default function Home() {
  const router = useRouter();
  const createRoom = useReducer(reducers.createRoom);

  const [view, setView] = useState<'main' | 'join'>('main');
  const [joinCode, setJoinCode] = useState('');
  const [creating, setCreating] = useState(false);

  const handleCreate = () => {
    const code = randomCode();
    setCreating(true);
    createRoom({ code });
    router.push(`/host/${code}`);
  };

  const handleJoin = () => {
    const c = joinCode.trim().toUpperCase();
    if (!c) return;
    router.push(`/join/${c}`);
  };

  return (
    <div className="min-h-screen relative flex flex-col items-center justify-center gap-10 p-8 overflow-hidden">
      {/* Doodle background + light overlay (doodle stays prominent) */}
      <div
        className="absolute inset-0 z-0"
        style={{ backgroundImage: 'url(/doodle-background.png)', backgroundSize: 'cover', backgroundPosition: 'center' }}
      />
      <div className="absolute inset-0 z-0 bg-[var(--canvas)]/55" />

      <div className="relative z-10 text-center">
        <h1 className="font-display font-black uppercase tracking-tight text-7xl sm:text-8xl text-white leading-none drop-shadow-[5px_5px_0_var(--magenta)]">
          Doodle<span className="text-[var(--yellow)] drop-shadow-[5px_5px_0_var(--magenta)]">Dash</span>
        </h1>
        <p className="mt-5 text-xl font-display font-medium uppercase tracking-widest text-[var(--cyan)] drop-shadow-[2px_2px_0_#000]">
          Draw fast. Get roasted. Win.
        </p>
      </div>

      <div className="relative z-10 flex flex-col items-center gap-5 w-full max-w-[420px]">
        {view === 'main' ? (
          <>
            <BrutalButton color="magenta" size="xl" onClick={handleCreate} disabled={creating} className="w-full !text-2xl !py-6">
              {creating ? 'Creating…' : 'Host Game'}
            </BrutalButton>
            <BrutalButton color="cyan" size="xl" onClick={() => setView('join')} className="w-full !text-2xl !py-6">
              Join Game
            </BrutalButton>
          </>
        ) : (
          <>
            <input
              autoFocus
              placeholder="Enter room code"
              value={joinCode}
              onChange={e => setJoinCode(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && handleJoin()}
              maxLength={8}
              className="w-full border-4 border-black bg-[var(--surface)] rounded-2xl p-4 text-2xl font-display font-bold tracking-[0.18em] text-center text-white shadow-[4px_4px_0_0_#000] focus:outline-none focus:border-[var(--magenta)]"
            />
            <BrutalButton color="cyan" size="xl" onClick={handleJoin} disabled={!joinCode.trim()} className="w-full !text-2xl !py-6">
              Join Game
            </BrutalButton>
            <BrutalButton color="surface" size="md" onClick={() => { setView('main'); setJoinCode(''); }} className="w-full">
              Back
            </BrutalButton>
          </>
        )}
      </div>
    </div>
  );
}
