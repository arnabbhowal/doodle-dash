'use client';

import { useState, useEffect, use } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSpacetimeDB, useTable, useReducer } from 'spacetimedb/react';
import { tables, reducers } from '../../../src/module_bindings';

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

interface JoinPageProps {
  params: Promise<{ code: string }>;
}

export default function JoinPage({ params }: JoinPageProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const resolvedParams = use(params);
  const roomCode = resolvedParams.code.toUpperCase();

  const { isActive: connected, identity, getConnection } = useSpacetimeDB();
  const conn = getConnection();
  const joinRoomReducer = useReducer(reducers.joinRoom);

  const [rooms, roomsReady] = useTable(tables.room);
  const [players, playersReady] = useTable(tables.player);

  const [nickname, setNickname] = useState(searchParams.get('nickname') || '');
  const [selectedColor, setSelectedColor] = useState(searchParams.get('color') || PRESET_COLORS[0]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Subscribe to room and player tables once connected
  useEffect(() => {
    if (!conn || !connected) return;
    conn.subscriptionBuilder().subscribe([
      tables.room,
      tables.player,
    ]);
  }, [conn, connected]);

  // Handle auto-joining if params are already set
  useEffect(() => {
    if (!connected || !roomsReady || !playersReady || !identity || loading) return;

    const rm = rooms.find(r => r.code === roomCode);
    if (!rm) {
      setError(`Room ${roomCode} not found.`);
      return;
    }

    if (rm.status !== 'lobby') {
      setError('Game already in progress or finished.');
      return;
    }

    // Check if player is already joined
    const alreadyJoined = players.find(
      p => p.roomId === rm.roomId && p.identity.toHexString() === identity.toHexString()
    );

    if (alreadyJoined) {
      router.replace(`/play/${roomCode}`);
      return;
    }

    // Auto-join if nickname was supplied from search params
    const queryNickname = searchParams.get('nickname');
    if (queryNickname && !loading) {
      setLoading(true);
      try {
        joinRoomReducer({
          code: roomCode,
          nickname: queryNickname,
          color: selectedColor,
        });
      } catch (err: any) {
        setError(err.message || 'Failed to join room');
        setLoading(false);
      }
    }
  }, [connected, roomsReady, playersReady, rooms, players, identity, searchParams]);

  const handleJoinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!nickname.trim()) {
      setError('Please enter a nickname');
      return;
    }
    if (!connected) {
      setError('Not connected to server yet');
      return;
    }

    const rm = rooms.find(r => r.code === roomCode);
    if (!rm) {
      setError(`Room ${roomCode} does not exist`);
      return;
    }

    setLoading(true);
    try {
      joinRoomReducer({
        code: roomCode,
        nickname: nickname.trim(),
        color: selectedColor,
      });
      // Redirect will be handled in the useEffect hook once the player record is added to the table
    } catch (err: any) {
      setError(err.message || 'Failed to join');
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-4 md:p-8">
      <div className="glass-panel w-full max-w-md">
        <h1 className="text-3xl font-extrabold text-center mb-6" style={{
          background: 'linear-gradient(to right, var(--primary), var(--secondary))',
          WebkitBackgroundClip: 'text',
          WebkitTextFillColor: 'transparent',
        }}>
          Join Room: {roomCode}
        </h1>

        {!connected || !roomsReady ? (
          <div className="text-center py-8">
            <div className="inline-block w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <p className="text-gray-400">Connecting to SpacetimeDB...</p>
          </div>
        ) : (
          <>
            {error && (
              <div className="bg-rose-950/50 border border-rose-800 text-rose-300 text-sm p-3 rounded-lg mb-4">
                {error}
              </div>
            )}

            <form onSubmit={handleJoinSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-gray-400 mb-1.5">
                  Nickname
                </label>
                <input
                  type="text"
                  placeholder="Your nickname"
                  maxLength={16}
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  className="w-full bg-slate-950/50 border border-white/10 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-indigo-500 transition-colors"
                  style={{ backgroundColor: 'var(--bg-input)' }}
                  disabled={loading}
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
                      disabled={loading}
                    />
                  ))}
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || !connected}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3.5 px-4 rounded-xl shadow-lg transition-all duration-150 disabled:opacity-50"
                style={{
                  background: 'linear-gradient(to right, var(--primary), #4f46e5)',
                  boxShadow: '0 4px 14px 0 var(--primary-glow)',
                }}
              >
                {loading ? 'Joining Room...' : 'Join Game'}
              </button>
            </form>
          </>
        )}
      </div>

      <style jsx global>{`
        .flex { display: flex; }
        .flex-col { flex-direction: column; }
        .items-center { align-items: center; }
        .justify-center { justify-content: center; }
        .text-center { text-align: center; }
        .mb-6 { margin-bottom: 1.5rem; }
        .mb-4 { margin-bottom: 1rem; }
        .mb-1.5 { margin-bottom: 0.375rem; }
        .w-full { width: 100%; }
        .max-w-md { max-width: 28rem; }
        .rounded-xl { border-radius: 0.75rem; }
        .rounded-lg { border-radius: 0.5rem; }
        .py-3 { padding-top: 0.75rem; padding-bottom: 0.75rem; }
        .py-3.5 { padding-top: 0.875rem; padding-bottom: 0.875rem; }
        .py-8 { padding-top: 2rem; padding-bottom: 2rem; }
        .px-4 { padding-left: 1rem; padding-right: 1rem; }
        .text-sm { font-size: 0.875rem; }
        .text-xs { font-size: 0.75rem; }
        .text-3xl { font-size: 1.875rem; }
        .font-bold { font-weight: 700; }
        .font-extrabold { font-weight: 800; }
        .tracking-wider { letter-spacing: 0.05em; }
        .text-gray-400 { color: rgb(156, 163, 175); }
        .text-white { color: #fff; }
        .grid { display: grid; }
        .grid-cols-8 { grid-template-columns: repeat(8, minmax(0, 1fr)); }
        .gap-2 { gap: 0.5rem; }
        .aspect-square { aspect-ratio: 1 / 1; }
        .rounded-full { border-radius: 9999px; }
        .transition-all { transition-property: all; }
        .duration-150 { transition-duration: 150ms; }
        .ring-2 { --tw-ring-width: 2px; }
        .shadow-lg { box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05); }
        .min-h-screen { min-height: 100vh; }
        .animate-spin {
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </main>
  );
}
