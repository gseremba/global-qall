// Sprint 12.2C – compile/import smoke example.
// This is intentionally NOT wired into navigation yet.

import {
  GroupWebRTCClient,
} from "./groupWebRTC";

// Example construction:
//
// const client = new GroupWebRTCClient({
//   groupCallId,
//   userId,
//   callType: "voice",
//   events: {
//     onRemoteStream(remote) {
//       console.log(
//         "Remote stream",
//         remote.remoteUserId,
//         remote.peerSessionId
//       );
//     },
//     onPeerState(state) {
//       console.log(
//         "Peer state",
//         state.peerSessionId,
//         state.connectionState,
//         state.iceConnectionState,
//         state.iceGeneration
//       );
//     },
//     onError(error, context) {
//       console.warn(
//         "Group WebRTC error",
//         context.operation,
//         error.message
//       );
//     },
//   },
// });
//
// await client.start();
//
// Later:
// await client.restartIce(peerSessionId);
//
// Cleanup:
// await client.stop();

export function groupWebRTCSmokeTypeCheck() {
  return GroupWebRTCClient;
}
