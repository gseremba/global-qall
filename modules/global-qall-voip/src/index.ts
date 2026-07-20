import { EventSubscription, requireOptionalNativeModule } from 'expo-modules-core';

export type VoipPushPayload = Record<string, unknown>;

type TokenEvent = { token: string };
type PushEvent = { payload: VoipPushPayload };

type GlobalQallVoipNativeModule = {
  getVoipToken(): string | null;
  getInitialVoipPush(): VoipPushPayload | null;
  clearInitialVoipPush(): void;
  addListener(eventName: 'onVoipToken', listener: (event: TokenEvent) => void): EventSubscription;
  addListener(eventName: 'onVoipPush', listener: (event: PushEvent) => void): EventSubscription;
};

const NativeModule = requireOptionalNativeModule<GlobalQallVoipNativeModule>('GlobalQallVoip');

export function getVoipToken(): string | null {
  return NativeModule?.getVoipToken() ?? null;
}

export function getInitialVoipPush(): VoipPushPayload | null {
  return NativeModule?.getInitialVoipPush() ?? null;
}

export function clearInitialVoipPush(): void {
  NativeModule?.clearInitialVoipPush();
}

export function addVoipTokenListener(listener: (token: string) => void): EventSubscription | null {
  return NativeModule?.addListener('onVoipToken', ({ token }) => listener(token)) ?? null;
}

export function addVoipPushListener(listener: (payload: VoipPushPayload) => void): EventSubscription | null {
  return NativeModule?.addListener('onVoipPush', ({ payload }) => listener(payload)) ?? null;
}
