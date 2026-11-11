import { TYPERT_REMOTE } from './remote.ts';

export const TYPERT = {
  package: '@wahhheee/dsh-stash',
  face: 'host' as const,
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: TYPERT_REMOTE.descriptors,
};
