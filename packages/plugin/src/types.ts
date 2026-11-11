/** 客户端公开状态不包含本机路径或凭据。 */
export interface StashStatus {
  readonly version: string;
  readonly hostVersion: string;
  readonly phase: 1;
  readonly memoryEnabled: false;
  readonly trace: 'off' | 'metadata' | 'content';
}
