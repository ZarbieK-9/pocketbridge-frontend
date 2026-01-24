# PocketBridge Frontend

Next.js web application for PocketBridge - a secure, end-to-end encrypted cross-device synchronization platform.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                       PocketBridge Frontend                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │                      Next.js App                          │       │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐     │       │
│  │  │  Home   │  │  Pair   │  │ Devices │  │ Settings│     │       │
│  │  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘     │       │
│  └───────┼────────────┼────────────┼────────────┼───────────┘       │
│          │            │            │            │                    │
│          ▼            ▼            ▼            ▼                    │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │                    React Hooks                            │       │
│  │  useWebSocket | useCrypto | useDevices | usePairing      │       │
│  └──────────────────────────────────────────────────────────┘       │
│                              │                                       │
│          ┌───────────────────┼───────────────────┐                  │
│          ▼                   ▼                   ▼                  │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐            │
│  │  WebSocket   │   │   Crypto     │   │   Features   │            │
│  │   Client     │   │   Layer      │   │   Layer      │            │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘            │
│         │                  │                  │                     │
│         ▼                  ▼                  ▼                     │
│  ┌──────────────────────────────────────────────────────────┐       │
│  │                   Local Storage                           │       │
│  │   Identity Keys | Device ID | Event Queue | Preferences  │       │
│  └──────────────────────────────────────────────────────────┘       │
│                                                                      │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼ WebSocket + REST
                          ┌────────────────┐
                          │    Backend     │
                          │   (Port 3001)  │
                          └────────────────┘
```

## Directory Structure

```
pocketbridge/
├── app/                      # Next.js App Router pages
│   ├── page.tsx              # Home/Dashboard
│   ├── pair/page.tsx         # Device pairing
│   ├── devices/page.tsx      # Device management
│   └── settings/page.tsx     # User settings
├── components/               # React components
│   └── ui/                   # Shadcn/UI components
├── hooks/                    # React hooks
│   ├── use-websocket.tsx     # WebSocket connection
│   ├── use-crypto.tsx        # Crypto initialization
│   └── use-devices.tsx       # Device management
├── lib/                      # Core libraries
│   ├── ws/                   # WebSocket client
│   │   └── client.ts         # Main WS client with handshake
│   ├── crypto/               # Cryptography
│   │   ├── keys.ts           # Ed25519 key management
│   │   ├── ecdh.ts           # ECDH key exchange
│   │   ├── encryption.ts     # AES-256-GCM encryption
│   │   └── hmac.ts           # HMAC for session keys
│   ├── features/             # Feature implementations
│   │   ├── clipboard.ts      # Clipboard sync
│   │   ├── files.ts          # File transfer
│   │   ├── messages.ts       # Messaging
│   │   └── scratchpad.ts     # Shared scratchpad
│   ├── sync/                 # Sync engine
│   │   ├── queue.ts          # Event queue (IndexedDB)
│   │   └── event-builder.ts  # Event construction
│   └── utils/                # Utilities
│       ├── pairing-code.ts   # Pairing code handling
│       ├── device.ts         # Device info
│       └── storage.ts        # Local storage helpers
└── types/                    # TypeScript definitions
    └── index.ts
```

## Core Flows

### 1. Initial Setup (First Launch)

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Generate   │────>│    Store    │────>│   Ready     │
│  Identity   │     │   in Local  │     │   to Pair   │
│  Keypair    │     │   Storage   │     │             │
└─────────────┘     └─────────────┘     └─────────────┘
     │
     ▼
  Ed25519 keypair becomes User ID (public key hex)
```

### 2. WebSocket Connection & Handshake

```
┌─────────────────────────────────────────────────────────────────┐
│                     WebSocket Client Flow                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  connect()                                                       │
│     │                                                            │
│     ├─── Load identity keypair from localStorage                 │
│     ├─── Create WebSocket connection                             │
│     │                                                            │
│  handleOpen()                                                    │
│     │                                                            │
│     └─── sendClientHello()                                       │
│            ├─── Generate ephemeral ECDH keypair                  │
│            ├─── Generate 32-byte nonce                           │
│            └─── Send { client_ephemeral_pub, nonce_c }           │
│                                                                  │
│  handleServerHello()                                             │
│     │                                                            │
│     ├─── Verify server signature (Ed25519)                       │
│     ├─── Pin server identity key (TOFU)                          │
│     ├─── Compute ECDH shared secret                              │
│     ├─── Derive session keys (HKDF)                              │
│     └─── sendClientAuth()                                        │
│            └─── Send { user_id, device_id, signature }           │
│                                                                  │
│  handleSessionEstablished()                                      │
│     │                                                            │
│     ├─── Store session keys                                      │
│     ├─── Start heartbeat (30s ping/pong)                         │
│     ├─── Request event replay if needed                          │
│     └─── Status: CONNECTED                                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 3. Device Pairing (As Initiator)

```
Device A (this device)              Backend                Device B (new)
       │                               │                        │
       │── Generate 6-digit code       │                        │
       │── POST /api/pairing/store ───>│                        │
       │                               │                        │
       │   Display QR code / code      │                        │
       │                               │                        │
       │                               │<── Lookup code ────────│
       │                               │<── completePairing ────│
       │                               │                        │
       │<── pairing_complete (WS) ─────│── pairing_complete ───>│
       │                               │                        │
       │   New device added!           │                        │
```

### 4. Event Sync (Sending)

```
User Action (e.g., copy text)
       │
       ▼
┌─────────────────┐
│  Build Event    │
│  - event_id     │
│  - device_seq   │
│  - stream_seq   │
│  - payload      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Encrypt Payload │
│ (AES-256-GCM)   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Queue in        │
│ IndexedDB       │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────┐
│ Send via WS     │────>│  Backend    │
│ (if connected)  │     │  Relay      │
└─────────────────┘     └─────────────┘
```

## Key Components

### WebSocket Client (`lib/ws/client.ts`)
- Manages WebSocket lifecycle
- Implements handshake protocol
- Auto-reconnect with exponential backoff
- Event queue management

### Crypto Layer (`lib/crypto/`)
- `keys.ts`: Ed25519 identity keypair generation/storage
- `ecdh.ts`: X25519 key exchange
- `encryption.ts`: AES-256-GCM encrypt/decrypt
- `hmac.ts`: Session key derivation

### Features (`lib/features/`)
- `clipboard.ts`: Cross-device clipboard sync
- `files.ts`: Encrypted file transfer
- `messages.ts`: Device-to-device messaging
- `scratchpad.ts`: Shared text scratchpad

### Sync Engine (`lib/sync/`)
- `queue.ts`: IndexedDB-backed event queue
- `event-builder.ts`: Event construction with signatures

## Security Model

```
┌─────────────────────────────────────────────────────────────┐
│                    Security Layers                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. Identity (Ed25519)                                       │
│     └── User ID = Public Key (self-sovereign identity)       │
│                                                              │
│  2. Transport (ECDH + AES-256-GCM)                          │
│     └── Perfect forward secrecy per session                  │
│                                                              │
│  3. Payload Encryption                                       │
│     └── E2E encrypted, server never sees plaintext           │
│                                                              │
│  4. Message Authentication                                   │
│     └── HMAC on all encrypted payloads                       │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Local Storage Keys

| Key | Description |
|-----|-------------|
| `pocketbridge_identity` | Ed25519 keypair (hex) |
| `pocketbridge_device_id` | Device UUID |
| `pocketbridge_server_key` | Pinned server public key |
| `pocketbridge_preferences` | User preferences |

## Environment Variables

```bash
NEXT_PUBLIC_WS_URL=ws://localhost:3001/ws
NEXT_PUBLIC_API_URL=http://localhost:3001
```

## Running

```bash
# Development
npm run dev

# Production build
npm run build
npm start

# Docker
docker compose up -d
```

## Pages

| Route | Description |
|-------|-------------|
| `/` | Dashboard - connection status, quick actions |
| `/pair` | Device pairing - QR code & manual code entry |
| `/devices` | Device management - list, revoke devices |
| `/settings` | User settings - preferences, data export |
