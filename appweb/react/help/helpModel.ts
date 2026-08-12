export const HELP_TOPIC_IDS = [
  'fundamentals',
  'compute',
  'conditions',
  'run',
  'soup',
  'order',
  'state',
  'sampler',
  'runs',
  'assumptions',
  'references',
] as const;

export type HelpTopicId = (typeof HELP_TOPIC_IDS)[number];

export interface HelpWindowBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const HELP_TOPIC_ID_SET: ReadonlySet<string> = new Set(HELP_TOPIC_IDS);

export function isHelpTopicId(topic: string): topic is HelpTopicId {
  return HELP_TOPIC_ID_SET.has(topic);
}
