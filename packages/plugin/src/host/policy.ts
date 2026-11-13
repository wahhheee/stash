/** 阶段二采用固定开启策略，子代理只读。 */
export const memoryPolicy = {
  enabled: () => true,
  writable: (subagent: boolean) => !subagent,
};
