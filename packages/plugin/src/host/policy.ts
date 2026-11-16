/** 当前采用固定开启策略，子代理默认只读。 */
export const memoryPolicy = {
  enabled: () => true,
  writable: (subagent: boolean, subagentWrite = false) => !subagent || subagentWrite,
};
