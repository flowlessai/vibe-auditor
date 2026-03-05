export type DeviceLoginCreateResponse = {
  authorizationId: string;
  code: string;
  expiresIn: number;
  verificationUrl: string;
};

export type DeviceLoginApprovedResponse = {
  status: "approved";
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  userId: string;
};

export type DeviceLoginPendingResponse = { status: "pending" };
export type DeviceLoginExpiredResponse = { status: "expired" };
export type CreateTaskResponse = { taskId: string };

export type TaskStatus =
  | "INDEXING"
  | "GENERATING_ARTIFACTS"
  | "SYSTEM_CHECK"
  | "APPLYING_DIFFS"
  | "DONE"
  | "FAILED";

export type Artifact = {
  file?: string;
  path?: string;
  filePath?: string;
  filename?: string;
  findings?: string[];
  issues?: string[];
  risks?: string[];
  suggestions?: string[];
  recommendations?: string[];
  summary?: string;
  description?: string;
  severity?: string;
  [key: string]: unknown;
};

export type RawDiff = {
  patch?: string;
  diff?: string;
  path?: string;
  filePath?: string;
  filename?: string;
  file?: string;
  newContent?: string;
  content?: string;
  after?: string;
  [key: string]: unknown;
};

export type TaskStatusResponse = {
  id: string;
  status: TaskStatus;
  paused: boolean;
  artifacts: Artifact[];
  diffs: RawDiff[];
  analysis: unknown;
  createdAt: number;
  updatedAt: number;
};

export type ExtractedDiff = {
  path: string;
  patch?: string;
  newContent?: string;
};

export type RequestBody = FormData | string | Uint8Array | null;
