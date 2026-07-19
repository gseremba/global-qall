declare module "react-native-incall-manager" {
  type StartOptions = {
    media?: "audio" | "video";
    auto?: boolean;
    ringback?: string;
  };

  const InCallManager: {
    start(options?: StartOptions): void;
    stop(options?: { busytone?: string }): void;
    setForceSpeakerphoneOn(enabled: boolean): void;
    setSpeakerphoneOn(enabled: boolean): void;
    setMicrophoneMute(enabled: boolean): void;
    setKeepScreenOn(enabled: boolean): void;
  };

  export default InCallManager;
}
