'use client';

import { useState, useEffect, useRef, useMemo, use } from 'react';
import { useRouter } from 'next/navigation';
import { useSpacetimeDB, useTable, useReducer } from 'spacetimedb/react';
import { tables, reducers } from '../../../src/module_bindings';

interface PlayPageProps {
  params: Promise<{ code: string }>;
}

type Point = { x: number; y: number; time: number };
type Stroke = { points: Point[]; color: string; width: number; timestamp: number };

export default function PlayPage({ params }: PlayPageProps) {
  const router = useRouter();
  const resolvedParams = use(params);
  const roomCode = resolvedParams.code.toUpperCase();

  const { isActive: connected, identity, getConnection } = useSpacetimeDB();
  const conn = getConnection();

  // Reducer Hooks
  const submitDrawingReducer = useReducer(reducers.submitDrawing);
  const useSabotageReducer = useReducer(reducers.useSabotage);

  // Table Hooks
  const [rooms, roomsReady] = useTable(tables.room);
  const [players, playersReady] = useTable(tables.player);
  const [rounds, roundsReady] = useTable(tables.round);
  const [drawings, drawingsReady] = useTable(tables.drawing);
  const [sabotages, sabotagesReady] = useTable(tables.sabotage);

  // Canvas drawing states
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [brushSize, setBrushSize] = useState(8);

  // Game/Timer state
  const [timeLeft, setTimeLeft] = useState(30);
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  // Gemini back-seat critique state
  const [midRoundRoast, setMidRoundRoast] = useState('');
  const [roastLoading, setRoastLoading] = useState(false);
  const roastTriggeredRef = useRef(false);

  // Sabotage state on target player
  const [sabotageVictimId, setSabotageVictimId] = useState<string>('');
  const [sabotageEffect, setSabotageEffect] = useState<'invert' | 'spin' | 'invisible_ink' | 'giant_brush' | 'fake_popup'>('invert');
  const [sabotageMessage, setSabotageMessage] = useState('');

  // Fake Pop-up sabotage state
  const [showFakePopup, setShowFakePopup] = useState(false);
  const [fakePopupMessage, setFakePopupMessage] = useState('');

  // Subscribe to tables
  useEffect(() => {
    if (!conn || !connected) return;
    conn.subscriptionBuilder().subscribe([
      tables.room,
      tables.player,
      tables.round,
      tables.drawing,
      tables.sabotage,
    ]);
  }, [conn, connected]);

  // Find room
  const room = useMemo(() => rooms.find(r => r.code === roomCode), [rooms, roomCode]);

  // Find player row for self
  const me = useMemo(() => {
    if (!room || !identity) return null;
    return players.find(p => p.roomId === room.roomId && p.identity.toHexString() === identity.toHexString());
  }, [players, room, identity]);

  // Find other active players in room who haven't submitted yet
  const opponents = useMemo(() => {
    if (!room || !me) return [];
    const currentRound = rounds.find(r => r.roomId === room.roomId && r.roundNumber === room.currentRound);
    if (!currentRound) return [];

    return players.filter(p => {
      if (p.roomId !== room.roomId || p.playerId === me.playerId || !p.connected) return false;
      // Filter out players who have already submitted drawings
      const hasSubmitted = drawings.some(d => d.roundId === currentRound.roundId && d.playerId === p.playerId && d.submitted);
      return !hasSubmitted;
    });
  }, [players, room, me, drawings, rounds]);

  // Find current round
  const currentRound = useMemo(() => {
    if (!room) return null;
    return rounds.find(r => r.roomId === room.roomId && r.roundNumber === room.currentRound);
  }, [rounds, room]);

  // Check active sabotages affecting ME this round
  const activeSabotages = useMemo(() => {
    if (!currentRound || !me) return [];
    return sabotages.filter(s => s.roundId === currentRound.roundId && s.toPlayerId === me.playerId && s.active);
  }, [sabotages, currentRound, me]);

  // Specific active sabotages
  const invertActive = useMemo(() => activeSabotages.some(s => s.effect === 'invert'), [activeSabotages]);
  const spinActive = useMemo(() => activeSabotages.some(s => s.effect === 'spin'), [activeSabotages]);
  const invisibleInkActive = useMemo(() => activeSabotages.some(s => s.effect === 'invisible_ink'), [activeSabotages]);
  const giantBrushActive = useMemo(() => activeSabotages.some(s => s.effect === 'giant_brush'), [activeSabotages]);
  const fakePopupActive = useMemo(() => activeSabotages.some(s => s.effect === 'fake_popup'), [activeSabotages]);

  // Trigger fake popup if fakePopupActive becomes true
  useEffect(() => {
    if (fakePopupActive && !showFakePopup) {
      const messages = [
        "Low Ink! Click OK to shake cartridge.",
        "Your drawing is slightly crooked. Click OK to rotate canvas.",
        "AI Critique: This looks nothing like the word! Click OK to dismiss.",
        "System Warning: Too much talent detected. Click OK to continue.",
        "Warning: Eraser fluid depleted! Click OK to refill."
      ];
      const randomMsg = messages[Math.floor(Math.random() * messages.length)];
      setFakePopupMessage(randomMsg);
      setShowFakePopup(true);
    }
  }, [fakePopupActive]);

  // Reset drawing states when a new round starts
  useEffect(() => {
    if (room?.status === 'in_round') {
      setStrokes([]);
      setSubmitted(false);
      setMidRoundRoast('');
      setLoading(false);
      setSabotageVictimId('');
      setSabotageMessage('');
      setShowFakePopup(false);
      roastTriggeredRef.current = false;
    }
  }, [room?.status, room?.currentRound]);

  // Draw loop for HTML5 Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || room?.status !== 'in_round') return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Redraw loop
    let animationFrameId: number;

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const now = Date.now();
      for (const stroke of strokes) {
        // Invisible ink filters out stroke parts older than 1.5 seconds
        if (invisibleInkActive && now - stroke.timestamp > 1500) {
          continue;
        }

        ctx.beginPath();
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        if (stroke.points.length > 0) {
          ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
          for (let i = 1; i < stroke.points.length; i++) {
            ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
          }
          ctx.stroke();
        }
      }

      if (invisibleInkActive) {
        animationFrameId = requestAnimationFrame(draw);
      }
    };

    draw();

    return () => {
      if (animationFrameId) {
        cancelAnimationFrame(animationFrameId);
      }
    };
  }, [strokes, room?.status, invisibleInkActive]);

  // Timer Tick and Gemini backseat trigger at ~15s
  useEffect(() => {
    if (!currentRound || currentRound.status !== 'drawing' || submitted) return;

    const interval = setInterval(async () => {
      const endsAtSeconds = Number(currentRound.endsAt / 1000000n);
      const nowSeconds = Date.now() / 1000;
      const left = Math.max(0, Math.ceil(endsAtSeconds - nowSeconds));
      setTimeLeft(left);

      // Auto-trigger backseat roast at 15s
      if (left <= 15 && left > 0 && !roastTriggeredRef.current && canvasRef.current && conn) {
        roastTriggeredRef.current = true;
        setRoastLoading(true);
        try {
          const base64Clean = canvasRef.current.toDataURL('image/png').split(',')[1];
          const roast = await conn.procedures.roastInProgress({
            imageBase64: base64Clean,
            word: currentRound.word
          });
          setMidRoundRoast(roast);
        } catch (e) {
          console.error("Backseat roast failed:", e);
        } finally {
          setRoastLoading(false);
        }
      }

      // Auto-submit if timer runs out
      if (left <= 0) {
        clearInterval(interval);
        handleSubmitDrawing(0);
      }
    }, 200);

    return () => clearInterval(interval);
  }, [currentRound, submitted, conn]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (submitted) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const newStroke: Stroke = {
      points: [{ x, y, time: Date.now() }],
      color: '#0e1111',
      width: giantBrushActive ? 36 : brushSize,
      timestamp: Date.now(),
    };

    setStrokes(prev => [...prev, newStroke]);
    setIsDrawing(true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing || submitted) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    setStrokes(prev => {
      if (prev.length === 0) return prev;
      const last = { ...prev[prev.length - 1] };
      last.points = [...last.points, { x, y, time: Date.now() }];
      return [...prev.slice(0, -1), last];
    });
  };

  const handlePointerUp = () => {
    setIsDrawing(false);
  };

  const undo = () => {
    setStrokes(prev => prev.slice(0, -1));
  };

  const clear = () => {
    setStrokes([]);
  };

  // Upload to Supabase or return base64 data URL
  const uploadToStorage = async (canvas: HTMLCanvasElement): Promise<string> => {
    const base64 = canvas.toDataURL('image/png');
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      console.warn("Supabase configs missing. Defaulting to data URL storage.");
      return base64;
    }

    try {
      const blob = await fetch(base64).then(res => res.blob());
      const fileName = `${me?.playerId}_round_${currentRound?.roundId}_${Date.now()}.png`;

      const uploadRes = await fetch(`${supabaseUrl}/storage/v1/object/drawings/${fileName}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${supabaseAnonKey}`,
          'apikey': supabaseAnonKey,
          'Content-Type': 'image/png'
        },
        body: blob
      });

      if (uploadRes.ok) {
        return `${supabaseUrl}/storage/v1/object/public/drawings/${fileName}`;
      }
    } catch (e) {
      console.error("Supabase REST upload failed:", e);
    }
    return base64; // Fallback
  };

  // Submit Drawing flow
  const handleSubmitDrawing = async (secondsBonus: number) => {
    if (submitted || !canvasRef.current || !currentRound || !me || !conn) return;

    setSubmitted(true);
    setLoading(true);

    try {
      const imageUrl = await uploadToStorage(canvasRef.current);
      const base64Clean = canvasRef.current.toDataURL('image/png').split(',')[1];

      // 1. Submit drawing details to table
      submitDrawingReducer({
        roundId: currentRound.roundId,
        imageUrl,
        secondsLeft: secondsBonus,
      });

      // 2. Call Gemini procedure in background to score drawing
      conn.procedures.scoreDrawing({
        roundId: currentRound.roundId,
        playerId: me.playerId,
        imageBase64: base64Clean,
        word: currentRound.word
      }).catch(err => console.error("Scoring error:", err));

    } catch (e) {
      console.error("Drawing submission error:", e);
    } finally {
      setLoading(false);
    }
  };

  // Cast Sabotage reducer call
  const handleCastSabotage = () => {
    if (!sabotageVictimId || !currentRound) return;

    try {
      useSabotageReducer({
        roundId: currentRound.roundId,
        targetPlayerId: BigInt(sabotageVictimId),
        effect: sabotageEffect
      });
      setSabotageMessage("Sabotage deployed successfully! 😈");
    } catch (e: any) {
      setSabotageMessage(e.message || "Failed to cast sabotage");
    }
  };

  if (!connected || !roomsReady || !playersReady || !me) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-4">
        <div className="glass-panel text-center py-8 px-12">
          <div className="inline-block w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4"></div>
          <p className="text-gray-300">Connecting Controller...</p>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen p-4 flex flex-col justify-between max-w-md mx-auto">
      {/* Player Header */}
      <header className="flex justify-between items-center bg-slate-900/40 border border-white/5 p-3 rounded-xl mb-4">
        <div className="flex items-center space-x-2">
          <span className="w-3.5 h-3.5 rounded-full" style={{ backgroundColor: me.avatarColor }} />
          <span className="font-extrabold text-sm text-white">{me.nickname}</span>
        </div>
        <div className="bg-slate-950/60 px-3 py-1 rounded-lg border border-white/5">
          <span className="text-xs text-indigo-400 font-black">{me.totalScore} pts</span>
        </div>
      </header>

      {/* 1. LOBBY VIEW */}
      {room?.status === 'lobby' && (
        <div className="flex-grow glass-panel flex flex-col items-center justify-center text-center py-12 px-6">
          <div className="text-4xl mb-4 float">🎨</div>
          <h2 className="text-xl font-bold mb-2">Connected to Lobby</h2>
          <p className="text-gray-400 text-sm mb-6">Waiting for host to start the game.</p>
          <div className="bg-slate-950/40 p-4 rounded-xl border border-white/5 w-full">
            <span className="text-xs text-gray-400 font-bold block mb-1">Room Code</span>
            <span className="text-2xl font-black tracking-widest text-indigo-400">{roomCode}</span>
          </div>
        </div>
      )}

      {/* 2. IN ROUND: DRAWING PHASE */}
      {room?.status === 'in_round' && currentRound && !submitted && (
        <div className="flex-grow flex flex-col justify-between">
          {/* Top Panel: Timer and Word */}
          <div className="flex justify-between items-center mb-3">
            <div>
              <p className="text-[10px] text-gray-500 font-bold uppercase tracking-wider">Draw this word</p>
              <h2 className="text-2xl font-black text-white uppercase tracking-wide">{currentRound.word}</h2>
            </div>
            <div className={`px-4 py-2 rounded-xl text-lg font-black border ${
              timeLeft > 10 ? 'bg-indigo-950/30 border-indigo-700 text-indigo-300' : 'bg-rose-950/30 border-rose-700 text-rose-300'
            }`}>
              {timeLeft}s
            </div>
          </div>

          {/* Active Sabotage Alerts */}
          {activeSabotages.length > 0 && (
            <div className="bg-rose-950/30 border border-rose-800 text-rose-300 text-xs p-2.5 rounded-xl mb-3 flex items-center justify-between animate-pulse">
              <span className="font-bold">⚠️ SABOTAGED: {
                invertActive ? "Upside Down Drawing" :
                spinActive ? "Dizzy Spin Canvas" :
                invisibleInkActive ? "Invisible Ink Fade" :
                giantBrushActive ? "Giant Brush Thick" :
                "Distraction Pop-ups"
              }!</span>
            </div>
          )}

          {/* Backseat Critic Roast Balloon */}
          {(roastLoading || midRoundRoast) && (
            <div className="bg-indigo-950/40 border border-indigo-800 text-gray-200 text-xs p-3 rounded-xl mb-3 relative">
              <span className="font-black text-[10px] text-indigo-400 uppercase block mb-1">Backseat Art Critic 🤖</span>
              {roastLoading ? (
                <div className="flex items-center space-x-2 py-1">
                  <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce"></div>
                  <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:0.2s]"></div>
                  <div className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce [animation-delay:0.4s]"></div>
                </div>
              ) : (
                <p className="italic">"{midRoundRoast}"</p>
              )}
            </div>
          )}

          {/* Canvas Board wrapper */}
          <div className="relative w-full aspect-square bg-white border border-white/10 rounded-2xl overflow-hidden shadow-xl mb-3">
            <canvas
              ref={canvasRef}
              width={350}
              height={350}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              className={`w-full h-full touch-none ${
                invertActive ? 'transform scale-y-[-1]' : ''
              } ${
                spinActive ? 'spin-active' : ''
              }`}
            />
            {/* Fake pop-up interference */}
            {showFakePopup && (
              <div className="absolute inset-0 bg-black/60 flex items-center justify-center p-6 z-50">
                <div className="bg-slate-900 border border-indigo-500 rounded-xl p-5 text-center max-w-[280px] shadow-2xl">
                  <span className="text-xl mb-2 block">⚠️ Alert</span>
                  <p className="text-xs text-gray-300 mb-4">{fakePopupMessage}</p>
                  <button
                    type="button"
                    onClick={() => setShowFakePopup(false)}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-bold py-2 px-6 rounded-lg"
                  >
                    OK
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Controls & Action Buttons */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex space-x-2">
              <button
                type="button"
                onClick={undo}
                className="bg-slate-900/60 hover:bg-slate-900 text-white font-bold p-2.5 rounded-lg border border-white/5 text-sm"
              >
                Undo
              </button>
              <button
                type="button"
                onClick={clear}
                className="bg-slate-900/60 hover:bg-slate-900 text-white font-bold p-2.5 rounded-lg border border-white/5 text-sm"
              >
                Clear
              </button>
            </div>
            
            {/* Brush sizes */}
            <div className="flex items-center space-x-1 bg-slate-950/40 p-1 rounded-lg border border-white/5">
              {[4, 8, 16, 24].map((sz) => (
                <button
                  key={sz}
                  type="button"
                  onClick={() => setBrushSize(sz)}
                  disabled={giantBrushActive}
                  className={`w-8 h-8 rounded text-xs font-bold transition-all ${
                    brushSize === sz && !giantBrushActive
                      ? 'bg-indigo-600 text-white' 
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {sz === 4 ? 'S' : sz === 8 ? 'M' : sz === 16 ? 'L' : 'XL'}
                </button>
              ))}
            </div>
          </div>

          {/* Submit Canvas */}
          <button
            onClick={() => handleSubmitDrawing(timeLeft)}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 px-6 rounded-xl transition-all shadow-lg shadow-indigo-600/20"
          >
            Submit Drawing (+{timeLeft}s Bonus)
          </button>
        </div>
      )}

      {/* 3. IN ROUND: WAITING FOR OTHERS / CAST SABOTAGE */}
      {room?.status === 'in_round' && currentRound && (submitted || loading) && (
        <div className="flex-grow flex flex-col justify-between">
          <div className="glass-panel text-center py-8 mb-4">
            {loading ? (
              <>
                <div className="inline-block w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4"></div>
                <p className="text-gray-300">Uploading and scoring drawing...</p>
              </>
            ) : (
              <>
                <div className="text-3xl mb-2">🎉</div>
                <h3 className="text-lg font-bold text-white mb-1">Drawing Submitted!</h3>
                <p className="text-xs text-gray-400">Waiting for other players to submit...</p>
              </>
            )}
          </div>

          {/* Sabotage selection panel */}
          {me.sabotageAvailable && !loading && (
            <div className="glass-panel flex-grow flex flex-col justify-between">
              <div>
                <h4 className="text-sm font-black text-indigo-400 uppercase tracking-wider mb-3">Cast Sabotage 😈</h4>
                <p className="text-xs text-gray-400 mb-4">You have one sabotage per game. Select a victim drawing in progress and mess with their canvas!</p>

                {sabotageMessage && (
                  <p className="text-xs bg-indigo-950/40 border border-indigo-800 text-indigo-300 p-2.5 rounded-lg mb-4 text-center">
                    {sabotageMessage}
                  </p>
                )}

                {opponents.length > 0 ? (
                  <div className="space-y-4">
                    {/* Select opponent */}
                    <div>
                      <label className="block text-xs font-bold text-gray-400 mb-1.5 uppercase">Choose Victim</label>
                      <select
                        value={sabotageVictimId}
                        onChange={(e) => setSabotageVictimId(e.target.value)}
                        className="w-full bg-slate-950 border border-white/10 rounded-xl p-3 text-sm text-white focus:outline-none focus:border-indigo-500"
                      >
                        <option value="">-- Select Player --</option>
                        {opponents.map((op) => (
                          <option key={op.playerId.toString()} value={op.playerId.toString()}>
                            {op.nickname}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Select sabotage type */}
                    <div>
                      <label className="block text-xs font-bold text-gray-400 mb-1.5 uppercase">Select Sabotage Effect</label>
                      <div className="grid grid-cols-2 gap-2">
                        {[
                          { id: 'invert', name: 'Flip Canvas' },
                          { id: 'spin', name: 'Dizzy Spin' },
                          { id: 'invisible_ink', name: 'Invisible Ink' },
                          { id: 'giant_brush', name: 'Giant Brush' },
                          { id: 'fake_popup', name: 'Pop-ups' }
                        ].map((sab) => (
                          <button
                            key={sab.id}
                            type="button"
                            onClick={() => setSabotageEffect(sab.id as any)}
                            className={`p-2.5 rounded-xl border text-xs font-bold transition-all ${
                              sabotageEffect === sab.id
                                ? 'bg-indigo-600 border-indigo-500 text-white shadow'
                                : 'bg-slate-950/40 border-white/5 text-gray-400'
                            }`}
                          >
                            {sab.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-gray-500 italic text-center py-4">No active targets available to sabotage right now.</p>
                )}
              </div>

              {opponents.length > 0 && (
                <button
                  type="button"
                  onClick={handleCastSabotage}
                  disabled={!sabotageVictimId}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3.5 px-4 rounded-xl transition-all shadow-lg shadow-indigo-600/20 disabled:opacity-40 mt-6"
                >
                  Cast Sabotage
                </button>
              )}
            </div>
          )}

          {!me.sabotageAvailable && !loading && (
            <div className="glass-panel flex-grow flex items-center justify-center text-center">
              <p className="text-gray-500 italic text-sm">Sabotage spent! Relax while other players finish drawing.</p>
            </div>
          )}
        </div>
      )}

      {/* 4. SCORING VIEW */}
      {room?.status === 'scoring' && (
        <div className="flex-grow glass-panel flex flex-col items-center justify-center text-center py-12 px-6">
          <div className="inline-block w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4"></div>
          <h2 className="text-xl font-bold mb-2">AI is Grading...</h2>
          <p className="text-gray-400 text-sm">Grading drawings in real-time. Look at the Host TV Screen for updates!</p>
        </div>
      )}

      {/* 5. REVEAL VIEW */}
      {room?.status === 'reveal' && currentRound && (
        <div className="flex-grow flex flex-col justify-between">
          <div className="glass-panel text-center py-8 flex flex-col items-center justify-center flex-grow">
            <div className="text-4xl mb-4">🏆</div>
            <h3 className="text-xl font-black text-white mb-2">Round Over!</h3>
            <p className="text-sm text-gray-400 mb-6">Look up at the TV screen to see the AI scores and critiques.</p>
            
            {/* Show my result */}
            {(() => {
              const myDrawing = drawings.find(d => d.roundId === currentRound.roundId && d.playerId === me.playerId);
              if (myDrawing && myDrawing.scored) {
                return (
                  <div className="bg-slate-950/40 p-5 rounded-2xl border border-white/5 w-full">
                    <p className="text-xs text-gray-400 font-bold uppercase mb-2">Your Performance</p>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="bg-slate-900/50 p-3 rounded-xl border border-white/5">
                        <span className="text-[10px] text-indigo-400 font-bold block">AI SCORE</span>
                        <span className="text-2xl font-black text-white">{myDrawing.aiScore}</span>
                      </div>
                      <div className="bg-slate-900/50 p-3 rounded-xl border border-white/5">
                        <span className="text-[10px] text-indigo-400 font-bold block">TOTAL PTS</span>
                        <span className="text-2xl font-black text-indigo-400">+{myDrawing.roundScore}</span>
                      </div>
                    </div>
                  </div>
                );
              }
              return null;
            })()}
          </div>
        </div>
      )}

      {/* 6. FINISHED GAME VIEW */}
      {room?.status === 'finished' && (
        <div className="flex-grow glass-panel flex flex-col items-center justify-center text-center py-12 px-6">
          <div className="text-5xl mb-4 float">👑</div>
          <h2 className="text-2xl font-black mb-2">Game Over!</h2>
          <p className="text-gray-400 text-sm mb-6">The final podium has been crowned. Check the Host TV screen for the Hall of Shame roasts!</p>
          <button
            onClick={() => router.push('/')}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-3.5 px-4 rounded-xl transition-all shadow-lg shadow-indigo-600/20"
          >
            Play Another Game
          </button>
        </div>
      )}

      {/* Footer */}
      <footer className="text-center text-[10px] text-gray-500 mt-4">
        DoodleDash Client Controller. SpacetimeDB 2.0.
      </footer>

      <style jsx global>{`
        .flex { display: flex; }
        .flex-col { flex-direction: column; }
        .items-center { align-items: center; }
        .justify-between { justify-content: space-between; }
        .justify-center { justify-content: center; }
        .text-center { text-align: center; }
        .space-x-1 > * + * { margin-left: 0.25rem; }
        .space-x-2 > * + * { margin-left: 0.5rem; }
        .space-y-4 > * + * { margin-top: 1rem; }
        .mb-1 { margin-bottom: 0.25rem; }
        .mb-2 { margin-bottom: 0.5rem; }
        .mb-3 { margin-bottom: 0.75rem; }
        .mb-4 { margin-bottom: 1rem; }
        .mb-6 { margin-bottom: 1.5rem; }
        .mt-4 { margin-top: 1rem; }
        .mt-6 { margin-top: 1.5rem; }
        .py-1 { padding-top: 0.25rem; padding-bottom: 0.25rem; }
        .py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; }
        .py-3.5 { padding-top: 0.875rem; padding-bottom: 0.875rem; }
        .py-4 { padding-top: 1rem; padding-bottom: 1rem; }
        .py-8 { padding-top: 2rem; padding-bottom: 2rem; }
        .py-12 { padding-top: 3rem; padding-bottom: 3rem; }
        .px-3 { padding-left: 0.75rem; padding-right: 0.75rem; }
        .px-4 { padding-left: 1rem; padding-right: 1rem; }
        .px-6 { padding-left: 1.5rem; padding-right: 1.5rem; }
        .p-2.5 { padding: 0.625rem; }
        .p-3 { padding: 0.75rem; }
        .p-4 { padding: 1rem; }
        .p-5 { padding: 1.25rem; }
        .w-full { width: 100%; }
        .w-1.5 { width: 0.375rem; }
        .w-2.5 { width: 0.625rem; }
        .w-3.5 { width: 0.875rem; }
        .w-8 { width: 2rem; }
        .h-1.5 { height: 0.375rem; }
        .h-2.5 { height: 0.625rem; }
        .h-3.5 { height: 0.875rem; }
        .h-8 { height: 2rem; }
        .aspect-square { aspect-ratio: 1 / 1; }
        .flex-grow { flex-grow: 1; }
        .rounded { border-radius: 0.25rem; }
        .rounded-lg { border-radius: 0.5rem; }
        .rounded-xl { border-radius: 0.75rem; }
        .rounded-2xl { border-radius: 1rem; }
        .rounded-full { border-radius: 9999px; }
        .border { border-width: 1px; }
        .bg-indigo-600 { background-color: var(--primary); }
        .bg-slate-900\/40 { background-color: rgba(15, 23, 42, 0.4); }
        .bg-slate-950\/40 { background-color: rgba(2, 6, 23, 0.4); }
        .text-2xl { font-size: 1.5rem; }
        .text-xl { font-size: 1.25rem; }
        .text-lg { font-size: 1.125rem; }
        .text-sm { font-size: 0.875rem; }
        .text-xs { font-size: 0.75rem; }
        .text-4xl { font-size: 2.25rem; }
        .text-5xl { font-size: 3rem; }
        .font-bold { font-weight: 700; }
        .font-black { font-weight: 900; }
        .font-extrabold { font-weight: 800; }
        .text-gray-200 { color: rgb(229, 231, 235); }
        .text-gray-300 { color: rgb(209, 213, 219); }
        .text-gray-400 { color: rgb(156, 163, 175); }
        .text-gray-500 { color: rgb(107, 114, 128); }
        .text-white { color: #fff; }
        .text-indigo-300 { color: rgb(199, 210, 254); }
        .text-indigo-400 { color: rgb(129, 140, 248); }
        .text-rose-300 { color: rgb(252, 165, 165); }
        .uppercase { text-transform: uppercase; }
        .grid { display: grid; }
        .grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .gap-2 { gap: 0.5rem; }
        .gap-4 { gap: 1rem; }
        .transition-all { transition-property: all; }
        .animate-spin {
          animation: spin 1s linear infinite;
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        .animate-pulse {
          animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: .5; }
        }
        .animate-bounce {
          animation: bounce 1s infinite;
        }
        @keyframes bounce {
          0%, 100% {
            transform: translateY(-25%);
            animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
          }
          50% {
            transform: translateY(0);
            animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
          }
        }
        .touch-none {
          touch-action: none;
        }
      `}</style>
    </main>
  );
}
