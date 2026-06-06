'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSpacetimeDB, useReducer } from 'spacetimedb/react';
import { reducers } from '../src/module_bindings';

const PRESET_COLORS = [
  '#ef4444', // Red
  '#3b82f6', // Blue
  '#10b981', // Green
  '#f59e0b', // Yellow
  '#f97316', // Orange
  '#8b5cf6', // Purple
  '#ec4899', // Pink
  '#14b8a6', // Teal
];

export default function Home() {
  const router = useRouter();
  const { isActive: connected } = useSpacetimeDB();
  const createRoomReducer = useReducer(reducers.createRoom);

  const [mode, setMode] = useState<'join' | 'host'>('join');
  const [code, setCode] = useState('');
  const [nickname, setNickname] = useState('');
  const [selectedColor, setSelectedColor] = useState(PRESET_COLORS[0]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Generate a random nickname on mount
  useEffect(() => {
    const nouns = ['Doodler', 'Painter', 'Artist', 'Picasso', 'Sketcher', 'Scribbler', 'DaVinci'];
    const adjectives = ['Happy', 'Crazy', 'Speedy', 'Clever', 'Wild', 'Funny', 'Super'];
    const randNoun = nouns[Math.floor(Math.random() * nouns.length)];
    const randAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
    setNickname(`${randAdj}${randNoun}`);
  }, []);

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!code.trim()) {
      setError('Please enter a room code');
      return;
    }
    if (!nickname.trim()) {
      setError('Please enter a nickname');
      return;
    }

    const cleanCode = code.trim().toUpperCase();
    if (cleanCode.length !== 4) {
      setError('Room code must be exactly 4 letters');
      return;
    }

    setLoading(true);
    // Redirect to join page which handles authentication and connection
    router.push(`/join/${cleanCode}?nickname=${encodeURIComponent(nickname)}&color=${encodeURIComponent(selectedColor)}`);
  };

  const handleHost = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!nickname.trim()) {
      setError('Please enter a nickname');
      return;
    }
    if (!connected) {
      setError('Not connected to SpacetimeDB server. Please try again in a moment.');
      return;
    }

    setLoading(true);
    const cleanCode = Math.random().toString(36).substring(2, 6).toUpperCase();

    try {
      createRoomReducer({
        code: cleanCode,
        nickname: nickname.trim(),
        color: selectedColor,
      });

      // Brief delay to ensure database transactions resolve, then redirect
      setTimeout(() => {
        router.push(`/host/${cleanCode}`);
      }, 1000);
    } catch (err: any) {
      setError(err.message || 'Failed to create room');
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-4 md:p-8">
      {/* Title / Hero */}
      <div className="text-center mb-8 float">
        <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight mb-2" style={{
          background: 'linear-gradient(to right, var(--primary), var(--secondary))',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}>
          DoodleDash
        </h1>
        <p className="text-gray-400 text-lg max-w-md">
          A real-time multiplayer drawing game powered by SpacetimeDB and Gemini AI.
        </p>
      </div>

      {/* Main Glass Panel */}
      <div className="glass-panel w-full max-w-md">
        {/* Modes tab toggle */}
        <div className="flex bg-slate-950/40 p-1 rounded-xl mb-6">
          <button
            onClick={() => { setMode('join'); setError(''); }}
            className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all duration-200 ${
              mode === 'join' 
                ? 'bg-indigo-600 text-white shadow' 
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Join Game
          </button>
          <button
            onClick={() => { setMode('host'); setError(''); }}
            className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-all duration-200 ${
              mode === 'host' 
                ? 'bg-indigo-600 text-white shadow' 
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            Host / Create
          </button>
        </div>

        {/* Server connection status indicator */}
        <div className="flex items-center justify-end text-xs mb-4 text-gray-400">
          <span className="mr-2">Server status:</span>
          <span className={`inline-block w-2.5 h-2.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-rose-500'}`}></span>
          <span className="ml-1.5 font-medium">{connected ? 'Connected' : 'Connecting...'}</span>
        </div>

        {error && (
          <div className="bg-rose-950/50 border border-rose-800 text-rose-300 text-sm p-3 rounded-lg mb-4">
            {error}
          </div>
        )}

        {mode === 'join' ? (
          <form onSubmit={handleJoin} className="space-y-4">
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1.5">
                Room Code
              </label>
              <input
                type="text"
                placeholder="4-letter code (e.g. ABCD)"
                maxLength={4}
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                className="w-full bg-slate-950/50 border border-white/10 rounded-xl px-4 py-3 text-lg font-bold uppercase tracking-widest text-center text-white focus:outline-none focus:border-indigo-500 transition-colors"
                style={{ backgroundColor: 'var(--bg-input)' }}
              />
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1.5">
                Nickname
              </label>
              <input
                type="text"
                placeholder="Pick a nickname"
                maxLength={16}
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                className="w-full bg-slate-950/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 transition-colors"
                style={{ backgroundColor: 'var(--bg-input)' }}
              />
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-2">
                Choose Color
              </label>
              <div className="grid grid-cols-8 gap-2">
                {PRESET_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setSelectedColor(color)}
                    className={`w-full aspect-square rounded-full transition-all duration-150 ${
                      selectedColor === color 
                        ? 'ring-2 ring-white ring-offset-2 ring-offset-[#0b0d19] scale-110' 
                        : 'hover:scale-105 opacity-80 hover:opacity-100'
                    }`}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3.5 px-4 rounded-xl shadow-lg transition-all duration-150 disabled:opacity-50"
              style={{
                background: 'linear-gradient(to right, var(--primary), #4f46e5)',
                boxShadow: '0 4px 14px 0 var(--primary-glow)',
              }}
            >
              {loading ? 'Joining...' : 'Enter Game'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleHost} className="space-y-4">
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1.5">
                Host Nickname
              </label>
              <input
                type="text"
                placeholder="Host nickname"
                maxLength={16}
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                className="w-full bg-slate-950/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 transition-colors"
                style={{ backgroundColor: 'var(--bg-input)' }}
              />
            </div>

            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-2">
                Host Color
              </label>
              <div className="grid grid-cols-8 gap-2">
                {PRESET_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setSelectedColor(color)}
                    className={`w-full aspect-square rounded-full transition-all duration-150 ${
                      selectedColor === color 
                        ? 'ring-2 ring-white ring-offset-2 ring-offset-[#0b0d19] scale-110' 
                        : 'hover:scale-105 opacity-80 hover:opacity-100'
                    }`}
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !connected}
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3.5 px-4 rounded-xl shadow-lg transition-all duration-150 disabled:opacity-50"
              style={{
                background: 'linear-gradient(to right, var(--secondary), #db2777)',
                boxShadow: '0 4px 14px 0 rgba(236, 72, 153, 0.3)',
              }}
            >
              {loading ? 'Creating...' : 'Create & Host Room'}
            </button>
          </form>
        )}
      </div>

      <style jsx global>{`
        /* Minimal fallback utility classes matching Tailwind */
        .flex { display: flex; }
        .flex-col { flex-direction: column; }
        .items-center { align-items: center; }
        .justify-center { justify-content: center; }
        .text-center { text-align: center; }
        .mb-8 { margin-bottom: 2rem; }
        .mb-6 { margin-bottom: 1.5rem; }
        .mb-4 { margin-bottom: 1rem; }
        .mb-2 { margin-bottom: 0.5rem; }
        .mb-1.5 { margin-bottom: 0.375rem; }
        .mr-2 { margin-right: 0.5rem; }
        .ml-1.5 { margin-left: 0.375rem; }
        .w-full { width: 100%; }
        .max-w-md { max-width: 28rem; }
        .bg-slate-950\/40 { background-color: rgba(2, 6, 23, 0.4); }
        .p-1 { padding: 0.25rem; }
        .p-4 { padding: 1rem; }
        .rounded-xl { border-radius: 0.75rem; }
        .rounded-lg { border-radius: 0.5rem; }
        .flex-1 { flex: 1 1 0%; }
        .py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; }
        .py-3 { padding-top: 0.75rem; padding-bottom: 0.75rem; }
        .py-3.5 { padding-top: 0.875rem; padding-bottom: 0.875rem; }
        .px-4 { padding-left: 1rem; padding-right: 1rem; }
        .text-sm { font-size: 0.875rem; }
        .text-xs { font-size: 0.75rem; }
        .text-lg { font-size: 1.125rem; }
        .text-5xl { font-size: 3rem; }
        .text-6xl { font-size: 3.75rem; }
        .font-semibold { font-weight: 600; }
        .font-bold { font-weight: 700; }
        .font-extrabold { font-weight: 800; }
        .font-medium { font-weight: 500; }
        .tracking-tight { letter-spacing: -0.025em; }
        .tracking-wider { letter-spacing: 0.05em; }
        .tracking-widest { letter-spacing: 0.1em; }
        .text-gray-400 { color: rgb(156, 163, 175); }
        .text-white { color: #fff; }
        .uppercase { text-transform: uppercase; }
        .space-y-4 > * + * { margin-top: 1rem; }
        .grid { display: grid; }
        .grid-cols-8 { grid-template-columns: repeat(8, minmax(0, 1fr)); }
        .gap-2 { gap: 0.5rem; }
        .aspect-square { aspect-ratio: 1 / 1; }
        .rounded-full { border-radius: 9999px; }
        .transition-all { transition-property: all; }
        .duration-200 { transition-duration: 200ms; }
        .duration-150 { transition-duration: 150ms; }
        .ring-2 { --tw-ring-width: 2px; }
        .shadow-lg { box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05); }
        .min-h-screen { min-height: 100vh; }
      `}</style>
    </main>
  );
}
