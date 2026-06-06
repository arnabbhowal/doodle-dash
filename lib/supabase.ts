import { createClient } from '@supabase/supabase-js';

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function uploadDrawing(
  code: string,
  roundId: string,
  playerId: string,
  blob: Blob
): Promise<string> {
  const path = `drawings/${code}/${roundId}/${playerId}.png`;
  const { error } = await supabase.storage
    .from('drawings')
    .upload(path, blob, { contentType: 'image/png', upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from('drawings').getPublicUrl(path);
  return data.publicUrl;
}

// A one-shot snapshot of a victim's canvas at hijack start, so the attacker scribbles
// on top of their real drawing. Separate path from the submission so it never collides
// with the final drawing. Reuses the same public `drawings` bucket + RLS policies.
export async function uploadHijackCanvas(
  code: string,
  roundId: string,
  playerId: string,
  blob: Blob
): Promise<string> {
  const path = `hijack/${code}/${roundId}/${playerId}.png`;
  const { error } = await supabase.storage
    .from('drawings')
    .upload(path, blob, { contentType: 'image/png', upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from('drawings').getPublicUrl(path);
  return data.publicUrl;
}

// A small periodic snapshot of a player's in-progress canvas, for the host's live
// "Peek" view while a round is running. Separate path from submissions/hijacks.
export async function uploadLiveCanvas(
  code: string,
  roundId: string,
  playerId: string,
  blob: Blob
): Promise<string> {
  const path = `live/${code}/${roundId}/${playerId}.png`;
  const { error } = await supabase.storage
    .from('drawings')
    .upload(path, blob, { contentType: 'image/png', upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from('drawings').getPublicUrl(path);
  return data.publicUrl;
}
