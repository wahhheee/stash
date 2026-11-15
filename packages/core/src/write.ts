/** 操作使用的正文参数；工具说明和运行时校验共用此表。 */
export const WRITE_OPERATIONS = {
  create: ['content'],
  append: ['content'],
  edit: ['old', 'new'],
  replace: ['content'],
  archive: [],
  delete: [],
} as const;

export type WriteOperation = keyof typeof WRITE_OPERATIONS;
export type WriteField = 'path' | 'op' | 'content' | 'old' | 'new';

export type WriteInput = {
  [Op in WriteOperation]: { path: string; op: Op } & Record<
    (typeof WRITE_OPERATIONS)[Op][number],
    string
  >;
}[WriteOperation];
