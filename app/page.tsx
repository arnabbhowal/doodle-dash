'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion, AnimatePresence } from 'motion/react';
import { useReducer } from 'spacetimedb/react';
import { reducers } from '../src/module_bindings';
import { BrutalButton } from './components/BrutalButton';
import { BrutalCard } from './components/BrutalCard';
import { DoodleBackground } from './components/DoodleBackground';

function randomCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// Presentation-only game rules shown in the How to Play modal. Kept in sync with the
// real game: AI + speed scoring, the self-grade bonus, and Board Hijack sabotage.
const HOW_TO: { icon: string; title: string; color: string; body: string }[] = [
  { icon: '🎯', title: 'The Goal', color: 'var(--magenta)', body: "Everyone gets the SAME word and races to draw it on their phone before the timer runs out. The host screen shows the word; your phone is the canvas." },
  { icon: '🤖', title: 'Scoring', color: 'var(--green)', body: "An AI judge scores every drawing 0–100 on how recognizable it is. You also bank a Speed Bonus — one point for each second left when you hit submit. Round score = AI score + speed." },
  { icon: '⭐', title: 'Self-Grade Bonus', color: 'var(--yellow)', body: "Right after you submit, guess your own AI score. Land within ±5 of it (and score at least 20) and you grab a +100 point bonus." },
  { icon: '😈', title: 'Sabotage: Board Hijack', color: 'var(--red)', body: "Once per game — after you've submitted — you can hijack a player who hasn't submitted yet and scribble all over their canvas for 10 seconds. Pile on: several players can hijack the same board at once." },
  { icon: '🏆', title: 'Reveal & Win', color: 'var(--cyan)', body: "Each round reveals the gallery, the AI's guesses and savage roasts, and the running leaderboard. Highest total after the final round is crowned Champion." },
  { icon: '💀', title: 'Hall of Shame', color: 'var(--magenta)', body: "When it's all over, the three lowest-scoring doodles get immortalized — complete with the AI's best guess at what they were supposed to be." },
];

export default function Home() {
  const router = useRouter();
  const createRoom = useReducer(reducers.createRoom);

  const [view, setView] = useState<'main' | 'join'>('main');
  const [joinCode, setJoinCode] = useState('');
  const [creating, setCreating] = useState(false);
  const [showHowTo, setShowHowTo] = useState(false);

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
    <div className="min-h-screen relative flex flex-col items-center justify-center gap-10 p-8 overflow-hidden bg-white">
      {/* Interactive doodle field over a white background */}
      <DoodleBackground className="absolute inset-0 z-0" />

      <div className="relative z-10 text-center">
        <h1 className="font-display font-black uppercase tracking-tight text-7xl sm:text-8xl text-[#0E0E16] leading-none drop-shadow-[5px_5px_0_var(--magenta)]">
          Doodle<span className="text-[var(--magenta)] drop-shadow-[5px_5px_0_#0E0E16]">Dash</span>
        </h1>
        <p className="mt-5 text-xl font-display font-bold uppercase tracking-widest text-[#0E0E16]/70">
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
            <BrutalButton color="green" size="lg" onClick={() => setShowHowTo(true)} className="w-full">
              How to Play
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
            <BrutalButton color="surface" size="md" sound="back" onClick={() => { setView('main'); setJoinCode(''); }} className="w-full">
              Back
            </BrutalButton>
          </>
        )}
      </div>

      <AnimatePresence>
        {showHowTo && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setShowHowTo(false)}
          >
            <BrutalCard
              color="surface"
              className="relative w-full max-w-[560px] max-h-[85vh] overflow-y-auto !p-7"
              initial={{ scale: 0.9, y: 20, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.9, y: 20, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 260, damping: 22 }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setShowHowTo(false)}
                aria-label="Close"
                className="absolute top-4 right-4 w-9 h-9 rounded-full border-[3px] border-black bg-[var(--red)] text-white font-display font-black shadow-[2px_2px_0_0_#000] flex items-center justify-center hover:scale-110 active:scale-95 transition-transform"
              >
                ✕
              </button>
              <h2 className="font-display font-black uppercase tracking-tight text-4xl text-white mb-1">How to Play</h2>
              <p className="font-display uppercase tracking-widest text-[var(--cyan)] text-sm mb-6">Draw fast. Get roasted. Win.</p>
              <div className="flex flex-col gap-5">
                {HOW_TO.map((s) => (
                  <div key={s.title} className="border-l-4 pl-4" style={{ borderColor: s.color }}>
                    <h3 className="font-display font-black uppercase text-lg" style={{ color: s.color }}>{s.icon} {s.title}</h3>
                    <p className="text-white/80 text-sm leading-relaxed mt-1">{s.body}</p>
                  </div>
                ))}
              </div>
              <BrutalButton color="magenta" size="lg" onClick={() => setShowHowTo(false)} className="w-full mt-7">
                Got it!
              </BrutalButton>
            </BrutalCard>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
