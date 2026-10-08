export type TeamChannelOptions = {
  url: string;
  apikey: string;
  token: string;
  onPing?: () => void;
  onStatus?: (s: "connected" | "disconnected") => void;
  WebSocketImpl?: typeof WebSocket;
};
export function subscribeTeamChannel(opts: TeamChannelOptions): { close(): void; _drop(): void };
