export interface PositionLike {
  line: number;
  character: number;
}

export interface RangeLike {
  start: PositionLike;
  end: PositionLike;
}

export interface SourceLocation {
  uri: string;
  range: RangeLike;
}

export interface HandwaveDoc {
  fields: Record<string, string>;
  tags: string[];
  range: RangeLike;
  errors: ParseIssue[];
}

export interface LeanDeclaration {
  name: string;
  sourceName: string;
  /** The exact constant name serialized by Lean, including private-name mangling. */
  artifactName?: string;
  /** The Lean module recorded by the declaration's `.ilean` file. */
  artifactModule?: string;
  kind: string;
  isPrivate: boolean;
  statement: string;
  leanStatement: string;
  leanProof?: string;
  range: RangeLike;
  nameRange: RangeLike;
  doc?: HandwaveDoc;
  uri: string;
}

export interface LeanDeclarationCheckStatus {
  checked: boolean;
  ownChecked: boolean;
  dependencies: string[];
  failedDependencies: string[];
  reason: string;
  inconclusive?: boolean;
  blocked?: boolean;
  stale?: boolean;
  generation?: number;
}

export interface ArticleAnchor {
  id: string;
  title: string;
  range: RangeLike;
}

export interface ArticleLink {
  label: string;
  target: string;
  range: RangeLike;
  targetRange: RangeLike;
}

export interface ArticleInclude {
  target: string;
  range: RangeLike;
  targetRange: RangeLike;
}

export interface ArticleDocument {
  uri: string;
  anchors: ArticleAnchor[];
  links: ArticleLink[];
  includes: ArticleInclude[];
  errors: ParseIssue[];
}

export interface ParseIssue {
  message: string;
  range: RangeLike;
}

export type TargetKind = "lean" | "article" | "local" | "term" | "unknown";

export interface ParsedTarget {
  raw: string;
  kind: TargetKind;
  body: string;
  base: string;
  selector?: string;
  anchor?: string;
}

export interface ResolvedTarget {
  target: ParsedTarget;
  uri: string;
  range: RangeLike;
  title: string;
  preview: string;
  key: string;
}

export interface Backlink {
  fromUri: string;
  range: RangeLike;
  label: string;
  target: string;
}
