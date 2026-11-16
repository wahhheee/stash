/** 客户端公开状态不包含本机路径或凭据。 */
export interface StashStatus {
  readonly version: string;
  readonly hostVersion: string;
  readonly phase: 4;
  readonly memoryEnabled: true;
  readonly trace: 'off' | 'metadata' | 'content';
}

export interface StashReference {
  id: string;
  title: string;
  turn: number;
  from: number;
  to: number;
  end: string;
}
