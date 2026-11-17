export interface RuleEditState {
  /** 完整顺序；未出现的下标按原始顺序补在后面。 */
  order: number[];
  edits: Record<number, { enabled?: boolean; target?: string }>;
}
