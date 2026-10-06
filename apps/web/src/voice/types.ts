export type SfuVoiceSessionOptions = {
  token: string;
  roomId: string;
  selfUserId: string;
  remoteAudioHost: HTMLElement | null;
  remoteVideoHost: HTMLElement | null;
  onState: (patch: unknown) => void;
  sfuUrl?: string;
  sfuToken?: string;
  useVoiceGateway?: boolean;
  iceServers?: unknown;
  tokenTtlSeconds?: number;
  refreshSfuCredentials?: () => Promise<{
    sfuUrl?: string;
    sfuToken?: string;
    tokenTtlSeconds?: number;
    gateway?: boolean;
  }>;
  onCloseScreenViewForPeer?: (uid: string) => void;
  onRefreshScreenViewForPeer?: (uid: string) => void;
  onDetachScreenViewForPeer?: (uid: string) => void;
  onScreenAudioError?: (msg: string) => void;
  onForceLeave?: () => void;
};
