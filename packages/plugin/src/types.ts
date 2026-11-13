/** 客户端公开状态不包含本机路径或凭据。 */
export interface StashStatus {
  readonly version: string;
  readonly hostVersion: string;
  readonly phase: 2;
  readonly memoryEnabled: true;
  readonly trace: 'off' | 'metadata' | 'content';
}
