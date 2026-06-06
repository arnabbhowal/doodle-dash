'use client';

import { useMemo } from 'react';
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { DbConnection, ErrorContext } from '../src/module_bindings';
import { Identity } from 'spacetimedb';

const HOST =
  process.env.NEXT_PUBLIC_SPACETIMEDB_HOST ?? 'wss://maincloud.spacetimedb.com';
const DB_NAME = process.env.NEXT_PUBLIC_SPACETIMEDB_DB_NAME ?? 'doodledash';
const TOKEN_KEY = `${HOST}/${DB_NAME}/auth_token`;

const onConnect = (_conn: DbConnection, identity: Identity, token: string) => {
  if (typeof window !== 'undefined') {
    localStorage.setItem(TOKEN_KEY, token);
  }
  console.log(
    'Connected to SpacetimeDB with identity:',
    identity.toHexString()
  );
};

const onDisconnect = () => {
  console.log('Disconnected from SpacetimeDB');
};

const onConnectError = (_ctx: ErrorContext, err: Error) => {
  console.log('Error connecting to SpacetimeDB:', err);
};

export function Providers({ children }: { children: React.ReactNode }) {
  const connectionBuilder = useMemo(
    () =>
      DbConnection.builder()
        .withUri(HOST)
        .withDatabaseName(DB_NAME)
        .withToken(
          typeof window !== 'undefined'
            ? localStorage.getItem(TOKEN_KEY) || undefined
            : undefined
        )
        .onConnect(onConnect)
        .onDisconnect(onDisconnect)
        .onConnectError(onConnectError)
        // Disable WebSocket compression. The SpacetimeDB TS SDK (≤2.3.x) has a
        // decompression bug on ALL WebKit browsers — iOS Safari, iOS Chrome, and
        // macOS Safari — where compressed frames throw "undefined is not a function
        // (…decompressedStream…)" and are silently DROPPED (clockworklabs/SpacetimeDB
        // #5031, fixed in v2.4.0). The server only compresses frames above a size
        // threshold, so large subscription snapshots (the `drawing` table) and
        // batched updates vanished on iPhone → empty `drawings` cache ("No drawing
        // submitted", missing Hall of Shame), missed reveals (stuck on scoring), and
        // a wedged isReady (the SubscriptionApplied frame was dropped). Small frames
        // (room/player) came through uncompressed, which is why those worked. Sending
        // everything uncompressed costs negligible bandwidth for this small game and
        // makes iOS behave identically to Android/desktop. Remove once on SDK ≥2.4.0.
        .withCompression('none'),
    []
  );

  return (
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      {children}
    </SpacetimeDBProvider>
  );
}
