# Global Qall — Sprint 8A Voice Calling (Foreground MVP)

## What is included

- One-to-one foreground voice calls between two signed-in users.
- Outgoing call from the Qall keypad, Contact Profile, and chat header.
- Global incoming-call listener.
- Incoming call screen with Accept and Decline.
- WebRTC offer, answer, and ICE exchange through Supabase.
- Mute/unmute, hang up, connection state, and call timer.
- Avatar, display name, and Qall ID on the call screen.

## Important scope

This is Sprint 8A's foreground MVP. Both users must have Global Qall open and connected to Metro. Background ringing, lock-screen calls, PushKit, CallKit, speaker routing, Bluetooth controls, and TURN deployment are later stages.

## Installation

1. Back up your project.
2. Run `supabase/sprint-8a-voice-calling.sql` in Supabase SQL Editor.
3. Copy the included files into the matching project locations.
4. Confirm Realtime replication is enabled for `calls` and `call_ice_candidates`. The SQL attempts to enable it.
5. Run:

```powershell
npx expo start --dev-client --tunnel --clear
```

Your current `package.json` already contains `react-native-webrtc`, and `app.json` already contains the WebRTC config plugin. If the installed iOS development client was built after those were added, no rebuild is needed. Otherwise build a new client:

```powershell
eas build --profile development --platform ios --clear-cache
```

## Test

- Install/open the same development build on two registered iPhones.
- Sign in with two different Global Qall accounts.
- Keep both apps foregrounded.
- From one phone, open the other contact and tap **Qall**.
- Accept on the second phone.

## Production requirement

Public Google STUN is only enough for initial testing. Production calling needs authenticated TURN infrastructure because some cellular, corporate, and restrictive NAT networks cannot establish a direct peer-to-peer path.
