'use client';

import { useState, useEffect, useMemo, use } from 'react';
import { useRouter } from 'next/navigation';
import { useSpacetimeDB, useTable, useReducer } from 'spacetimedb/react';
import { tables, reducers } from '../../../src/module_bindings';

interface HostPageProps {
  params: Promise<{ code: string }>;
}

export default function HostPage({ params }: HostPageProps) {
  const router = useRouter();
  const resolvedParams = use(params);
  const roomCode = resolvedParams.code.toUpperCase();

  const { isActive: connected, identity, getConnection } = useSpacetimeDB();
  const conn = getConnection();

  // Reducer Hooks
  const startGameReducer = useReducer(reducers.startGame);
  const nextRoundReducer = useReducer(reducers.nextRound);
  const endGameReducer = useReducer(reducers.endGame);
  const kickPlayerReducer = useReducer(reducers.kickPlayer);

  // Table Hooks
  const [rooms, roomsReady] = useTable(tables.room);
  const [players, playersReady] = useTable(tables.player);
  const [rounds, roundsReady] = useTable(tables.round);
  const [drawings, drawingsReady] = useTable(tables.drawing);

  // Local config states (lobby only)
  const [totalRounds, setTotalRounds] = useState(3);
  const [wordSource, setWordSource] = useState<'preset' | 'custom'>('preset');
  const [customWords, setCustomWords] = useState('');

  // Active round timer state
  const [timeLeft, setTimeLeft] = useState(30);

  // Reveal phase animation states
  const [revealIndex, setRevealIndex] = useState(0);

  // Subscribe to tables
  useEffect(() => {
    if (!conn || !connected) return;
    conn.subscriptionBuilder().subscribe([
      tables.room,
      tables.player,
      tables.round,
      tables.drawing,
    ]);
  }, [conn, connected]);

  // Find current room
  const room = useMemo(() => rooms.find(r => r.code === roomCode), [rooms, roomCode]);

  // Find all players in this room
  const roomPlayers = useMemo(() => {
    if (!room) return [];
    return players
      .filter(p => p.roomId === room.roomId)
      .sort((a, b) => b.totalScore - a.totalScore); // Sort by score descending
  }, [players, room]);

  // Find current round
  const currentRound = useMemo(() => {
    if (!room) return null;
    return rounds.find(r => r.roomId === room.roomId && r.roundNumber === room.currentRound);
  }, [rounds, room]);

  // Find drawings for current round
  const currentDrawings = useMemo(() => {
    if (!currentRound) return [];
    return drawings.filter(d => d.roundId === currentRound.roundId);
  }, [drawings, currentRound]);

  // QR Code Join URL
  const joinUrl = useMemo(() => {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}/join/${roomCode}`;
  }, [roomCode]);

  const qrUrl = useMemo(() => {
    return `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(joinUrl)}`;
  }, [joinUrl]);

  // Sync Timer for active round
  useEffect(() => {
    if (!currentRound || currentRound.status !== 'drawing') return;

    const interval = setInterval(() => {
      const endsAtSeconds = Number(currentRound.endsAt / 1000000n);
      const nowSeconds = Date.now() / 1000;
      const left = Math.max(0, Math.ceil(endsAtSeconds - nowSeconds));
      setTimeLeft(left);
      
      // If timer is out, clear interval
      if (left <= 0) {
        clearInterval(interval);
      }
    }, 200);

    return () => clearInterval(interval);
  }, [currentRound]);

  // Auto-scavenge judging triggers on host if some player drawings are stuck unscored
  useEffect(() => {
    if (!room || room.status !== 'scoring' || !currentRound || !conn) return;

    // Check drawings that are submitted but NOT scored
    const unscored = currentDrawings.filter(d => d.submitted && !d.scored && d.imageUrl);
    if (unscored.length === 0) return;

    // Trigger score_drawing procedure on behalf of players (failsafe)
    const runFailsafeScoring = async () => {
      for (const dw of unscored) {
        try {
          console.log(`Failsafe: Host triggering scoring for player ID ${dw.playerId}`);
          const imgUrl = dw.imageUrl;
          if (!imgUrl) continue;
          
          const response = await fetch(imgUrl);
          const blob = await response.blob();
          const reader = new FileReader();
          reader.readAsDataURL(blob);
          reader.onloadend = () => {
            const base64data = (reader.result as string).split(',')[1];
            conn.procedures.scoreDrawing({
              roundId: currentRound.roundId,
              playerId: dw.playerId,
              imageBase64: base64data,
              word: currentRound.word
            }).catch(err => console.error("Failsafe scoring error:", err));
          };
        } catch (e) {
          console.error("Failsafe fetching error:", e);
        }
      }
    };

    runFailsafeScoring();
  }, [room?.status, currentDrawings, currentRound, conn]);

  // Reset reveal index when transitioning to reveal phase
  useEffect(() => {
    if (room?.status === 'reveal') {
      setRevealIndex(0);
    }
  }, [room?.status]);

  if (!connected || !roomsReady || !playersReady) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4">
        <div className="glass-panel text-center py-8 px-12">
          <div className="inline-block w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4"></div>
          <p className="text-gray-300 text-lg">Connecting Host Console...</p>
        </div>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4">
        <div className="glass-panel text-center max-w-md">
          <h2 className="text-2xl font-bold text-rose-400 mb-4">Room Not Found</h2>
          <p className="text-gray-400 mb-6">The room code {roomCode} doesn't match any active game rooms.</p>
          <button
            onClick={() => router.push('/')}
            className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2 px-6 rounded-xl transition-colors"
          >
            Back to Home
          </button>
        </div>
      </div>
    );
  }

  // Determine host auth
  const isMeHost = room.hostIdentity.toHexString() === identity?.toHexString();

  const handleStartGame = () => {
    startGameReducer({
      totalRounds,
      wordSource,
      customWords: wordSource === 'custom' && customWords ? customWords : undefined,
    });
  };

  const handleNextRound = () => {
    nextRoundReducer();
  };

  const handleEndGame = () => {
    endGameReducer();
  };

  return (
    <main className="min-h-screen p-6 md:p-12 flex flex-col justify-between max-w-7xl mx-auto">
      {/* Header Info */}
      <header className="flex flex-col sm:flex-row justify-between items-center bg-slate-900/50 backdrop-blur border border-white/5 p-4 rounded-2xl mb-8">
        <div className="flex items-center space-x-4">
          <span className="text-2xl font-black tracking-wide text-white uppercase">DoodleDash</span>
          <span className="bg-indigo-950 border border-indigo-700 text-indigo-300 font-bold px-3 py-1 rounded-lg text-sm uppercase tracking-wider">
            Host Panel
          </span>
        </div>
        <div className="flex items-center space-x-6 mt-4 sm:mt-0">
          <div className="text-center sm:text-right">
            <p className="text-xs text-gray-400 font-semibold uppercase">Room Code</p>
            <p className="text-3xl font-black text-indigo-400 tracking-widest">{roomCode}</p>
          </div>
          {room.status !== 'lobby' && room.status !== 'finished' && (
            <div className="text-center sm:text-right">
              <p className="text-xs text-gray-400 font-semibold uppercase">Round</p>
              <p className="text-2xl font-black text-white">{room.currentRound} / {room.totalRounds}</p>
            </div>
          )}
        </div>
      </header>

      {/* Primary Console Layout */}
      <div className="flex-grow flex flex-col lg:flex-row gap-8 items-stretch mb-8">
        {/* LOBBY VIEW */}
        {room.status === 'lobby' && (
          <>
            {/* Left side: QR joiner and Settings */}
            <div className="flex-1 glass-panel flex flex-col justify-between">
              <div>
                <h2 className="text-2xl font-bold mb-6 text-white border-b border-white/5 pb-3">Lobby Configuration</h2>
                
                {isMeHost ? (
                  <div className="space-y-6">
                    {/* Rounds Selector */}
                    <div>
                      <label className="block text-sm font-semibold text-gray-400 mb-2">
                        Total Rounds: <span className="text-indigo-400 font-bold">{totalRounds}</span>
                      </label>
                      <input
                        type="range"
                        min={1}
                        max={5}
                        value={totalRounds}
                        onChange={(e) => setTotalRounds(Number(e.target.value))}
                        className="w-full h-2 bg-slate-950 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                      />
                    </div>

                    {/* Word source Selector */}
                    <div>
                      <label className="block text-sm font-semibold text-gray-400 mb-2">Word Bank</label>
                      <div className="flex bg-slate-950/40 p-1 rounded-xl">
                        <button
                          onClick={() => setWordSource('preset')}
                          className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                            wordSource === 'preset' ? 'bg-indigo-600 text-white' : 'text-gray-400'
                          }`}
                        >
                          Preset list (50 words)
                        </button>
                        <button
                          onClick={() => setWordSource('custom')}
                          className={`flex-1 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                            wordSource === 'custom' ? 'bg-indigo-600 text-white' : 'text-gray-400'
                          }`}
                        >
                          Custom Word List
                        </button>
                      </div>
                    </div>

                    {/* Custom word list input */}
                    {wordSource === 'custom' && (
                      <div>
                        <label className="block text-sm font-semibold text-gray-400 mb-1.5">
                          Custom Words (comma separated)
                        </label>
                        <textarea
                          placeholder="cat, ice cream, rocket ship, pizza, cactus..."
                          value={customWords}
                          onChange={(e) => setCustomWords(e.target.value)}
                          className="w-full h-24 bg-slate-950/50 border border-white/10 rounded-xl p-3 text-sm text-white focus:outline-none focus:border-indigo-500 transition-colors"
                          style={{ backgroundColor: 'var(--bg-input)' }}
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-gray-400">Waiting for Host to configure and start the game...</p>
                )}
              </div>

              {/* Start game Trigger */}
              {isMeHost && (
                <div className="mt-8 pt-4 border-t border-white/5">
                  <button
                    onClick={handleStartGame}
                    disabled={roomPlayers.length === 0}
                    className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 px-6 rounded-xl transition-all shadow-lg shadow-indigo-600/20 disabled:opacity-50"
                  >
                    Start Game ({roomPlayers.length} Player{roomPlayers.length !== 1 ? 's' : ''})
                  </button>
                </div>
              )}
            </div>

            {/* Right side: Player list and QR code */}
            <div className="lg:w-[380px] flex flex-col gap-6">
              {/* QR Join box */}
              <div className="glass-panel text-center flex flex-col items-center justify-center py-6">
                <p className="text-sm text-gray-400 font-bold uppercase tracking-wide mb-4">Scan to Join</p>
                <div className="bg-white p-3 rounded-2xl inline-block mb-3">
                  <img src={qrUrl} alt="Join QR Code" className="w-[180px] h-[180px]" />
                </div>
                <p className="text-xs text-indigo-400 font-semibold select-all truncate max-w-full px-4">{joinUrl}</p>
              </div>

              {/* Player List */}
              <div className="glass-panel flex-grow">
                <h3 className="text-lg font-bold mb-4 text-white">Joined Players ({roomPlayers.length})</h3>
                <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                  {roomPlayers.length === 0 ? (
                    <p className="text-gray-500 text-sm italic py-4">Waiting for players to connect...</p>
                  ) : (
                    roomPlayers.map((p) => (
                      <div key={p.playerId.toString()} className="flex items-center justify-between bg-slate-950/30 border border-white/5 p-3 rounded-xl">
                        <div className="flex items-center space-x-3">
                          <span className="w-3.5 h-3.5 rounded-full" style={{ backgroundColor: p.avatarColor }} />
                          <span className="font-semibold text-white">{p.nickname}</span>
                          {p.isHost && <span className="text-[10px] bg-amber-500/20 text-amber-300 border border-amber-500/30 px-1.5 py-0.5 rounded font-black">HOST</span>}
                          {!p.connected && <span className="text-[10px] text-gray-500 italic">disconnected</span>}
                        </div>
                        {isMeHost && !p.isHost && (
                          <button
                            onClick={() => kickPlayerReducer({ targetPlayerId: p.playerId })}
                            className="text-rose-400 hover:text-rose-300 text-xs font-bold"
                          >
                            Kick
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {/* IN ROUND VIEW */}
        {room.status === 'in_round' && currentRound && (
          <div className="flex-grow flex flex-col gap-6 lg:flex-row">
            {/* Round info card */}
            <div className="flex-1 glass-panel flex flex-col justify-between py-12 px-8 text-center items-center">
              <div>
                <p className="text-indigo-400 text-sm font-extrabold uppercase tracking-widest mb-2">The word to draw is</p>
                <h2 className="text-6xl font-black text-white tracking-wide uppercase mb-8">{currentRound.word}</h2>
                
                {/* Large countdown timer */}
                <div className="relative inline-flex items-center justify-center">
                  <svg className="w-48 h-48 transform -rotate-90">
                    <circle
                      cx="96"
                      cy="96"
                      r="84"
                      stroke="rgba(255,255,255,0.05)"
                      strokeWidth="12"
                      fill="transparent"
                    />
                    <circle
                      cx="96"
                      cy="96"
                      r="84"
                      stroke={timeLeft > 10 ? 'var(--primary)' : 'var(--danger)'}
                      strokeWidth="12"
                      fill="transparent"
                      strokeDasharray="527"
                      strokeDashoffset={527 - (527 * timeLeft) / 30}
                      className="transition-all duration-300"
                    />
                  </svg>
                  <span className="absolute text-5xl font-black text-white">{timeLeft}s</span>
                </div>
              </div>
              <p className="text-gray-400 text-sm mt-8">Check your phone/controller screen to draw. Submit before timer ends!</p>
            </div>

            {/* Submissions checklist */}
            <div className="lg:w-[380px] glass-panel flex flex-col justify-between">
              <div>
                <h3 className="text-lg font-bold mb-4 text-white pb-2 border-b border-white/5">Submissions</h3>
                <div className="space-y-3">
                  {roomPlayers.map((p) => {
                    const drawingSubmitted = currentDrawings.some(d => d.playerId === p.playerId && d.submitted);
                    return (
                      <div key={p.playerId.toString()} className="flex items-center justify-between bg-slate-900/40 p-3 rounded-xl border border-white/5">
                        <div className="flex items-center space-x-3">
                          <span className="w-3.5 h-3.5 rounded-full" style={{ backgroundColor: p.avatarColor }} />
                          <span className="font-semibold text-gray-200">{p.nickname}</span>
                        </div>
                        {drawingSubmitted ? (
                          <span className="text-xs bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 px-2 py-1 rounded-lg font-bold">✓ Submitted</span>
                        ) : (
                          <span className="text-xs bg-slate-950/50 text-gray-500 px-2 py-1 rounded-lg italic">Drawing...</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* SCORING / JUDGING VIEW */}
        {room.status === 'scoring' && (
          <div className="flex-grow glass-panel flex flex-col items-center justify-center text-center py-16">
            <div className="inline-block w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-6"></div>
            <h2 className="text-3xl font-black mb-4">Gemini AI is judging drawings...</h2>
            <p className="text-gray-400 max-w-md mb-8">
              Calculating recognizability scores, making visual guesses, and preparing roasts.
            </p>
            
            {/* Progress Bar */}
            <div className="w-full max-w-md bg-slate-950/60 rounded-full h-3 mb-2 border border-white/5 overflow-hidden">
              <div 
                className="bg-indigo-500 h-full transition-all duration-300"
                style={{ 
                  width: `${roomPlayers.length > 0 ? (currentDrawings.filter(d => d.scored).length / roomPlayers.length) * 100 : 0}%` 
                }}
              />
            </div>
            <p className="text-sm font-semibold text-indigo-400">
              Scored {currentDrawings.filter(d => d.scored).length} of {roomPlayers.length} drawings
            </p>
          </div>
        )}

        {/* REVEAL / SCOREBOARD VIEW */}
        {room.status === 'reveal' && currentRound && (
          <div className="flex-grow flex flex-col gap-6 lg:flex-row">
            {/* Drawing reveals */}
            <div className="flex-grow glass-panel flex flex-col justify-between">
              <div>
                <h3 className="text-lg font-bold mb-4 text-white pb-2 border-b border-white/5">
                  Reveal: Drawing {revealIndex + 1} of {currentDrawings.length}
                </h3>

                {currentDrawings.length > 0 ? (
                  (() => {
                    const activeDrawing = currentDrawings[revealIndex];
                    if (!activeDrawing) return null;
                    const artist = roomPlayers.find(p => p.playerId === activeDrawing.playerId);
                    
                    return (
                      <div className="flex flex-col md:flex-row gap-8 items-center md:items-stretch py-4">
                        {/* Canvas Image */}
                        <div className="w-full md:w-1/2 aspect-square bg-white border border-white/10 rounded-2xl overflow-hidden flex items-center justify-center p-2 relative shadow-2xl">
                          {activeDrawing.imageUrl ? (
                            <img src={activeDrawing.imageUrl} alt="Submitted Canvas" className="max-w-full max-h-full object-contain" />
                          ) : (
                            <div className="text-gray-400 italic font-bold">No Drawing Submitted</div>
                          )}
                          <div className="absolute bottom-4 left-4 bg-slate-950/80 backdrop-blur border border-white/10 text-white font-extrabold px-4 py-2 rounded-xl text-sm flex items-center space-x-2">
                            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: artist?.avatarColor }} />
                            <span>{artist?.nickname}</span>
                          </div>
                        </div>

                        {/* Gemini scores, guesses, roasts */}
                        <div className="w-full md:w-1/2 flex flex-col justify-between space-y-6">
                          <div>
                            <p className="text-xs text-gray-400 font-bold uppercase tracking-wider mb-1">AI Guess</p>
                            <h4 className="text-3xl font-black text-indigo-400 uppercase tracking-wide mb-4">
                              {activeDrawing.aiGuess ? `"${activeDrawing.aiGuess}"` : "¯\\_(ツ)_/¯"}
                            </h4>

                            <div className="bg-indigo-950/20 border border-indigo-900/30 p-4 rounded-xl mb-4">
                              <p className="text-xs text-indigo-300 font-bold uppercase tracking-wider mb-1">AI Critique & Roast</p>
                              <p className="text-gray-300 italic">"{activeDrawing.aiRoast}"</p>
                            </div>
                          </div>

                          <div className="grid grid-cols-3 gap-3 bg-slate-950/40 p-4 rounded-xl border border-white/5 text-center">
                            <div>
                              <p className="text-[10px] text-gray-400 font-bold uppercase">AI Accuracy</p>
                              <p className="text-2xl font-black text-white">{activeDrawing.aiScore >= 0 ? activeDrawing.aiScore : 0}</p>
                            </div>
                            <div>
                              <p className="text-[10px] text-gray-400 font-bold uppercase">Speed Bonus</p>
                              <p className="text-2xl font-black text-white">+{activeDrawing.secondsLeft}</p>
                            </div>
                            <div>
                              <p className="text-[10px] text-gray-400 font-bold uppercase">Round Score</p>
                              <p className="text-2xl font-black text-indigo-400">{activeDrawing.roundScore}</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })()
                ) : (
                  <p className="text-gray-400">No drawings available for this round.</p>
                )}
              </div>

              {/* Reveal controls */}
              <div className="flex space-x-4 mt-6 pt-4 border-t border-white/5">
                <button
                  onClick={() => setRevealIndex(prev => Math.max(0, prev - 1))}
                  disabled={revealIndex === 0}
                  className="flex-1 bg-slate-950/60 hover:bg-slate-900 border border-white/10 text-white font-bold py-2.5 px-4 rounded-xl transition-all disabled:opacity-40"
                >
                  Previous Drawing
                </button>
                {revealIndex < currentDrawings.length - 1 ? (
                  <button
                    onClick={() => setRevealIndex(prev => prev + 1)}
                    className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-2.5 px-4 rounded-xl transition-all"
                  >
                    Next Drawing
                  </button>
                ) : isMeHost ? (
                  <button
                    onClick={handleNextRound}
                    className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2.5 px-4 rounded-xl transition-all"
                  >
                    {room.currentRound < room.totalRounds ? "Next Round" : "See Final Standings"}
                  </button>
                ) : (
                  <div className="flex-1 text-center text-sm font-semibold text-gray-400 py-2.5">
                    Waiting for Host to advance...
                  </div>
                )}
              </div>
            </div>

            {/* Persistent Leaderboard */}
            <div className="lg:w-[340px] glass-panel">
              <h3 className="text-lg font-bold mb-4 text-white pb-2 border-b border-white/5">Standings</h3>
              <div className="space-y-2">
                {roomPlayers.map((p, idx) => (
                  <div key={p.playerId.toString()} className="flex items-center justify-between bg-slate-900/40 p-2.5 rounded-xl border border-white/5">
                    <div className="flex items-center space-x-3">
                      <span className="text-xs font-black text-gray-500 w-4">{idx + 1}.</span>
                      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: p.avatarColor }} />
                      <span className="font-semibold text-sm text-gray-200">{p.nickname}</span>
                    </div>
                    <span className="font-black text-sm text-white">{p.totalScore} pts</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* GAME OVER VIEW / FINISHED */}
        {room.status === 'finished' && (
          <div className="flex-grow flex flex-col gap-8">
            {/* Podium Standings */}
            <div className="glass-panel py-8 px-6 text-center">
              <h2 className="text-3xl font-black text-white mb-8">Final Results Podium</h2>
              
              <div className="flex justify-center items-end space-x-4 max-w-lg mx-auto h-48 mb-8">
                {/* 2nd Place */}
                {roomPlayers[1] && (
                  <div className="flex flex-col items-center flex-1">
                    <span className="w-4.5 h-4.5 rounded-full mb-1" style={{ backgroundColor: roomPlayers[1].avatarColor }} />
                    <span className="font-bold text-gray-300 text-sm truncate max-w-[100px]">{roomPlayers[1].nickname}</span>
                    <span className="text-xs text-gray-400 mb-2">{roomPlayers[1].totalScore} pts</span>
                    <div className="w-full bg-slate-800/80 border border-white/10 rounded-t-xl h-24 flex items-center justify-center font-black text-2xl text-gray-400">2nd</div>
                  </div>
                )}
                
                {/* 1st Place */}
                {roomPlayers[0] && (
                  <div className="flex flex-col items-center flex-1">
                    <div className="text-2xl mb-1 float">👑</div>
                    <span className="w-5 h-5 rounded-full mb-1" style={{ backgroundColor: roomPlayers[0].avatarColor }} />
                    <span className="font-black text-white text-base truncate max-w-[120px]">{roomPlayers[0].nickname}</span>
                    <span className="text-xs text-indigo-400 font-bold mb-2">{roomPlayers[0].totalScore} pts</span>
                    <div className="w-full bg-indigo-950/70 border border-indigo-700/30 rounded-t-2xl h-36 flex items-center justify-center font-black text-3xl text-indigo-300">1st</div>
                  </div>
                )}
                
                {/* 3rd Place */}
                {roomPlayers[2] && (
                  <div className="flex flex-col items-center flex-1">
                    <span className="w-4 h-4 rounded-full mb-1" style={{ backgroundColor: roomPlayers[2].avatarColor }} />
                    <span className="font-bold text-gray-300 text-sm truncate max-w-[100px]">{roomPlayers[2].nickname}</span>
                    <span className="text-xs text-gray-400 mb-2">{roomPlayers[2].totalScore} pts</span>
                    <div className="w-full bg-slate-900/80 border border-white/10 rounded-t-xl h-18 flex items-center justify-center font-black text-xl text-amber-700">3rd</div>
                  </div>
                )}
              </div>

              {/* Remaining standings */}
              {roomPlayers.length > 3 && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-3xl mx-auto">
                  {roomPlayers.slice(3).map((p, idx) => (
                    <div key={p.playerId.toString()} className="bg-slate-950/30 border border-white/5 p-2 rounded-xl flex items-center justify-between text-left">
                      <div className="flex items-center space-x-2">
                        <span className="text-xs text-gray-500 font-bold">{idx + 4}.</span>
                        <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: p.avatarColor }} />
                        <span className="text-xs font-semibold text-gray-300 truncate max-w-[80px]">{p.nickname}</span>
                      </div>
                      <span className="text-xs font-bold text-white">{p.totalScore} pts</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Hall of Shame */}
            <div className="glass-panel">
              <h3 className="text-2xl font-black text-rose-400 mb-6 border-b border-white/5 pb-3">AI Hall of Shame 💀</h3>
              
              {/* Grab up to 3 lowest scored drawings */}
              {(() => {
                const shameDrawings = drawings
                  .filter(d => d.roomId === room.roomId && d.scored && d.imageUrl) // Must be scored and have a visual
                  .sort((a, b) => a.aiScore - b.aiScore) // lowest score first
                  .slice(0, 3);
                
                if (shameDrawings.length === 0) {
                  return <p className="text-gray-500 italic text-center py-4">No scored drawings to display.</p>;
                }

                return (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {shameDrawings.map((dw, idx) => {
                      const artist = roomPlayers.find(p => p.playerId === dw.playerId);
                      return (
                        <div key={dw.drawingId.toString()} className="bg-slate-950/40 border border-rose-950/40 p-4 rounded-2xl flex flex-col justify-between">
                          <div className="text-center mb-3">
                            <span className="text-xs bg-rose-500/10 border border-rose-500/20 text-rose-400 font-bold px-2 py-0.5 rounded-lg uppercase">
                              Shame #{idx + 1} (Score: {dw.aiScore})
                            </span>
                          </div>
                          
                          <div className="aspect-square bg-white rounded-xl overflow-hidden flex items-center justify-center p-2 mb-4">
                            <img src={dw.imageUrl} alt="Shame drawing" className="max-w-full max-h-full object-contain" />
                          </div>
                          
                          <div className="space-y-2">
                            <p className="text-xs font-bold text-gray-400 flex items-center justify-center space-x-2">
                              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: artist?.avatarColor }} />
                              <span>By {artist?.nickname}</span>
                            </p>
                            <p className="text-sm italic text-rose-300 text-center bg-rose-950/20 p-3 rounded-xl">
                              "{dw.aiRoast}"
                            </p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>
        )}
      </div>

      {/* Footer / Controls */}
      <footer className="text-center text-xs text-gray-500 border-t border-white/5 pt-4">
        {room.status === 'finished' && isMeHost && (
          <button
            onClick={() => router.push('/')}
            className="bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3 px-8 rounded-xl transition-all shadow-lg shadow-indigo-600/20 mb-4 inline-block"
          >
            Create New Game
          </button>
        )}
        <p>DoodleDash Host Console. Connected to SpacetimeDB 2.0.</p>
      </footer>

      <style jsx global>{`
        .flex { display: flex; }
        .flex-col { flex-direction: column; }
        .items-center { align-items: center; }
        .justify-between { justify-content: space-between; }
        .justify-center { justify-content: center; }
        .text-center { text-align: center; }
        .space-x-3 > * + * { margin-left: 0.75rem; }
        .space-x-4 > * + * { margin-left: 1rem; }
        .space-x-6 > * + * { margin-left: 1.5rem; }
        .space-y-2 > * + * { margin-top: 0.5rem; }
        .space-y-3 > * + * { margin-top: 0.75rem; }
        .space-y-4 > * + * { margin-top: 1rem; }
        .space-y-6 > * + * { margin-top: 1.5rem; }
        .mt-4 { margin-top: 1rem; }
        .mt-6 { margin-top: 1.5rem; }
        .mt-8 { margin-top: 2rem; }
        .mb-1 { margin-bottom: 0.25rem; }
        .mb-2 { margin-bottom: 0.5rem; }
        .mb-3 { margin-bottom: 0.75rem; }
        .mb-4 { margin-bottom: 1rem; }
        .mb-6 { margin-bottom: 1.5rem; }
        .mb-8 { margin-bottom: 2rem; }
        .pb-2 { padding-bottom: 0.5rem; }
        .pb-3 { padding-bottom: 0.75rem; }
        .pt-4 { padding-top: 1rem; }
        .py-2.5 { padding-top: 0.625rem; padding-bottom: 0.625rem; }
        .py-4 { padding-top: 1rem; padding-bottom: 1rem; }
        .py-6 { padding-top: 1.5rem; padding-bottom: 1.5rem; }
        .py-8 { padding-top: 2rem; padding-bottom: 2rem; }
        .py-12 { padding-top: 3rem; padding-bottom: 3rem; }
        .py-16 { padding-top: 4rem; padding-bottom: 4rem; }
        .px-3 { padding-left: 0.75rem; padding-right: 0.75rem; }
        .px-4 { padding-left: 1rem; padding-right: 1rem; }
        .px-6 { padding-left: 1.5rem; padding-right: 1.5rem; }
        .px-8 { padding-left: 2rem; padding-right: 2rem; }
        .px-12 { padding-left: 3rem; padding-right: 3rem; }
        .w-full { width: 100%; }
        .w-3 { width: 0.75rem; }
        .w-3.5 { width: 0.875rem; }
        .w-4 { width: 1rem; }
        .w-4.5 { width: 1.125rem; }
        .w-5 { width: 1.25rem; }
        .w-8 { width: 2rem; }
        .w-12 { width: 3rem; }
        .w-16 { width: 4rem; }
        .w-48 { width: 12rem; }
        .h-2 { height: 0.5rem; }
        .h-3 { height: 0.75rem; }
        .h-3.5 { height: 0.875rem; }
        .h-4 { height: 1rem; }
        .h-4.5 { height: 1.125rem; }
        .h-5 { height: 1.25rem; }
        .h-8 { height: 2rem; }
        .h-12 { height: 3rem; }
        .h-16 { height: 4rem; }
        .h-18 { height: 4.5rem; }
        .h-24 { height: 6rem; }
        .h-36 { height: 9rem; }
        .h-48 { height: 12rem; }
        .max-w-md { max-width: 28rem; }
        .max-w-lg { max-width: 32rem; }
        .max-w-3xl { max-width: 48rem; }
        .max-w-7xl { max-width: 80rem; }
        .mx-auto { margin-left: auto; margin-right: auto; }
        .aspect-square { aspect-ratio: 1 / 1; }
        .flex-grow { flex-grow: 1; }
        .flex-1 { flex: 1 1 0%; }
        .rounded-xl { border-radius: 0.75rem; }
        .rounded-2xl { border-radius: 1rem; }
        .rounded-full { border-radius: 9999px; }
        .border { border-width: 1px; }
        .bg-indigo-600 { background-color: var(--primary); }
        .text-3xl { font-size: 1.875rem; }
        .text-2xl { font-size: 1.5rem; }
        .text-6xl { font-size: 3.75rem; }
        .text-sm { font-size: 0.875rem; }
        .text-xs { font-size: 0.75rem; }
        .font-bold { font-weight: 700; }
        .font-black { font-weight: 900; }
        .font-semibold { font-weight: 600; }
        .font-extrabold { font-weight: 800; }
        .tracking-wide { letter-spacing: 0.025em; }
        .tracking-wider { letter-spacing: 0.05em; }
        .tracking-widest { letter-spacing: 0.1em; }
        .text-gray-200 { color: rgb(229, 231, 235); }
        .text-gray-300 { color: rgb(209, 213, 219); }
        .text-gray-400 { color: rgb(156, 163, 175); }
        .text-gray-500 { color: rgb(107, 114, 128); }
        .text-white { color: #fff; }
        .text-indigo-300 { color: rgb(199, 210, 254); }
        .text-indigo-400 { color: rgb(129, 140, 248); }
        .text-rose-300 { color: rgb(252, 165, 165); }
        .text-rose-400 { color: rgb(248, 113, 113); }
        .uppercase { text-transform: uppercase; }
        .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .grid { display: grid; }
        .grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .gap-3 { gap: 0.75rem; }
        .gap-6 { gap: 1.5rem; }
        .gap-8 { gap: 2rem; }
        .transition-all { transition-property: all; }
        .duration-300 { transition-duration: 300ms; }
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
